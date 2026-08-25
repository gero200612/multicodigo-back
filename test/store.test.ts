import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { InMemoryStore, PgStore, type Store } from '../src/store.js';

const chatId = 42;

describe.each<[string, () => Store]>([['InMemoryStore', () => new InMemoryStore()]])(
  '%s',
  (_name, make) => {
    let store: Store;
    beforeEach(() => {
      store = make();
    });

    it('sin estado previo no hay agente activo', async () => {
      expect(await store.getActiveAgent(chatId)).toBeUndefined();
    });

    it('guarda y devuelve el agente activo', async () => {
      await store.setActiveAgent(chatId, 'c2');
      expect(await store.getActiveAgent(chatId)).toBe('c2');
    });

    it('sobreescribe el agente activo', async () => {
      await store.setActiveAgent(chatId, 'c1');
      await store.setActiveAgent(chatId, 'c2');
      expect(await store.getActiveAgent(chatId)).toBe('c2');
    });

    it('las sesiones son por chat, agente y proyecto', async () => {
      await store.setSession(chatId, 'c1', 'sincroresto', 'sess-a');
      await store.setSession(chatId, 'c2', 'sincroresto', 'sess-b');
      expect(await store.getSession(chatId, 'c1', 'sincroresto')).toBe('sess-a');
      expect(await store.getSession(chatId, 'c2', 'sincroresto')).toBe('sess-b');
      expect(await store.getSession(chatId, 'c1', 'otro')).toBeUndefined();
    });

    it('crea un job en running y lo cierra en done', async () => {
      const id = await store.createJob({
        chatId,
        agent: 'c1',
        project: 'sincroresto',
        prompt: 'hola',
        messageId: 7,
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await store.finishJob(id, 'done');
      expect(await store.getJobStatus(id)).toBe('done');
    });

    it('cierra un job en failed guardando el error', async () => {
      const id = await store.createJob({
        chatId,
        agent: 'c1',
        project: 'x',
        prompt: 'y',
        messageId: 1,
      });
      await store.finishJob(id, 'failed', 'agent_unavailable');
      expect(await store.getJobStatus(id)).toBe('failed');
      expect(await store.getJobError(id)).toBe('agent_unavailable');
    });
  },
);

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('PgStore contra postgres real', () => {
  let store: PgStore;

  it('aplica la migracion y persiste el agente activo', async () => {
    store = await PgStore.connect(url!, [
      'src/bridge/migrations/001_init.sql',
      'src/bridge/migrations/002_approvals.sql',
    ]);
    await store.setActiveAgent(999, 'c2');
    expect(await store.getActiveAgent(999)).toBe('c2');
  });

  afterAll(async () => {
    if (store) await store['pool'].query('DELETE FROM chat_state WHERE chat_id = 999');
  });
});

describe('aprobaciones en el store', () => {
  const REC = {
    approvalId: '11111111-1111-4111-8111-111111111111',
    jobId: '22222222-2222-4222-8222-222222222222',
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 'escribo a.ts',
  };

  it('la primera vez que se registra devuelve true', async () => {
    const s = new InMemoryStore();
    expect(await s.recordApproval(REC)).toBe(true);
  });

  // El poller la va a ver en cada pasada; solo la primera anuncia.
  it('registrar la misma aprobacion otra vez devuelve false', async () => {
    const s = new InMemoryStore();
    await s.recordApproval(REC);
    expect(await s.recordApproval(REC)).toBe(false);
  });

  it('recupera la aprobacion con su chat y su mensaje', async () => {
    const s = new InMemoryStore();
    await s.recordApproval(REC);
    const a = await s.getApproval(REC.approvalId);
    expect(a?.chatId).toBe(5);
    expect(a?.messageId).toBe(9);
    expect(a?.agent).toBe('c1');
  });

  it('la primera decision se toma', async () => {
    const s = new InMemoryStore();
    await s.recordApproval(REC);
    expect(await s.claimApproval(REC.approvalId, { decision: 'allow' })).toBe('claimed');
  });

  // Esta es LA idempotencia: sobrevive un reinicio de Render porque vive en
  // Postgres, no en la memoria del proceso ni en la del hijo.
  it('la segunda decision sobre la misma aprobacion no se toma', async () => {
    const s = new InMemoryStore();
    await s.recordApproval(REC);
    await s.claimApproval(REC.approvalId, { decision: 'allow' });
    expect(await s.claimApproval(REC.approvalId, { decision: 'deny' })).toBe('already_decided');
  });

  it('una aprobacion que no existe no se puede decidir', async () => {
    const s = new InMemoryStore();
    expect(await s.claimApproval('no-existe', { decision: 'allow' })).toBe('unknown');
  });

  it('guarda y limpia a que aprobacion le toca el proximo mensaje', async () => {
    const s = new InMemoryStore();
    expect(await s.getAwaitingFeedback(5)).toBeUndefined();
    await s.setAwaitingFeedback(5, REC.approvalId);
    expect(await s.getAwaitingFeedback(5)).toBe(REC.approvalId);
    await s.setAwaitingFeedback(5, null);
    expect(await s.getAwaitingFeedback(5)).toBeUndefined();
  });
});
