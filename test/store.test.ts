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
    store = await PgStore.connect(url!, 'src/bridge/migrations/001_init.sql');
    await store.setActiveAgent(999, 'c2');
    expect(await store.getActiveAgent(999)).toBe('c2');
  });

  afterAll(async () => {
    if (store) await store['pool'].query('DELETE FROM chat_state WHERE chat_id = 999');
  });
});
