import { describe, it, expect, vi, type Mock } from 'vitest';
import { handleIncoming, type PipelineDeps } from '../src/pipeline.js';
import { InMemoryStore, type Store } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';

type MockPipelineDeps = PipelineDeps & { ask: Mock; transcribe: Mock };

function deps(overrides: Partial<PipelineDeps> = {}): MockPipelineDeps {
  const base = {
    store: new InMemoryStore(),
    defaultAgent: 'c1' as const,
    project: 'sincroresto',
    limite: new LimitePorChat(),
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

const USUARIO_DE_PRUEBA = '99999999-9999-4999-8999-999999999999';

/**
 * Ata el chat a un usuario del panel. La mayoria de los tests de este archivo
 * ejercitan el flujo normal (post-vinculo), no el guard nuevo, asi que
 * necesitan el chat vinculado para no chocar con el.
 */
async function vincular(store: Store, chatId: number): Promise<void> {
  const codigo = await store.crearCodigoVinculacion(chatId, 10);
  await store.canjearCodigo(codigo, USUARIO_DE_PRUEBA);
}

describe('handleIncoming', () => {
  it('con texto contesta la respuesta del agente', async () => {
    const d = deps();
    await vincular(d.store, 1);
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
    await vincular(d.store, 1);
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'x' }, d);
    expect(out.kind === 'answer' && out.text).toBe('Asi:\n«codigo omitido — 1 linea»');
  });

  it('transcribe el audio antes de preguntar', async () => {
    const d = deps();
    await vincular(d.store, 1);
    await handleIncoming(
      { chatId: 1, messageId: 5, audio: { bytes: new Uint8Array([1]), mimeType: 'audio/ogg' } },
      d,
    );
    expect(d.transcribe).toHaveBeenCalled();
    expect(d.ask.mock.calls[0]![0]!.prompt).toBe('que hace el stock');
  });

  it('usa el agente activo del chat cuando el mensaje no lo especifica', async () => {
    const d = deps();
    await vincular(d.store, 1);
    await d.store.setActiveAgent(1, 'c2');
    await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(d.ask.mock.calls[0]![0]!.agent).toBe('c2');
  });

  it('el agente del comando gana sobre el activo', async () => {
    const d = deps();
    await vincular(d.store, 1);
    await d.store.setActiveAgent(1, 'c2');
    await handleIncoming({ chatId: 1, messageId: 5, text: '/c1 hola' }, d);
    expect(d.ask.mock.calls[0]![0]!.agent).toBe('c1');
  });

  it('reanuda la sesion guardada del par agente-proyecto', async () => {
    const d = deps();
    await vincular(d.store, 1);
    await handleIncoming({ chatId: 1, messageId: 5, text: 'uno' }, d);
    await handleIncoming({ chatId: 1, messageId: 6, text: 'dos' }, d);
    expect(d.ask.mock.calls[1]![0]!.sessionId).toBe('sess-1');
  });

  it('/c2 solo cambia el agente activo sin preguntar nada', async () => {
    const d = deps();
    await vincular(d.store, 1);
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
    await vincular(d.store, 1);
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.text).toContain('re-login');
  });

  // Un slot del pool sin cuenta cargada todavia es el estado inicial de los
  // seis, asi que este mensaje se va a ver seguido y tiene que decir que hacer.
  it('explica que el slot no tiene cuenta cargada', async () => {
    const d = deps({
      ask: vi.fn(async () => {
        throw new Error('sin_credencial');
      }),
    });
    await vincular(d.store, 1);
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.text).toMatch(/cuenta/i);
    // No puede confundirse con auth_expired: ese es "vencio", este es "nunca
    // hubo". La accion del usuario es distinta.
    expect(out.kind === 'error' && out.text).not.toMatch(/vencio/i);
  });

  it('marca el job como failed cuando el agente falla', async () => {
    const d = deps({
      ask: vi.fn(async () => {
        throw new Error('agent_unavailable');
      }),
    });
    await vincular(d.store, 1);
    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    expect(out.kind === 'error' && out.jobId).toBeDefined();
    const jobId = out.kind === 'error' ? out.jobId : '';
    expect(await d.store.getJobStatus(jobId)).toBe('failed');
  });
});

