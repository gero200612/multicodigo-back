#!/usr/bin/env python3
"""mc-acceso: cada entrada por SSH se autoriza con un toque en Telegram.

Corre SOLO en el VPS: un bot de Telegram lo puede escuchar un programa a la
vez. La Toshiba le pide la autorizacion por la VPN (Tailscale) y espera la
respuesta en el mismo pedido.

Aprobadores: el pedido le llega siempre a ACCESO_TELEGRAM_USUARIO (Gero) y,
ademas, a quien figure para ese origen en APROBADORES (una linea por persona:
"<ip> <chat_id>"). Cualquiera de los dos puede decidir; al resolverse se
actualiza y se borra en todos los chats. El archivo se lee en cada pedido:
agregar a alguien no pide reiniciar el servicio.

Flujo:
  sshd (clave SSH OK) -> PAM -> mc-acceso-pam -> POST /pedir -> este proceso
  -> mensaje a Telegram con [Autorizar] [Rechazar] -> el toque vuelve aca
  -> se contesta el POST -> PAM deja pasar o corta.

Sin respuesta en 90 s, se corta. Solo cuentan los toques del usuario de
Telegram que recibieron ese pedido. Solo stdlib.

Archivos (0600, root):
  /root/telegram-acceso.token  token del bot
  /root/mc-acceso.secret       clave que comparten el VPS y la Toshiba
  /root/mc-acceso.aprobadores  "<ip> <chat_id>" por linea (# comenta)
"""
import hmac
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = open('/root/telegram-acceso.token').read().strip()
SECRETO = open('/root/mc-acceso.secret').read().strip()
USUARIO = int(os.environ.get('ACCESO_TELEGRAM_USUARIO', '5843375718'))
ESCUCHA = [h for h in os.environ.get('ACCESO_ESCUCHA', '127.0.0.1,100.113.60.114').split(',') if h]
PUERTO = int(os.environ.get('ACCESO_PUERTO', '8092'))
ESPERA = int(os.environ.get('ACCESO_ESPERA', '90'))
# Nombres para que el mensaje diga de donde viene, no solo una IP.
NOMBRES = {
    '100.122.93.47': 'Toshiba',
    '100.96.251.50': 'laptop (salchinator)',
    '100.113.60.114': 'el propio VPS',
    '127.0.0.1': 'el propio servidor',
    '100.107.200.15': 'Pedro',
}
APROBADORES = '/root/mc-acceso.aprobadores'
MAX_PENDIENTES = 5
# Un Autorizar vale RECORDAR segundos para la MISMA clave, el mismo usuario,
# el mismo servidor y el mismo origen. Cualquier otra combinacion pregunta.
RECORDAR = int(os.environ.get('ACCESO_RECORDAR', '3600'))
recordados = {}  # (servidor, usuario, desde, clave) -> vence (epoch)

API = f'https://api.telegram.org/bot{TOKEN}'
pendientes = {}  # id -> {'evento', 'ok': bool|None, 'msgs': {chat: msg}, 'chats', 'quien'}
lock = threading.Lock()


def aprobadores(desde):
    """Gero siempre primero; despues los que tengan ese origen en el archivo."""
    chats = [USUARIO]
    try:
        for linea in open(APROBADORES):
            partes = linea.split('#')[0].split()
            if len(partes) == 2 and partes[0] == desde and int(partes[1]) not in chats:
                chats.append(int(partes[1]))
    except (OSError, ValueError) as e:
        print('aprobadores:', type(e).__name__, flush=True)
    return chats


def tg(metodo, **datos):
    # getUpdates espera hasta 50 s a proposito; todo lo demas es corto, para
    # que una llamada colgada no frene el servicio.
    espera = 70 if metodo == 'getUpdates' else 15
    cuerpo = json.dumps(datos).encode()
    req = urllib.request.Request(f'{API}/{metodo}', data=cuerpo, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=espera) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Telegram contesta 400 con {"ok":false,"description":...}: sirve leerlo.
        try:
            return json.loads(e.read())
        except Exception:
            return {'ok': False}
    except Exception as e:  # nunca dejar el token en un log
        print('telegram:', type(e).__name__, flush=True)
        return {'ok': False}


def escuchar_telegram():
    offset = 0
    while True:
        r = tg('getUpdates', offset=offset, timeout=50, allowed_updates=['callback_query', 'message'])
        if not r.get('ok'):
            time.sleep(5)
            continue
        for u in r.get('result', []):
            offset = u['update_id'] + 1
            m = u.get('message')
            if m:
                # Para sumar a alguien: le escribe al bot y su chat_id queda en
                # el journal (y se lo contesta). No da ningun permiso por si solo.
                de = m.get('from', {})
                print(f"mensaje de {de.get('id')} ({de.get('first_name', '')} @{de.get('username', '')})", flush=True)
                tg('sendMessage', chat_id=m['chat']['id'], text=f"Tu chat_id es {m['chat']['id']}.")
                continue
            q = u.get('callback_query')
            if not q:
                continue
            quien = q.get('from', {}).get('id')
            accion, _, pid = (q.get('data') or '').partition(':')
            print(f"toque: {accion} {pid} de {quien}", flush=True)
            with lock:
                p = pendientes.get(pid)
            # Solo vale el toque de alguien a quien le llego ESE pedido.
            if quien not in (p['chats'] if p else [USUARIO]):
                tg('answerCallbackQuery', callback_query_id=q['id'], text='No autorizado')
                continue
            if not p or p['ok'] is not None:
                tg('answerCallbackQuery', callback_query_id=q['id'], text='Ese pedido ya venció')
                continue
            p['ok'] = accion == 'si'
            p['quien'] = q.get('from', {}).get('first_name') or str(quien)
            p['evento'].set()
            tg('answerCallbackQuery', callback_query_id=q['id'], text='Autorizado' if p['ok'] else 'Rechazado')


