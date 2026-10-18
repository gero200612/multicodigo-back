#!/usr/bin/env python3
"""Auto-deploy de las apps del VPS que Coolify no despliega solas.

Las apps conectadas por GitHub App deberian desplegarse con el webhook de
hooks.apps.punchi.dev, pero no siempre llega (2026-10-18: las de la org
Sincro-arg, como Efaysto, no se desplegaban solas). Las de fuente PUBLICA
(sincro-wa, sincro-web) nunca reciben aviso. Esto vigila TODAS: las publicas
con `git ls-remote` anonimo y las de GitHub App con un token de instalacion que
genera el mismo Coolify (nunca se escribe en disco ni en el log). Si el webhook
ya desplego ese commit, o hay un deploy en cola o andando, no despliega de nuevo.

Cada vuelta (timer de systemd, cada 2 min):
- lista las apps de Coolify y se queda con las de fuente publica;
- mira el ultimo commit de su rama con `git ls-remote` (no gasta cuota de la
  API de GitHub);
- si cambio, y la app vive en una carpeta del repo (base_directory, como
  /sincro-wa dentro de multicodigo-back), solo la despliega si el cambio toco
  esa carpeta;
- la despliega por la API de Coolify y anota el commit.

La primera vez que ve una app anota el commit sin desplegar, salvo que su
ultimo deploy en Coolify sea de otro commit (entonces despliega: quedo atras).

    python3 mc-autodeploy.py listar     # que apps hay y cuales vigila
    python3 mc-autodeploy.py vuelta     # una pasada (lo que corre el timer)
    python3 mc-autodeploy.py instalar   # copia el script, crea y prende el timer

Se corre EN el VPS, como root. Token de Coolify en /root/coolify.token.
"""
import json
import os
import subprocess
import sys
import urllib.request

COOLIFY = 'http://localhost:8000/api/v1'
TOKEN = '/root/coolify.token'
ESTADO = '/root/env/mc-autodeploy.json'
DESTINO = '/usr/local/sbin/mc-autodeploy.py'


# ---------------------------------------------------------------- reglas puras

def es_de_fuente_publica(app):
    """Coolify guarda la fuente publica como la GitHub App 0 ("Public GitHub")."""
    if not app.get('git_repository'):
        return False
    return app.get('source_id') in (0, '0', None)


def vigilable(app):
    """Toda app con repo: publica (source 0) o de una GitHub App de Coolify."""
    return bool(app.get('git_repository'))


def source_de_app(app):
    """El id de la GitHub App de Coolify, o None si es publica."""
    if es_de_fuente_publica(app):
        return None
    try:
        return int(app.get('source_id'))
    except (TypeError, ValueError):
        return None


def tapar_token(texto, token):
    return texto.replace(token, '***') if token else texto


def repo_de(app):
    """'gero200612/multicodigo-back' desde la URL o el owner/repo que guarda Coolify."""
    r = str(app.get('git_repository') or '').strip()
    for prefijo in ('https://github.com/', 'http://github.com/', 'git@github.com:'):
        if r.startswith(prefijo):
            r = r[len(prefijo):]
    return r.removesuffix('.git').strip('/')


def carpeta_de(app):
    """'sincro-wa/' para base_directory '/sincro-wa'; '' si la app es el repo entero."""
    b = str(app.get('base_directory') or '/').strip('/')
    return f'{b}/' if b else ''


def toca_la_carpeta(archivos, carpeta):
    """Si alguno de los archivos cambiados cae en la carpeta de la app."""
    if not carpeta:
        return True
    return any(a.startswith(carpeta) for a in archivos)


def sha_de_ls_remote(salida, rama):
    for linea in salida.splitlines():
        partes = linea.split()
        if len(partes) == 2 and partes[1] == f'refs/heads/{rama}':
            return partes[0]
    return None


# ------------------------------------------------------------------ entrada/salida