describe('poller de aprobaciones', () => {
  it('lo arranca con los datos del job', async () => {
    let visto: unknown = null;
    const d = deps({
      watchApprovals: (ctx) => {
        visto = ctx;
        return () => {};
      },
    });
    await vincular(d.store, 7);
    await handleIncoming({ chatId: 7, messageId: 9, text: 'hola' }, d);
    expect(visto).toMatchObject({ agent: 'c1', chatId: 7, messageId: 9 });
  });

  // Sin el finally quedaria un setInterval vivo por cada mensaje que fallo.
  it('para el poller aunque el agente falle', async () => {
    let parado = false;
    const d = deps({
      ask: async () => {
        throw new Error('agent_unavailable');
      },
      watchApprovals: () => () => {
        parado = true;
      },
    });
    await vincular(d.store, 1);
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(parado).toBe(true);
  });

  it('para el poller cuando el turno termina bien', async () => {
    let parado = false;
    const d = deps({
      watchApprovals: () => () => {
        parado = true;
      },
    });
    await vincular(d.store, 1);
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(parado).toBe(true);
  });
});

describe('mensajes de error del plan 3', () => {
  for (const [code, esperado] of [
    ['run_timeout', /tiempo|corte/i],
    ['unknown_task', /tarea/i],
    ['worktree_dirty', /sin (commitear|guardar)/i],
  ] as const) {
    it(`traduce ${code} a algo que se entiende`, async () => {
      const d = deps({
        ask: async () => {
          throw new Error(code);
        },
      });
      await vincular(d.store, 1);
      const out = await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
      expect(out.kind).toBe('error');
      if (out.kind !== 'error') throw new Error('esperaba error');
      expect(out.text).toMatch(esperado);
      // Nunca el codigo crudo: el usuario no tiene por que saber que es
      // "worktree_dirty".
      expect(out.text).not.toContain(code);
    });
  }
});

describe('el job refleja donde esta parado el turno', () => {
  it('queda en running mientras el agente piensa', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    let estadoDurante: string | undefined;
    let jobId = '';
    const d = deps({
      store,
      ask: async (req) => {
        jobId = req.jobId;
        estadoDurante = await store.getJobStatus(req.jobId);
        return { jobId: req.jobId, sessionId: 's1', text: 'ok', turns: 1 };
      },
    });
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(estadoDurante).toBe('running');
    expect(await store.getJobStatus(jobId)).toBe('done');
  });

  it('cierra en failed cuando el agente falla', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    let jobId = '';
    const d = deps({
      store,
      ask: async (req) => {
        jobId = req.jobId;
        throw new Error('agent_unavailable');
      },
    });
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(await store.getJobStatus(jobId)).toBe('failed');
  });
});

