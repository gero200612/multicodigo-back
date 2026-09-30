import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, type Store } from '../src/store.js';
import { buildWebhookServer } from '../src/webhook.js';
import { abrirDemo, estadoDeDemo } from '../src/demo-homero.js';
import type { BridgeDeps } from '../src/telegram.js';

const USUARIO = '99999999-9999-4999-8999-999999999999';
const API_TOKEN = 'token-de-api-del-bridge';
const PLIEGO = 'Una demo para un estudio contable: turnos online y recordatorios por WhatsApp.';
const bot = { handleUpdate: vi.fn(async () => {}) };

async function vincular(store: Store, chatId: number): Promise<void> {
  const codigo = await store.crearCodigoVinculacion(chatId, 10);
  await store.canjearCodigo(codigo, USUARIO);
}

describe('rutas de demos de Homero', () => {
  const demos = {
    abrir: vi.fn(async (p: { proyecto: string }) =>
      p.proyecto === 'ocupado'
        ? ({ ok: false, motivo: 'Punchi esta ocupado con la corrida de x' } as const)
        : ({ ok: true, corridaId: 'c-1' } as const),
    ),
    estado: vi.fn(async (_chat: number, id: string) =>
      id === '11111111-1111-4111-8111-111111111111' ? { estado: 'cerrada' as const, url: 'https://x.onrender.com' } : undefined,
    ),
  };
  const app = buildWebhookServer(bot, 'secreto-de-webhook-largo', {
    store: new InMemoryStore(),
    apiToken: API_TOKEN,
    demos,
  });
  const auth = { authorization: `Bearer ${API_TOKEN}` };

  it('sin bearer no abre nada', async () => {
    const r = await app.inject({ method: 'POST', url: '/interno/corrida/desde-homero', payload: {} });
    expect(r.statusCode).toBe(401);
    expect(demos.abrir).not.toHaveBeenCalled();
  });

  it('un nombre de proyecto con espacios es 400: no llega al comando', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/desde-homero',
      headers: auth,
      payload: { chatId: 7, proyecto: 'estudio perez', pliego: PLIEGO },
    });
    expect(r.statusCode).toBe(400);
  });

  it('abre y devuelve el id de la corrida', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/desde-homero',
      headers: auth,
      payload: { chatId: 7, proyecto: 'estudio-perez-demo', pliego: PLIEGO },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ corridaId: 'c-1' });
  });

  it('si no se pudo abrir es 409 con el motivo, para mostrarselo a Gero', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/desde-homero',
      headers: auth,
      payload: { chatId: 7, proyecto: 'ocupado', pliego: PLIEGO },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toContain('ocupado');
  });

  it('el estado: 200 con la url, 404 si no existe', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/interno/corrida/11111111-1111-4111-8111-111111111111/estado?chatId=7',
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ estado: 'cerrada', url: 'https://x.onrender.com' });
    const no = await app.inject({
      method: 'GET',
      url: '/interno/corrida/22222222-2222-4222-8222-222222222222/estado?chatId=7',
      headers: auth,
    });
    expect(no.statusCode).toBe(404);
  });

  it('sin demos configuradas contesta 503', async () => {
    const sin = buildWebhookServer(bot, 'secreto-de-webhook-largo', { store: new InMemoryStore(), apiToken: API_TOKEN });
    const r = await sin.inject({
      method: 'POST',
      url: '/interno/corrida/desde-homero',
      headers: auth,
      payload: { chatId: 7, proyecto: 'x', pliego: PLIEGO },
    });
    expect(r.statusCode).toBe(503);
  });
});

describe('abrirDemo', () => {
  const avisar = vi.fn(async () => {});

  it('con un /corrida a medias no abre: el pliego se comeria como respuesta del paso', async () => {
    const store = new InMemoryStore();
    await vincular(store, 7);
    await store.guardarBorrador(7, 'pliego', 'otro');
    const r = await abrirDemo({ chatId: 7, proyecto: 'demo', pliego: PLIEGO }, { store } as unknown as BridgeDeps, avisar);
    expect(r).toEqual({ ok: false, motivo: expect.stringContaining('a medias') });
    expect(await store.corridaAbierta(7)).toBeUndefined();
  });

  it('un chat sin vincular no abre', async () => {
    const store = new InMemoryStore();
    const r = await abrirDemo({ chatId: 7, proyecto: 'demo', pliego: PLIEGO }, { store } as unknown as BridgeDeps, avisar);
    expect(r).toEqual({ ok: false, motivo: expect.stringContaining('vinculado') });
  });
});

describe('estadoDeDemo', () => {
  it('trae la url del front publicado', async () => {
    const store = new InMemoryStore();
    await vincular(store, 7);
    const proyectoId = await store.crearProyecto('perez-demo', USUARIO);
    await store.vincularRepo(proyectoId, 'perez-demo-back', 'org/perez-demo-back', false, true);
    await store.vincularRepo(proyectoId, 'perez-demo-front', 'org/perez-demo-front', false, true);
    await store.guardarRenderServiceId(proyectoId, 'perez-demo-back', 'srv-b', 'https://back.onrender.com');
    await store.guardarRenderServiceId(proyectoId, 'perez-demo-front', 'srv-f', 'https://front.onrender.com');
    const c = await store.abrirCorrida({ chatId: 7, proyecto: 'perez-demo', md: PLIEGO, techoRondas: 3, techoHora: '07:00' });
    await store.cerrarCorrida(c!.id, 'completo');

    const e = await estadoDeDemo(7, c!.id, { store } as unknown as BridgeDeps);
    expect(e).toEqual({ estado: 'cerrada', motivoDeCierre: 'completo', url: 'https://front.onrender.com' });
  });

  it('una corrida de otro usuario no aparece', async () => {
    const store = new InMemoryStore();
    await vincular(store, 7);
    expect(await estadoDeDemo(7, '11111111-1111-4111-8111-111111111111', { store } as unknown as BridgeDeps)).toBeUndefined();
  });
});