def pedir(servidor, usuario, desde, clave=''):
    llave = (servidor, usuario, desde, clave)
    if clave:
        with lock:
            vence = recordados.get(llave, 0)
        if vence > time.time():
            print(f"recordado | {servidor} usuario={usuario} desde={desde} (vence en {int(vence - time.time())} s)", flush=True)
            return True
    with lock:
        if sum(1 for p in pendientes.values() if p['ok'] is None) >= MAX_PENDIENTES:
            return False
        pid = f"{servidor.lower()}-{secrets.token_hex(4)}"
        p = {'evento': threading.Event(), 'ok': None, 'msgs': {}, 'chats': aprobadores(desde), 'quien': ''}
        pendientes[pid] = p
    origen = NOMBRES.get(desde, desde or 'desconocido')
    texto = f"🔐 <b>{usuario}</b> quiere entrar a <b>{servidor}</b>\ndesde {origen} ({desde})\n\nVence en {ESPERA} s."
    for chat in p['chats']:
        r = tg('sendMessage', chat_id=chat, text=texto, parse_mode='HTML', reply_markup={'inline_keyboard': [[
            {'text': '✅ Autorizar', 'callback_data': f'si:{pid}'},
            {'text': '⛔ Rechazar', 'callback_data': f'no:{pid}'},
        ]]})
        if r.get('ok'):
            p['msgs'][chat] = r['result']['message_id']
        else:
            print(f"no llego a {chat}: {r.get('description', '')}", flush=True)
    if not p['msgs']:
        with lock:
            pendientes.pop(pid, None)
        return False
    p['evento'].wait(ESPERA)
    ok = p['ok'] is True
    final = '✅ Autorizado' if ok else ('⛔ Rechazado' if p['ok'] is False else '⌛ Venció sin respuesta')
    if p['quien']:
        final += f" por {p['quien']}"
    print(f"{final} | {pid} | usuario={usuario} desde={desde}", flush=True)
    p['ok'] = ok
    if ok and clave:
        with lock:
            recordados[llave] = time.time() + RECORDAR
    # El resultado se ve unos segundos y el mensaje se borra en todos los
    # chats: quedan limpios, con el mensaje fijo arriba. El registro queda en
    # el journal.
    for chat, mid in p['msgs'].items():
        tg('editMessageText', chat_id=chat, message_id=mid, parse_mode='HTML',
           reply_markup={'inline_keyboard': []},
           text=f"{texto.split(chr(10) + chr(10))[0]}\n\n{final}")
        threading.Timer(8, lambda c=chat, m=mid: tg('deleteMessage', chat_id=c, message_id=m)).start()
    with lock:
        pendientes.pop(pid, None)
    return ok


FIJO = '/var/lib/mc-acceso/fijo'
TEXTO_FIJO = ('🔐 <b>Acceso a los servidores</b>\n\n'
              'Cada vez que alguien entra por SSH al VPS o a la Toshiba (con su clave), '
              'llega acá un pedido con <b>Autorizar</b> / <b>Rechazar</b>. Sin respuesta en '
              f'{ESPERA} s, no entra. Un Autorizar vale {RECORDAR // 60} min para la misma clave desde '
              'la misma máquina. Los pedidos se borran solos al resolverse.')


def asegurar_fijo():
    """El mensaje anclado del chat. Se manda una sola vez (se guarda su id)."""
    os.makedirs(os.path.dirname(FIJO), exist_ok=True)
    if os.path.exists(FIJO):
        mid = int(open(FIJO).read().strip() or 0)
        if mid:
            r = tg('editMessageText', chat_id=USUARIO, message_id=mid, text=TEXTO_FIJO, parse_mode='HTML')
            # "message is not modified" tambien quiere decir que sigue ahi.
            if r.get('ok') or 'not modified' in str(r.get('description', '')):
                return
    r = tg('sendMessage', chat_id=USUARIO, text=TEXTO_FIJO, parse_mode='HTML', disable_notification=True)
    if r.get('ok'):
        mid = r['result']['message_id']
        tg('pinChatMessage', chat_id=USUARIO, message_id=mid, disable_notification=True)
        open(FIJO, 'w').write(str(mid))


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/pedir' or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + SECRETO):
            self.send_response(404)
            self.end_headers()
            return
        try:
            largo = min(int(self.headers.get('Content-Length', '0')), 2000)
            d = json.loads(self.rfile.read(largo) or b'{}')
            servidor = str(d.get('servidor', '?'))[:30]
            usuario = str(d.get('usuario', '?'))[:40]
            desde = str(d.get('desde', ''))[:60]
            clave = str(d.get('clave', ''))[:64]
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        # Lo que viene en el pedido es texto para el mensaje, escapado.
        esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        ok = pedir(esc(servidor), esc(usuario), esc(desde), clave)
        cuerpo = json.dumps({'ok': ok}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    # Primero lo que deja entrar (pedidos y botones); el mensaje fijo, aparte:
    # si Telegram tarda, no puede dejar al SSH sin quien le conteste.
    threading.Thread(target=escuchar_telegram, daemon=True).start()
    threading.Thread(target=asegurar_fijo, daemon=True).start()
    servidores = []
    for host in ESCUCHA:
        s = ThreadingHTTPServer((host, PUERTO), H)
        threading.Thread(target=s.serve_forever, daemon=True).start()
        servidores.append(s)
    print('mc-acceso escuchando en', ESCUCHA, PUERTO, flush=True)
    threading.Event().wait()