describe('multi-proyecto', () => {
  it('usa el proyecto activo del chat cuando hay uno', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    await store.setActiveProject(1, 'sincroresto');
    let visto = '';
    const d = deps({
      store,
      ask: async (req) => {
        visto = req.project;
        return { jobId: req.jobId, sessionId: 's', text: 'ok', turns: 1 };
      },
    });
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(visto).toBe('sincroresto');
  });

  it('cae al proyecto por defecto cuando el chat no eligio ninguno', async () => {
    let visto = '';
    const d = deps({
      project: 'demo',
      ask: async (req) => {
        visto = req.project;
        return { jobId: req.jobId, sessionId: 's', text: 'ok', turns: 1 };
      },
    });
    await vincular(d.store, 1);
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    expect(visto).toBe('demo');
  });

  it('/proyecto <nombre> lo cambia y lo confirma', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    const out = await handleIncoming(
      { chatId: 1, messageId: 2, text: '/proyecto sincroresto' },
      deps({ store }),
    );
    expect(out.kind).toBe('project');
    expect(await store.getActiveProject(1)).toBe('sincroresto');
  });

  it('/proyecto sin nombre dice cual esta activo, sin cambiar nada', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    await store.setActiveProject(1, 'uno');
    const out = await handleIncoming({ chatId: 1, messageId: 2, text: '/proyecto' }, deps({ store }));
    if (out.kind !== 'project') throw new Error('esperaba project');
    expect(out.project).toBe('uno');
    expect(await store.getActiveProject(1)).toBe('uno');
  });

  // La sesion es por (chat, agente, proyecto): cambiar de proyecto no debe
  // arrastrar la conversacion del anterior.
  it('la sesion no se cruza entre proyectos', async () => {
    const store = new InMemoryStore();
    await vincular(store, 1);
    const sesiones: (string | undefined)[] = [];
    const d = deps({
      store,
      ask: async (req) => {
        sesiones.push(req.sessionId);
        return { jobId: req.jobId, sessionId: `s-${req.project}`, text: 'ok', turns: 1 };
      },
    });

    await store.setActiveProject(1, 'uno');
    await handleIncoming({ chatId: 1, messageId: 2, text: 'hola' }, d);
    await store.setActiveProject(1, 'dos');
    await handleIncoming({ chatId: 1, messageId: 3, text: 'hola' }, d);
    await store.setActiveProject(1, 'uno');
    await handleIncoming({ chatId: 1, messageId: 4, text: 'hola' }, d);

    // Primer turno de cada proyecto sin sesion; al volver a 'uno', la recupera.
    expect(sesiones).toEqual([undefined, undefined, 's-uno']);
  });
});

describe('vinculacion en el pipeline', () => {
  it('un chat sin vincular no llega a pedirle nada al agente', async () => {
    const store = new InMemoryStore();
    let pedidos = 0;
    const out = await handleIncoming(
      { chatId: 500, messageId: 1, text: 'arregla el login' },
      deps({ store, ask: async () => { pedidos++; throw new Error('no deberia'); } }),
    );
    expect(out).toEqual({ kind: 'sin_vincular', yaEstaba: false });
    expect(pedidos).toBe(0);
  });

  it('/vincular devuelve un codigo', async () => {
    const store = new InMemoryStore();
    const out = await handleIncoming(
      { chatId: 500, messageId: 1, text: '/vincular' },
      deps({ store }),
    );
    expect(out.kind).toBe('codigo');
    if (out.kind === 'codigo') {
      expect(out.codigo).toMatch(/^[A-Z2-9]{8}$/);
      expect(out.minutos).toBe(10);
    }
  });

  it('pasado el tope, /vincular deja de dar codigos', async () => {
    const store = new InMemoryStore();
    const limite = new LimitePorChat(1, 60_000, () => 0);
    const propias = deps({ store, limite });

    expect((await handleIncoming({ chatId: 500, messageId: 1, text: '/vincular' }, propias)).kind)
      .toBe('codigo');
    const segundo = await handleIncoming({ chatId: 500, messageId: 2, text: '/vincular' }, propias);
    expect(segundo).toEqual({ kind: 'sin_vincular', yaEstaba: false });
  });

  it('un chat ya vinculado que pide /vincular de nuevo se entera de que ya lo esta', async () => {
    const store = new InMemoryStore();
    const codigo = await store.crearCodigoVinculacion(500, 10);
    await store.canjearCodigo(codigo, USUARIO_DE_PRUEBA);

    const out = await handleIncoming(
      { chatId: 500, messageId: 1, text: '/vincular' },
      deps({ store }),
    );
    expect(out).toEqual({ kind: 'sin_vincular', yaEstaba: true });
  });

  it('un chat vinculado trabaja normalmente', async () => {
    const store = new InMemoryStore();
    const codigo = await store.crearCodigoVinculacion(500, 10);
    await store.canjearCodigo(codigo, USUARIO_DE_PRUEBA);

    const out = await handleIncoming(
      { chatId: 500, messageId: 1, text: 'hola' },
      deps({ store }),
    );
    expect(out.kind).toBe('answer');
  });
});
