import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';

/**
 * La cuenta de demo (043): la carga el panel, la lee el gateway para `mirar`.
 * Lo que importa probar: la contraseña nunca vuelve hacia el panel, y sin el
 * token interno no sale nada.
 */

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROYECTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bot = { handleUpdate: vi.fn(async () => {}) };
const auth = { authorization: `Bearer ${API_TOKEN}` };

function servidor() {
  const guardadas = new Map<string, { ruta: string; usuario: string; password: string }>();
  const puede = (u: string, p: string) => u === USUARIO && p === PROYECTO;
  const despliegue = {
    cuentaDemo: async (u: string, p: string) => {
      if (!puede(u, p)) return undefined;
      const c = guardadas.get(p);
      return { cuenta: c ? { ruta: c.ruta, usuario: c.usuario } : null };
    },
    guardarCuentaDemo: async (u: string, p: string, c: { ruta: string; usuario: string; password: string }) => {
      if (!puede(u, p)) return false;
      guardadas.set(p, c);
      return true;
    },
    borrarCuentaDemo: async (u: string, p: string) => puede(u, p) && guardadas.delete(p),
    loginDeDemo: async (proyecto: string) => {
      const c = proyecto === 'tienda' ? guardadas.get(PROYECTO) : undefined;
      return c ? { ruta: c.ruta, email: c.usuario, password: c.password } : undefined;
    },
    publicadosDe: async (proyecto: string) => (proyecto === 'tienda' ? ['https://tienda-api.apps.punchi.dev'] : []),
  };
  return buildWebhookServer(bot, SECRET, {
    store: new InMemoryStore(),
    apiToken: API_TOKEN,
    despliegue: despliegue as never,
  });
}

describe('cuenta de demo', () => {
  it('se guarda, se lee sin la contraseña, y el gateway la recibe entera', async () => {
    const app = servidor();
    const put = await app.inject({
      method: 'PUT',
      url: '/interno/despliegue/cuenta-demo',
      headers: auth,
      payload: { usuarioId: USUARIO, proyectoId: PROYECTO, usuario: 'demo@tienda.com', password: 'secreta' },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: `/interno/despliegue/cuenta-demo?usuarioId=${USUARIO}&proyectoId=${PROYECTO}`,
      headers: auth,
    });
    expect(get.json()).toEqual({ cuenta: { ruta: '/login', usuario: 'demo@tienda.com' } });
    expect(get.body).not.toContain('secreta');

    const login = await app.inject({ method: 'GET', url: '/interno/mirar/login?proyecto=tienda', headers: auth });
    expect(login.json()).toEqual({ login: { ruta: '/login', email: 'demo@tienda.com', password: 'secreta' } });
  });

  // Lo que el gateway deja tocar a probar_api y mirar: solo lo de este proyecto.
  it('el gateway recibe las URLs publicadas del proyecto', async () => {
    const app = servidor();
    const r = await app.inject({ method: 'GET', url: '/interno/mirar/publicados?proyecto=tienda', headers: auth });
    expect(r.json()).toEqual({ urls: ['https://tienda-api.apps.punchi.dev'] });
    const sin = await app.inject({ method: 'GET', url: '/interno/mirar/publicados?proyecto=tienda' });
    expect(sin.statusCode).toBe(401);
  });

  it('sin el token interno no sale nada', async () => {
    const app = servidor();
    const r = await app.inject({ method: 'GET', url: '/interno/mirar/login?proyecto=tienda' });
    expect(r.statusCode).toBe(401);
  });

  it('quien no puede escribir en el proyecto no la carga ni la ve', async () => {
    const app = servidor();
    const otro = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const put = await app.inject({
      method: 'PUT',
      url: '/interno/despliegue/cuenta-demo',
      headers: auth,
      payload: { usuarioId: otro, proyectoId: PROYECTO, usuario: 'x', password: 'y' },
    });
    expect(put.statusCode).toBe(403);
    const get = await app.inject({
      method: 'GET',
      url: `/interno/despliegue/cuenta-demo?usuarioId=${otro}&proyectoId=${PROYECTO}`,
      headers: auth,
    });
    expect(get.statusCode).toBe(403);
  });

  it('una ruta de login que no empieza con / se rechaza', async () => {
    const app = servidor();
    const r = await app.inject({
      method: 'PUT',
      url: '/interno/despliegue/cuenta-demo',
      headers: auth,
      payload: { usuarioId: USUARIO, proyectoId: PROYECTO, ruta: 'http://evil', usuario: 'x', password: 'y' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('sin cuenta cargada el gateway recibe null y sigue como antes', async () => {
    const app = servidor();
    const r = await app.inject({ method: 'GET', url: '/interno/mirar/login?proyecto=tienda', headers: auth });
    expect(r.json()).toEqual({ login: null });
  });
});
