#!/usr/bin/env python3
"""mc-uso: memoria y disco del VPS para Punchi.

Escucha SOLO en la IP de Tailscale (100.113.60.114:8090) y pide un token
(/root/mc-uso.token). Solo stdlib. Unit: mc-uso.service.
"""
import hmac, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = open('/root/mc-uso.token').read().strip()
HOST = os.environ.get('MC_USO_HOST', '100.113.60.114')


def uso():
    mem = {}
    for linea in open('/proc/meminfo'):
        k, v = linea.split(':', 1)
        mem[k] = int(v.split()[0])
    st = os.statvfs('/')
    return {
        'memTotalMb': mem['MemTotal'] // 1024,
        'memDisponibleMb': mem['MemAvailable'] // 1024,
        'discoTotalGb': round(st.f_blocks * st.f_frsize / 1e9, 1),
        'discoLibreGb': round(st.f_bavail * st.f_frsize / 1e9, 1),
    }


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        if self.path != '/uso' or not hmac.compare_digest(auth, 'Bearer ' + TOKEN):
            self.send_response(404)
            self.end_headers()
            return
        cuerpo = json.dumps(uso()).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def log_message(self, *a):
        pass


ThreadingHTTPServer((HOST, 8090), H).serve_forever()