def http(metodo, url, cuerpo=None, token=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(url, data=datos, method=metodo)
    req.add_header('Accept', 'application/json')
    if datos is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            texto = r.read().decode() or 'null'
            return r.status, json.loads(texto)
    except urllib.error.HTTPError as e:
        texto = e.read().decode(errors='replace')
        try:
            return e.code, json.loads(texto)
        except ValueError:
            return e.code, {'error': texto[:300]}


def coolify(metodo, ruta, cuerpo=None):
    status, j = http(metodo, f'{COOLIFY}{ruta}', cuerpo, open(TOKEN).read().strip())
    if status >= 300:
        raise RuntimeError(f'Coolify {metodo} {ruta} -> {status}: {json.dumps(j)[:300]}')
    return j


def token_de_github_app(source_id):
    """Token de instalacion de la GitHub App (dura 1 h). Lo genera Coolify con su clave privada."""
    php = rf"echo generateGithubInstallationToken(App\Models\GithubApp::findOrFail({int(source_id)}));"
    r = subprocess.run(['docker', 'exec', 'coolify', 'php', 'artisan', 'tinker', f'--execute={php}'],
                       capture_output=True, text=True, timeout=90)
    for linea in reversed(r.stdout.splitlines()):
        linea = linea.strip()
        if linea.startswith(('ghs_', 'ghu_', 'github_pat_')):
            return linea
    raise RuntimeError(f'no pude generar el token de la GitHub App {source_id} (salida {r.returncode})')


def ultimo_commit(repo, rama, token=None):
    url = f'https://x-access-token:{token}@github.com/{repo}.git' if token else f'https://github.com/{repo}.git'
    r = subprocess.run(['git', 'ls-remote', url, f'refs/heads/{rama}'],
                       capture_output=True, text=True, timeout=60,
                       env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if r.returncode != 0:
        raise RuntimeError(f'git ls-remote {repo}: {tapar_token(r.stderr.strip(), token)[:200]}')
    return sha_de_ls_remote(r.stdout, rama)


def archivos_cambiados(repo, desde, hasta, token=None):
    """Lo que cambio entre dos commits (API de GitHub). None si no se pudo saber."""
    status, j = http_github(f'https://api.github.com/repos/{repo}/compare/{desde}...{hasta}', token)
    if status != 200 or not isinstance(j, dict):
        return None
    return [f.get('filename', '') for f in j.get('files') or []]


def http_github(url, token=None):
    req = urllib.request.Request(url, method='GET')
    req.add_header('Accept', 'application/vnd.github+json')
    if token:
        req.add_header('Authorization', f'token {token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or 'null')
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return 0, None


def deploys_recientes(uuid):
    try:
        deps = coolify('GET', f'/deployments/applications/{uuid}?skip=0&take=5')
    except RuntimeError:
        return []
    return (deps.get('deployments') if isinstance(deps, dict) else deps) or []


def ya_desplegado_o_en_curso(uuid, sha):
    """El webhook ya lo hizo, o hay un deploy en cola/andando: no se pide otro."""
    for d in deploys_recientes(uuid):
        if d.get('status') in ('queued', 'in_progress'):
            return True
        if d.get('commit') == sha and d.get('status') == 'finished':
            return True
    return False


def ultimo_deploy(uuid):
    """El commit del ultimo deploy terminado en Coolify, si lo dice."""
    try:
        deps = coolify('GET', f'/deployments/applications/{uuid}?skip=0&take=5')
    except RuntimeError:
        return None
    lista = deps.get('deployments') if isinstance(deps, dict) else deps
    for d in lista or []:
        if d.get('status') == 'finished' and d.get('commit') and d.get('commit') != 'HEAD':
            return d['commit']
    return None


def leer_estado():
    return json.load(open(ESTADO)) if os.path.exists(ESTADO) else {}


def guardar_estado(e):
    os.makedirs(os.path.dirname(ESTADO), exist_ok=True)
    fd = os.open(ESTADO, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(e, f, indent=2)


# ---------------------------------------------------------------------- pasos

def listar():
    for a in coolify('GET', '/applications'):
        vigila = ('VIGILA' if es_de_fuente_publica(a) else 'VIGILA+app') if vigilable(a) else '-'
        print(f"{vigila:8} {a.get('name', '?'):24} {a.get('uuid')}  {repo_de(a)}@{a.get('git_branch')}  "
              f"carpeta={carpeta_de(a) or '(todo)'}  source_id={a.get('source_id')}")


def vuelta():
    estado = leer_estado()
    tokens = {}  # un token por GitHub App y por vuelta
    for a in coolify('GET', '/applications'):
        if not vigilable(a):
            continue
        uuid, nombre, rama = a['uuid'], a.get('name', a['uuid']), a.get('git_branch') or 'main'
        repo = repo_de(a)
        token = None
        source = source_de_app(a)
        try:
            if source is not None:
                if source not in tokens:
                    tokens[source] = token_de_github_app(source)
                token = tokens[source]
            sha = ultimo_commit(repo, rama, token)
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            print(f'{nombre}: no pude leer {repo}: {tapar_token(str(e), token)}')
            continue
        if not sha:
            continue
        previo = estado.get(uuid) or ultimo_deploy(uuid)
        if previo == sha:
            estado[uuid] = sha
            continue
        if previo is None:
            # Primera vez y Coolify no dice de que commit es lo que corre: se anota.
            estado[uuid] = sha
            print(f'{nombre}: empiezo a vigilar desde {sha[:7]}')
            continue
        carpeta = carpeta_de(a)
        archivos = archivos_cambiados(repo, previo, sha, token) if carpeta else []
        # Sin poder saber que cambio, se despliega: mejor un deploy de mas que uno de menos.
        if archivos is not None and not toca_la_carpeta(archivos, carpeta):
            estado[uuid] = sha
            continue
        if ya_desplegado_o_en_curso(uuid, sha):
            estado[uuid] = sha
            continue
        try:
            coolify('POST', f'/deploy?uuid={uuid}&force=false')
            print(f'{nombre}: {previo[:7]} -> {sha[:7]}, desplegando')
            estado[uuid] = sha
        except RuntimeError as e:
            # Sin anotar: la vuelta siguiente lo reintenta.
            print(f'{nombre}: no pude desplegar: {e}')
    guardar_estado(estado)


def instalar():
    import shutil
    shutil.copyfile(os.path.abspath(__file__), DESTINO)
    os.chmod(DESTINO, 0o700)
    open('/etc/systemd/system/mc-autodeploy.service', 'w').write(
        '[Unit]\nDescription=Despliega las apps de fuente publica de Coolify cuando cambia su repo\n\n'
        f'[Service]\nType=oneshot\nExecStart=/usr/bin/python3 {DESTINO} vuelta\n'
    )
    open('/etc/systemd/system/mc-autodeploy.timer', 'w').write(
        '[Unit]\nDescription=Cada 2 minutos, mc-autodeploy\n\n'
        '[Timer]\nOnBootSec=2min\nOnUnitActiveSec=2min\n\n[Install]\nWantedBy=timers.target\n'
    )
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'mc-autodeploy.timer'], check=True)
    print('instalado: mc-autodeploy.timer cada 2 min (journalctl -u mc-autodeploy para verlo)')


if __name__ == '__main__':
    pasos = {'listar': listar, 'vuelta': vuelta, 'instalar': instalar}
    if len(sys.argv) != 2 or sys.argv[1] not in pasos:
        sys.exit(f'uso: {sys.argv[0]} {"|".join(pasos)}')
    pasos[sys.argv[1]]()
