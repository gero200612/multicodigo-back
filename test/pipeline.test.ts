import { describe, it, expect, vi, type Mock } from 'vitest';
import { handleIncoming, type PipelineDeps } from '../src/pipeline.js';
import { InMemoryStore } from '../src/store.js';

type MockPipelineDeps = PipelineDeps & { ask: Mock; transcribe: Mock };

function deps(overrides: Partial<PipelineDeps> = {}): MockPipelineDeps {
  const base = {
    store: new InMemoryStore(),
    defaultAgent: 'c1' as const,
    project: 'sincroresto',
    ask: vi.fn(async () => ({
      jobId: '00000000-0000-4000-8000-000000000001',
      sessionId: 'sess-1',
      text: 'El stock usa FIFO.',
      turns: 2,
    })),
    transcribe: vi.fn(async () => 'que hace el stock'),
  };
  return { ...base, ...overrides } as MockPipelineDeps;
}

describe('handleIncoming', () => {
  it('con texto contesta la respuesta del agente', async () => {
    const d = deps();
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'que hace el stock' }, d);
    expect(out.kind).toBe('answer');
    expect(out.kind === 'answer' && out.text).toBe('El stock usa FIFO.');
  });

  it('sanitiza el codigo que devuelve el agente', async () => {
    const d = deps({
      ask: vi.fn(async () => ({
        jobId: '00000000-0000-4000-8000-000000000001',
        sessionId: 's',
        text: 'Asi:\n```ts\nconst a = 1;\n```',
        turns: 1,
      })),
    });
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'x' }, d);
    expect(out.kind === 'answer' && out.text).toBe('Asi:\n«codigo omitido — 1 linea»');
  });

  it('transcribe el audio antes de preguntar', async () => {
    const d = deps();
    await handleIncoming(
      { chatId: 1, messageId: 5, audio: { bytes: new Uint8Array([1]), mimeType: 'audio/ogg' } },
      d,
    );
    expect(d.transcribe).toHaveBeenCalled();
    expect(d.ask.mock.calls[0]![0]!.prompt).toBe('que hace el stock');
  });

  it('usa el agente activo del chat cuando el mensaje no lo especifica', async () => {
    const d = deps();
    await d.store.setActiveAgent(1, 'c2');
    await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(d.ask.mock.calls[0]![0]!.agent).toBe('c2');
  });

  it('el agente del comando gana sobre el activo', async () => {
    const d = deps();
    await d.store.setActiveAgent(1, 'c2');
    await handleIncoming({ chatId: 1, messageId: 5, text: '/c1 hola' }, d);
    expect(d.ask.mock.calls[0]![0]!.agent).toBe('c1');
  });

  it('reanuda la sesion guardada del par agente-proyecto', async () => {
    const d = deps();
    await handleIncoming({ chatId: 1, messageId: 5, text: 'uno' }, d);
    await handleIncoming({ chatId: 1, messageId: 6, text: 'dos' }, d);
    expect(d.ask.mock.calls[1]![0]!.sessionId).toBe('sess-1');
  });

  it('/c2 solo cambia el agente activo sin preguntar nada', async () => {
    const d = deps();
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: '/c2' }, d);
    expect(out.kind).toBe('switched');
    expect(d.ask).not.toHaveBeenCalled();
    expect(await d.store.getActiveAgent(1)).toBe('c2');
  });

  it('traduce el error del agente a un mensaje entendible', async () => {
    const d = deps({
      ask: vi.fn(async () => {
        throw new Error('auth_expired');
      }),
    });
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.text).toContain('re-login');
  });

  it('marca el job como failed cuando el agente falla', async () => {
    const d = deps({
      ask: vi.fn(async () => {
        throw new Error('agent_unavailable');
      }),
    });
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(out.kind === 'error' && out.jobId).toBeDefined();
    const jobId = out.kind === 'error' ? out.jobId : '';
    expect(await d.store.getJobStatus(jobId)).toBe('failed');
  });
});
