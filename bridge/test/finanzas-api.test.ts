import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const bot = { handleUpdate: vi.fn(async () => {}) };

function armar(finanzas?: { cuentas: () => Promise<{ slot: string; arriba: boolean }[]> }) {
  return buildWebhookServer(bot, SECRET, { store: new InMemoryStore(), apiToken: API_TOKEN, ...(finanzas ? { finanzas } : {}) } as never);
}

describe('/interno/finanzas/cuentas', () => {
  it('pide el bearer', async () => {
    const r = await armar({ cuentas: async () => [] }).inject({ method: 'GET', url: '/interno/finanzas/cuentas' });
    expect(r.statusCode).toBe(401);
  });

  it('devuelve los slots con cuenta', async () => {
    const app = armar({ cuentas: async () => [{ slot: 'c1', arriba: true }, { slot: 'c2', arriba: false }] });
    const r = await app.inject({ method: 'GET', url: '/interno/finanzas/cuentas', headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cuentas: [{ slot: 'c1', arriba: true }, { slot: 'c2', arriba: false }] });
  });

  it('sin gateway o sin configurar contesta 503, para que Homero use su última foto', async () => {
    const caido = armar({ cuentas: async () => { throw new Error('agent_unavailable'); } });
    const r1 = await caido.inject({ method: 'GET', url: '/interno/finanzas/cuentas', headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(r1.statusCode).toBe(503);
    const r2 = await armar().inject({ method: 'GET', url: '/interno/finanzas/cuentas', headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(r2.statusCode).toBe(503);
  });
});
