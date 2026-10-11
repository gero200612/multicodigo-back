#!/usr/bin/env python3
"""Despliega sincro-wa (el bot general de WhatsApp) en el Coolify del VPS.

Se corre EN el VPS, como root. Es idempotente: lo que ya existe (proyecto, base,
app, negocio) lo reusa, guiándose por /root/env/sincro-wa.estado.json.

    python3 sincro-wa-desplegar.py app        # proyecto + base + app + variables + deploy
    python3 sincro-wa-desplegar.py negocio    # da de alta el negocio Sincro (solo leads) y su número
    python3 sincro-wa-desplegar.py webhook    # apunta el webhook de Meta al bot
    python3 sincro-wa-desplegar.py homero     # imprime las 3 líneas para /root/mc.env de la Toshiba (con secretos)

Nunca imprime un secreto, salvo `homero`, que está hecho para mandarse por un
pipe directo a la Toshiba (ssh vps ... | ssh toshiba ...), sin pasar por la pantalla.

Los secretos viven en /root/env/sincro-wa.env (0600):
- META_APP_SECRET: el de la app "Homero Sincro" (lo carga Gero, no se puede sacar por API).
- META_TOKEN: el token del system user (se copia de /root/mc.env de la Toshiba).
- El resto lo genera este script la primera vez.
"""
import base64
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

COOLIFY = 'http://localhost:8000/api/v1'
SERVIDOR = '9ej6of76shhzldaokrsxpe1l'
REPO = 'https://github.com/gero200612/multicodigo-back'
DOMINIO = 'https://wa.apps.punchi.dev'
# Publicado en el host: el firewall de ens3 lo tira, así que solo llega por la VPN.
PUERTO_PRIVADO_HOST = 8097
PRIVADO = f'http://127.0.0.1:{PUERTO_PRIVADO_HOST}'
SECRETOS = '/root/env/sincro-wa.env'
ESTADO = '/root/env/sincro-wa.estado.json'
VERSION_META = 'v23.0'
APP_META = '1410095257330902'
# El número de Sincro (spec 2026-10-10).
PHONE_NUMBER_ID = '1405287685995571'
WABA_ID = '1786410379074282'
TOPE_SINCRO_ARS = 20000
CAMPOS_WEBHOOK = 'messages,message_template_status_update,template_category_update,phone_number_quality_update,account_update'


def tapar(texto):
    texto = re.sub(r'EAA[A-Za-z0-9_-]{10,}', 'EAA…', str(texto))
    return re.sub(r'swa_\d+_[A-Za-z0-9_-]+', 'swa_…', texto)


def leer_env(ruta):
    vals = {}
    if os.path.exists(ruta):
        for linea in open(ruta):
            linea = linea.strip()
            if linea and not linea.startswith('#') and '=' in linea:
                k, v = linea.split('=', 1)
                vals[k.strip()] = v.strip()
    return vals


def escribir_env(ruta, vals):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    fd = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        for k, v in vals.items():
            f.write(f'{k}={v}\n')


def leer_estado():
    return json.load(open(ESTADO)) if os.path.exists(ESTADO) else {}


