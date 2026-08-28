import { describe, it, expect } from 'vitest';
import { renderOutcome } from '../src/telegram.js';
import { buildWebhookServer } from '../src/webhook.js';

describe('renderOutcome', () => {
  it('explica que hay que vincularse, sin decir como por dentro', () => {
    const texto = renderOutcome({ kind: 'sin_vincular', yaEstaba: false });
    expect(texto).toContain('/vincular');
  });

  it('a un chat ya vinculado le dice que ya lo esta', () => {
    const texto = renderOutcome({ kind: 'sin_vincular', yaEstaba: true });
    expect(texto).toContain('ya');
    expect(texto).not.toContain('/vincular');
  });

  it('muestra el codigo y cuanto dura', () => {
    const texto = renderOutcome({ kind: 'codigo', codigo: 'ABCD2345', minutos: 10 });
    expect(texto).toContain('ABCD2345');
    expect(texto).toContain('10');
  });

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
    // El bot falso tarda 3000 ms. Lo que se prueba es que NO se lo espera, y
    // para eso alcanza cualquier umbral bien por debajo de esos 3 segundos.
    // Con 100 ms el test fallaba cuando el suite completo corria en paralelo y
    // la maquina estaba cargada: medir "es rapido" en vez de "no espera" lo
    // hacia depender del hardware.
    expect(Date.now() - started).toBeLessThan(1000);
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

describe('el job cambia de estado con la aprobacion', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const JOB = '22222222-2222-4222-8222-222222222222';
  const REC = {
    approvalId: ID,
    jobId: JOB,
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 's',
  };

  async function conJobYAprobacion() {
    const store = new InMemoryStore();
    // Se fuerza el id del job para poder seguirlo: createJob genera uno propio.
    await store.recordApproval(REC);
    return store;
  }

  // Lo que arregla el hueco: mientras espera el OK, el job NO dice 'running'.
  it('decidir devuelve el job a running', async () => {
    const store = await conJobYAprobacion();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, approvalId: 'otra', jobId });
    await store.setJobStatus(jobId, 'awaiting_approval');
    expect(await store.getJobStatus(jobId)).toBe('awaiting_approval');

    await decidirAprobacion(
      { kind: 'ok', approvalId: 'otra' },
      { store, send: async () => {} },
    );
    expect(await store.getJobStatus(jobId)).toBe('running');
  });

  it('rechazar tambien lo devuelve a running: el turno sigue vivo hasta que cierre', async () => {
    const store = new InMemoryStore();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, jobId });
    await store.setJobStatus(jobId, 'awaiting_approval');

    await decidirAprobacion({ kind: 'no', approvalId: ID }, { store, send: async () => {} });
    expect(await store.getJobStatus(jobId)).toBe('running');
  });

  it('un doble toque no toca el estado del job', async () => {
    const store = new InMemoryStore();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, jobId });
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, { store, send: async () => {} });
    await store.finishJob(jobId, 'done');
    // El segundo toque llega tarde; no puede reabrir el job.
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, { store, send: async () => {} });
    expect(await store.getJobStatus(jobId)).toBe('done');
  });
});

describe('renderOutcome — proyecto', () => {
  it('confirma el proyecto activo', () => {
    const out = renderOutcome({ kind: 'project', project: 'sincroresto' });
    expect(out).toContain('sincroresto');
  });
});
