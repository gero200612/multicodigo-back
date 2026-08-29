import { describe, it, expect, vi } from 'vitest';
import { decidir } from '../src/decisiones.js';
import { InMemoryStore } from '../src/store.js';

const REC = {
  approvalId: '11111111-1111-4111-8111-111111111111',
  jobId: '22222222-2222-4222-8222-222222222222',
  chatId: 5,
  messageId: 9,
  agent: 'c1' as const,
  tool: 'Write',
  summary: 'escribo a.ts',
};

const APROBAR = { decision: 'allow' } as const;

describe('decidir', () => {
  it('la primera decision gana y llega al gateway', async () => {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    const send = vi.fn(async () => {});

    const r = await decidir(
      { store, send, editarMensaje: async () => {} },
      { approvalId: REC.approvalId, decision: APROBAR, desde: 'panel', usuarioId: 'u1' },
    );

    expect(r).toBe('ok');
    expect(send).toHaveBeenCalledOnce();
  });

  // Aprobar en Telegram y en el panel casi a la vez es el caso que este modulo
  // existe para resolver: el agente tiene que recibir UNA decision.
  it('la segunda no llega al gateway', async () => {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    const send = vi.fn(async () => {});
    const deps = { store, send, editarMensaje: async () => {} };
    const uno = { approvalId: REC.approvalId, decision: APROBAR, usuarioId: 'u1' };

    await decidir(deps, { ...uno, desde: 'telegram' as const });
    const r = await decidir(deps, { ...uno, desde: 'panel' as const, usuarioId: 'u2' });

    expect(r).toBe('ya_decidida');
    expect(send).toHaveBeenCalledOnce();
  });

  it('una aprobacion que no existe se distingue de una ya decidida', async () => {
    const store = new InMemoryStore();
    const r = await decidir(
      { store, send: async () => {}, editarMensaje: async () => {} },
      { approvalId: REC.approvalId, decision: APROBAR, desde: 'panel', usuarioId: 'u1' },
    );
    expect(r).toBe('desconocida');
  });

  it('si editar el mensaje de Telegram falla, la decision igual vale', async () => {
    // El agente ya recibio el OK. Volver atras porque no se pudo tocar un
    // mensaje seria deshacer algo que ya paso.
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    const send = vi.fn(async () => {});

    const r = await decidir(
      {
        store,
        send,
        editarMensaje: async () => {
          throw new Error('message to edit not found');
        },
      },
      { approvalId: REC.approvalId, decision: APROBAR, desde: 'panel', usuarioId: 'u1' },
    );

    expect(r).toBe('ok');
    expect(send).toHaveBeenCalledOnce();
  });

  it('el rechazo con comentario se distingue en el mensaje', async () => {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    const editados: string[] = [];

    await decidir(
      {
        store,
        send: async () => {},
        editarMensaje: async (_c, _m, texto) => {
          editados.push(texto);
        },
      },
      {
        approvalId: REC.approvalId,
        decision: { decision: 'deny', feedback: 'mejor no' },
        desde: 'telegram',
      },
    );

    expect(editados[0]).toContain('comentario');
  });

  // El turno esta bloqueado esperando: si no vuelve a 'running', la tabla dice
  // que sigue esperando un OK que ya llego.
  it('desbloquea el job', async () => {
    const store = new InMemoryStore();
    // El job tiene que existir de verdad: `setJobStatus` no inventa uno, y sin
    // esto el test pasaria aunque `decidir` no lo tocara.
    const jobId = await store.createJob({
      chatId: 5,
      agent: 'c1',
      project: 'demo',
      prompt: 'hola',
      messageId: 9,
    });
    await store.recordApproval({ ...REC, jobId });
    await store.setJobStatus(jobId, 'awaiting_approval');

    await decidir(
      { store, send: async () => {}, editarMensaje: async () => {} },
      { approvalId: REC.approvalId, decision: APROBAR, desde: 'panel', usuarioId: 'u1' },
    );

    expect(await store.getJobStatus(jobId)).toBe('running');
  });
});