def guardar_estado(e):
    fd = os.open(ESTADO, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(e, f, indent=2)


def http(metodo, url, cuerpo=None, token=None, form=False):
    datos = None
    headers = {}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if cuerpo is not None:
        if form:
            datos = urllib.parse.urlencode(cuerpo).encode()
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        else:
            datos = json.dumps(cuerpo).encode()
            headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=datos, method=metodo, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            texto = r.read().decode()
            return r.status, (json.loads(texto) if texto else {})
    except urllib.error.HTTPError as e:
        texto = e.read().decode()
        try:
            return e.code, json.loads(texto)
        except ValueError:
            return e.code, {'error': texto[:300]}


def coolify(metodo, ruta, cuerpo=None):
    token = open('/root/coolify.token').read().strip()
    status, j = http(metodo, f'{COOLIFY}{ruta}', cuerpo, token)
    if status >= 300:
        sys.exit(f'Coolify {metodo} {ruta} -> {status}: {tapar(json.dumps(j))[:400]}')
    return j


def secretos():
    s = leer_env(SECRETOS)
    cambio = False
    for k, gen in [
        ('SINCRO_WA_ADMIN_KEY', lambda: secrets.token_urlsafe(36)),
        ('SINCRO_WA_CIFRADO', lambda: base64.b64encode(secrets.token_bytes(32)).decode()),
        ('META_VERIFY_TOKEN', lambda: secrets.token_urlsafe(24)),
        ('SINCRO_WA_DB_PASSWORD', lambda: secrets.token_hex(24)),
    ]:
        if not s.get(k):
            s[k] = gen()
            cambio = True
    if cambio:
        escribir_env(SECRETOS, s)
    return s


def app():
    s = secretos()
    faltan = [k for k in ('META_APP_SECRET', 'META_TOKEN') if not s.get(k)]
    if faltan:
        sys.exit(f'Faltan en {SECRETOS}: {", ".join(faltan)}. Cargalos y volvé a correr.')
    e = leer_estado()

    if not e.get('proyecto'):
        e['proyecto'] = coolify('POST', '/projects', {'name': 'sincro-wa', 'description': 'Bot general de WhatsApp'})['uuid']
        guardar_estado(e)
        print('proyecto creado')

    if not e.get('base'):
        e['base'] = coolify('POST', '/databases/postgresql', {
            'server_uuid': SERVIDOR, 'project_uuid': e['proyecto'], 'environment_name': 'production',
            'name': 'sincro-wa-base', 'postgres_user': 'sincrowa', 'postgres_password': s['SINCRO_WA_DB_PASSWORD'],
            'postgres_db': 'sincrowa', 'is_public': False, 'instant_deploy': True,
        })['uuid']
        guardar_estado(e)
        print('base creada')
    # Con builds en cola Coolify no la levanta sola (ver bridge/src/vps.ts).
    coolify('GET', f'/databases/{e["base"]}/start')
    database_url = f'postgres://sincrowa:{s["SINCRO_WA_DB_PASSWORD"]}@{e["base"]}:5432/sincrowa'

    if not e.get('app'):
        e['app'] = coolify('POST', '/applications/public', {
            'project_uuid': e['proyecto'], 'server_uuid': SERVIDOR, 'environment_name': 'production',
            'git_repository': REPO, 'git_branch': 'main', 'build_pack': 'dockerfile',
            'base_directory': '/sincro-wa', 'dockerfile_location': '/Dockerfile',
            'ports_exposes': '3000', 'ports_mappings': f'{PUERTO_PRIVADO_HOST}:3001',
            'domains': DOMINIO, 'name': 'sincro-wa', 'instant_deploy': False,
        })['uuid']
        guardar_estado(e)
        # La imagen no trae curl: con el healthcheck prendido Coolify la marca enferma.
        coolify('PATCH', f'/applications/{e["app"]}', {'health_check_enabled': False})
        print('app creada')

    variables = {
        'DATABASE_URL': database_url,
        'META_APP_SECRET': s['META_APP_SECRET'],
        'META_TOKEN': s['META_TOKEN'],
        'META_VERIFY_TOKEN': s['META_VERIFY_TOKEN'],
        'META_API_VERSION': VERSION_META,
        'SINCRO_WA_ADMIN_KEY': s['SINCRO_WA_ADMIN_KEY'],
        'SINCRO_WA_CIFRADO': s['SINCRO_WA_CIFRADO'],
        'PUERTO_PUBLICO': '3000',
        'PUERTO_PRIVADO': '3001',
    }
    coolify('PATCH', f'/applications/{e["app"]}/envs/bulk', {
        'data': [{'key': k, 'value': v, 'is_preview': False, 'is_literal': True} for k, v in variables.items()],
    })
    print('variables cargadas')

    d = coolify('POST', f'/deploy?uuid={e["app"]}')
    dep = (d.get('deployments') or [{}])[0].get('deployment_uuid')
    print('deploy encolado')
    if not dep:
        return
    for _ in range(120):
        time.sleep(10)
        j = coolify('GET', f'/deployments/{dep}')
        if j.get('status') in ('finished', 'failed', 'cancelled-by-user'):
            print('deploy:', j['status'])
            if j['status'] != 'finished':
                try:
                    lineas = [l.get('output', '') for l in json.loads(j.get('logs') or '[]') if not l.get('hidden')]
                    print(tapar('\n'.join(lineas[-30:])))
                except ValueError:
                    pass
                sys.exit(1)
            break
    else:
        print('el deploy sigue corriendo; mirá el panel de Coolify')
        return
    for _ in range(18):
        try:
            with urllib.request.urlopen(f'{DOMINIO}/salud', timeout=10) as r:
                print('salud pública:', r.status)
                return
        except Exception as err:  # el certificado puede tardar un minuto
            ultimo = err
            time.sleep(10)
    print('la salud pública todavía no contesta:', tapar(ultimo))


def admin(metodo, ruta, cuerpo=None):
    s = secretos()
    return http(metodo, f'{PRIVADO}{ruta}', cuerpo, s['SINCRO_WA_ADMIN_KEY'])


def negocio():
    e = leer_estado()
    s = leer_env(SECRETOS)
    if not e.get('negocio_sincro'):
        status, j = admin('POST', '/admin/negocios', {
            'nombre': 'Sincro', 'app': 'homero', 'capacidades': ['leads'],
            'tope_mensual_ars': TOPE_SINCRO_ARS, 'quien': 'gero',
        })
        if status != 201:
            sys.exit(f'no pude crear el negocio: {status} {tapar(json.dumps(j))[:300]}')
        e['negocio_sincro'] = j['negocio']['id']
        s['SINCRO_WA_KEY_HOMERO'] = j['clave']
        escribir_env(SECRETOS, s)
        guardar_estado(e)
        print('negocio Sincro creado (solo leads)')
    if not e.get('numero_sincro'):
        status, j = admin('POST', '/admin/numeros', {
            'negocio_id': e['negocio_sincro'], 'phone_number_id': PHONE_NUMBER_ID, 'waba_id': WABA_ID, 'quien': 'gero',
        })
        if status >= 300:
            sys.exit(f'no pude cargar el número: {status} {tapar(json.dumps(j))[:300]}')
        e['numero_sincro'] = PHONE_NUMBER_ID
        guardar_estado(e)
        print('número de Sincro cargado')
    print('listo')


def webhook():
    s = leer_env(SECRETOS)
    # La WABA ya tiene la app suscripta; repetirlo no cambia nada y lo asegura.
    status, j = http('POST', f'https://graph.facebook.com/{VERSION_META}/{WABA_ID}/subscribed_apps', {}, s['META_TOKEN'])
    print('WABA suscripta:', status, tapar(json.dumps(j))[:200])
    status, j = http('POST', f'https://graph.facebook.com/{VERSION_META}/{APP_META}/subscriptions', {
        'object': 'whatsapp_business_account',
        'callback_url': f'{DOMINIO}/webhook',
        'verify_token': s['META_VERIFY_TOKEN'],
        'fields': CAMPOS_WEBHOOK,
        'access_token': f'{APP_META}|{s["META_APP_SECRET"]}',
    }, form=True)
    print('webhook de la app:', status, tapar(json.dumps(j))[:300])
    if status >= 300:
        sys.exit(1)


def homero():
    s = leer_env(SECRETOS)
    if not s.get('SINCRO_WA_KEY_HOMERO'):
        sys.exit('primero: negocio')
    if sys.stdout.isatty():
        sys.exit('esto imprime secretos: mandalo por un pipe a la Toshiba, no a la pantalla')
    print('SINCRO_WA_URL=http://100.113.60.114:8097')
    print(f'SINCRO_WA_KEY={s["SINCRO_WA_KEY_HOMERO"]}')
    print(f'SINCRO_WA_ADMIN_KEY={s["SINCRO_WA_ADMIN_KEY"]}')


if __name__ == '__main__':
    pasos = {'app': app, 'negocio': negocio, 'webhook': webhook, 'homero': homero}
    if len(sys.argv) != 2 or sys.argv[1] not in pasos:
        sys.exit(__doc__)
    pasos[sys.argv[1]]()
