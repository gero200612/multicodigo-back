import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';

/**
 * El panel (C#) manda los campos vacíos como `null`. Un ticket "Nueva
 * funcionalidad" va con `proyectoId` y `"proyecto": null`, y rebotaba como
 * cuerpo_invalido (2026-10-05): el ticket nunca salía.
 */
const API_TOKEN = 'token-de-api-del-bridge';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROYECTO = 'b10afe4b-16db-4bea-99af-d60d947b68d2';
const bot = { handleUpdate: vi.fn(async () => {}) };

function servidor() {
  const desarrollo = vi.fn(async () => ({ ok: true as const, corridaId: 'c-1' }));
  const app = buildWebhookServer(bot, 'secreto-de-webhook-largo', {
    store: new InMemoryStore(),
    apiToken: API_TOKEN,
    demos: { desarrollo } as never,
  });
  return { app, desarrollo };
}

describe('/interno/corrida/desde-panel', () => {
  it('acepta los campos vacíos en null, como los manda el panel', async () => {
    const { app, desarrollo } = servidor();
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/desde-panel',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: {
        usuarioId: USUARIO,
        proyecto: null,
        proyectoId: PROYECTO,
        pliego: '# Eliminar agentes\n\ntengo que poder eliminar agentes desde actividad',
        repos: [],
        referencia: [],
        org: null,
        publico: true,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(desarrollo).toHaveBeenCalledWith(
      expect.objectContaining({ proyectoId: PROYECTO, proyecto: undefined, org: undefined }),
    );
  });

  it('un pliego corto sigue siendo inválido', async () => {
    const { app } = servidor();
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/desde-panel',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { usuarioId: USUARIO, proyectoId: PROYECTO, pliego: 'corto' },
    });
    expect(r.statusCode).toBe(400);
  });
});
