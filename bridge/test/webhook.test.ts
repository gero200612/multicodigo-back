import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const bot = { handleUpdate: vi.fn(async () => {}) };

async function servidor() {
  const store = new InMemoryStore();
  const app = buildWebhookServer(bot, SECRET, { store, apiToken: API_TOKEN });
  return { app, store };
}

describe('GET /jobs', () => {
  // Las "ultimas peticiones" del panel. Salen de la MISMA tabla que usa el
  // flujo de Telegram, asi que no hay un segundo registro que se desincronice.
  it('devuelve las ultimas peticiones', async () => {
    const { app, store } = await servidor();
    await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'hola', messageId: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs[0]).toMatchObject({ agent: 'c1' as const, project: 'demo', status: 'running' });
  });

  // Este endpoint expone lo que le pediste al sistema: los prompts. Sin bearer
  // seria una filtracion de todo lo que hablaste con tus agentes.
  it('rechaza sin bearer', async () => {
    const { app } = await servidor();
    expect((await app.inject({ method: 'GET', url: '/jobs' })).statusCode).toBe(401);
  });

  it('rechaza un bearer equivocado', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: 'Bearer otro' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Un limite que venga de la URL sin tope deja pedir la tabla entera.
  it('acota el limite', async () => {
    const { app, store } = await servidor();
    for (let i = 0; i < 8; i++) {
      await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: `p${i}`, messageId: 1 });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/jobs?limit=99999',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.json().jobs.length).toBeLessThanOrEqual(50);
  });

  it('un limit basura cae al default en vez de romper', async () => {
    const { app, store } = await servidor();
    await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/jobs?limit=abc',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toHaveLength(1);
  });
});

describe('DELETE /agents/:id/sessions', () => {
  // Lo llama el login de la VM al sacar o rotar la cuenta de un slot. Tiene que
  // barrer las sesiones de ESE agente y no tocar las de los demas: un chat que
  // venia hablando con otro slot no tiene por que perder su hilo.
  it('borra las sesiones de ese agente y deja las de los otros', async () => {
    const { app, store } = await servidor();
    await store.setSession(1, 'c1' as const, 'demo', 's-c1-demo');
    await store.setSession(1, 'c1' as const, 'otro', 's-c1-otro');
    await store.setSession(1, 'c2' as const, 'demo', 's-c2-demo');

    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/c1/sessions',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ borradas: 2 });
    expect(await store.getSession(1, 'c1' as const, 'demo')).toBeUndefined();
    expect(await store.getSession(1, 'c2' as const, 'demo')).toBe('s-c2-demo');
  });

  // Sin bearer esto seria un boton para que cualquiera te corte todos los hilos
  // de conversacion abiertos.
  it('sin bearer no borra nada', async () => {
    const { app, store } = await servidor();
    await store.setSession(1, 'c1' as const, 'demo', 's-c1-demo');

    const res = await app.inject({ method: 'DELETE', url: '/agents/c1/sessions' });

    expect(res.statusCode).toBe(401);
    expect(await store.getSession(1, 'c1' as const, 'demo')).toBe('s-c1-demo');
  });

  it('rechaza un id que no tiene forma de slot', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/..%2Fetc/sessions',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /vinculos', () => {
  it('rechaza sin bearer', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/vinculos',
      payload: { codigo: 'ABCD2345', usuarioId: '99999999-9999-4999-8999-999999999999' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('canjea un codigo valido', async () => {
    const { app, store } = await servidor();
    const codigo = await store.crearCodigoVinculacion(600, 10);
    const res = await app.inject({
      method: 'POST',
      url: '/vinculos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo, usuarioId: '99999999-9999-4999-8999-999999999999' },
    });
    expect(res.statusCode).toBe(200);
    expect(await store.usuarioDeChat(600)).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('distingue los tres modos de falla', async () => {
    const { app, store } = await servidor();
    const usuario = '99999999-9999-4999-8999-999999999999';
    const pedir = (codigo: string) =>
      app.inject({
        method: 'POST',
        url: '/vinculos',
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { codigo, usuarioId: usuario },
      });

    const desconocido = await pedir('NOEXISTE');
    expect(desconocido.statusCode).toBe(400);
    expect(desconocido.json().code).toBe('codigo_desconocido');

    const vencido = await store.crearCodigoVinculacion(601, -1);
    expect((await pedir(vencido)).json().code).toBe('codigo_vencido');

    const usado = await store.crearCodigoVinculacion(602, 10);
    await pedir(usado);
    expect((await pedir(usado)).json().code).toBe('codigo_usado');
  });
});

describe('el webhook sigue andando', () => {
  it('rechaza un secret equivocado', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'mal' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  // El bearer de /jobs y el secret del webhook son credenciales DISTINTAS: una
  // la tiene el panel, la otra Telegram. Ninguna puede servir para la otra ruta.
  it('el token de la API no abre el webhook', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': API_TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('el secret del webhook no abre /jobs', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
