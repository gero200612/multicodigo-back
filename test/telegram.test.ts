import { describe, it, expect } from 'vitest';
import { isAllowedUser, renderOutcome } from '../src/telegram.js';
import { buildWebhookServer } from '../src/webhook.js';

describe('isAllowedUser', () => {
  it('acepta un usuario de la whitelist', () => {
    expect(isAllowedUser(111, [111, 222])).toBe(true);
  });

  it('rechaza un usuario que no esta', () => {
    expect(isAllowedUser(333, [111])).toBe(false);
  });

  it('rechaza cuando no hay usuario', () => {
    expect(isAllowedUser(undefined, [111])).toBe(false);
  });

  it('con whitelist vacia rechaza todo', () => {
    expect(isAllowedUser(111, [])).toBe(false);
  });
});

describe('renderOutcome', () => {
  it('muestra la respuesta con el agente que la dio', () => {
    const out = renderOutcome({
      kind: 'answer',
      text: 'El stock usa FIFO.',
      agent: 'c1',
      jobId: 'j',
    });
    expect(out).toContain('C1');
    expect(out).toContain('El stock usa FIFO.');
  });

  it('muestra la transcripcion cuando el mensaje era audio', () => {
    const out = renderOutcome({
      kind: 'answer',
      text: 'listo',
      agent: 'c2',
      jobId: 'j',
      transcript: 'que hace el stock',
    });
    expect(out).toContain('te escuche: que hace el stock');
  });

  it('confirma el cambio de agente', () => {
    expect(renderOutcome({ kind: 'switched', agent: 'c2' })).toContain('C2');
  });

  it('muestra el agente activo en status', () => {
    expect(renderOutcome({ kind: 'status', agent: 'c1' })).toContain('C1');
  });

  it('muestra el error sin exponer detalles internos', () => {
    const out = renderOutcome({ kind: 'error', text: 'Ese agente necesita re-login.', jobId: 'j' });
    expect(out).toContain('re-login');
    expect(out).not.toContain('jobId');
  });
});

describe('buildWebhookServer', () => {
  const slowBot = {
    handleUpdate: () => new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  };

  it('contesta 200 sin esperar el procesamiento del update', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'secreto' },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('rechaza con 401 si el secreto no coincide', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'otro' },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rechaza con 401 si falta el header del secreto', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const res = await app.inject({ method: 'POST', url: '/telegram/webhook', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

import { decidirAprobacion } from '../src/telegram.js';
import { InMemoryStore } from '../src/store.js';

describe('decidirAprobacion', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const REC = {
    approvalId: ID,
    jobId: '22222222-2222-4222-8222-222222222222',
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 's',
  };

  async function conAprobacion() {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    return store;
  }

  it('manda allow al agente y confirma', async () => {
    const store = await conAprobacion();
    const mandadas: unknown[] = [];
    const r = await decidirAprobacion(
      { kind: 'ok', approvalId: ID },
      { store, send: async (_a, _id, d) => void mandadas.push(d) },
    );
    expect(mandadas).toEqual([{ decision: 'allow' }]);
    expect(r.text).toContain('Aprobado');
  });

  // El caso del boton tocado tres veces: no se manda nada al agente.
  it('el segundo toque no vuelve a mandar la decision', async () => {
    const store = await conAprobacion();
    let veces = 0;
    const deps = { store, send: async () => void (veces += 1) };
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, deps);
    const r = await decidirAprobacion({ kind: 'ok', approvalId: ID }, deps);
    expect(veces).toBe(1);
    expect(r.text).toContain('ya');
  });

  it('rechazar manda deny sin feedback', async () => {
    const store = await conAprobacion();
    const mandadas: unknown[] = [];
    await decidirAprobacion(
      { kind: 'no', approvalId: ID },
      { store, send: async (_a, _id, d) => void mandadas.push(d) },
    );
    expect(mandadas).toEqual([{ decision: 'deny' }]);
  });

  // "Rechazar y explicar" no decide todavia: deja el chat esperando el motivo.
  it('explicar no manda nada y deja el chat esperando el motivo', async () => {
    const store = await conAprobacion();
    let veces = 0;
    const r = await decidirAprobacion(
      { kind: 'ex', approvalId: ID },
      { store, send: async () => void (veces += 1) },
    );
    expect(veces).toBe(0);
    expect(await store.getAwaitingFeedback(5)).toBe(ID);
    expect(r.text).toContain('Contame');
  });

  it('una aprobacion desconocida no rompe', async () => {
    const r = await decidirAprobacion(
      { kind: 'ok', approvalId: '99999999-9999-4999-8999-999999999999' },
      { store: new InMemoryStore(), send: async () => {} },
    );
    expect(r.text).toContain('no');
  });
});
