import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  handleIncoming,
  ejecutarTurno,
  ejecutarTurnoConRelevo,
  type PipelineDeps,
} from '../src/pipeline.js';
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
    // Sin agentes por defecto: los tests del menu lo pisan con lo que necesitan.
    listarAgentes: async () => [],
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

  it('reanuda la sesion guardada del proyecto y el agente', async () => {
    const d = deps();
    await vincular(d.store, 1);
    // El proyecto tiene que EXISTIR: la sesion se guarda por su id, y sin fila
    // no hay clave con que guardarla.
    await d.store.crearProyecto('sincroresto', USUARIO_DE_PRUEBA);

    await handleIncoming({ chatId: 1, messageId: 5, text: 'uno' }, d);
    await handleIncoming({ chatId: 1, messageId: 6, text: 'dos' }, d);

    expect(d.ask.mock.calls[1]![0]!.sessionId).toBe('sess-1');
  });

  // Un proyecto que solo vive en config/projects.json no tiene fila, y por lo
  // tanto no tiene con que guardar la sesion. El turno tiene que correr igual:
  // es lo que el sistema hacia antes de que los proyectos existieran.
  it('un proyecto que no esta en la tabla igual contesta, sin hilo', async () => {
    const d = deps();
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'uno' }, d);
    await handleIncoming({ chatId: 1, messageId: 6, text: 'dos' }, d);

    expect(out.kind).toBe('answer');
    expect(d.ask.mock.calls[1]![0]!.sessionId).toBeUndefined();
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

    await store.crearProyecto('uno', USUARIO_DE_PRUEBA);
    await store.crearProyecto('dos', USUARIO_DE_PRUEBA);

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

describe('el menu', () => {
  const USUARIO = USUARIO_DE_PRUEBA;

  async function storeVinculado(chatId: number): Promise<InMemoryStore> {
    const store = new InMemoryStore();
    await vincular(store, chatId);
    return store;
  }

  it('un usuario sin proyectos lo sabe', async () => {
    const d = deps({ store: await storeVinculado(700) });
    const out = await handleIncoming({ chatId: 700, messageId: 1, text: '/menu' }, d);
    expect(out).toEqual({ kind: 'sin_proyectos' });
  });

  // Preguntar entre una opcion es un toque de mas que no decide nada.
  it('con un solo proyecto saltea el paso y muestra los agentes', async () => {
    const store = await storeVinculado(700);
    const p = await store.crearProyecto('demo', USUARIO);
    await store.registrarAgente(p, 'c1', 'Backend');

    const out = await handleIncoming(
      { chatId: 700, messageId: 1, text: '/menu' },
      deps({ store, listarAgentes: async () => [{ id: 'c1' as const, arriba: true, cuenta: true }] }),
    );

    expect(out.kind).toBe('menu_agentes');
    if (out.kind === 'menu_agentes') {
      expect(out.proyecto).toBe('demo');
      expect(out.botones[0]![0]!.label).toContain('Backend');
    }
    // Y queda elegido: el proximo mensaje va a ese proyecto sin repetir el paso.
    expect(await store.getActiveProject(700)).toBe('demo');
  });

  it('con dos proyectos pregunta cual', async () => {
    const store = await storeVinculado(700);
    await store.crearProyecto('demo', USUARIO);
    await store.crearProyecto('otro', USUARIO);

    const out = await handleIncoming({ chatId: 700, messageId: 1, text: '/menu' }, deps({ store }));

    expect(out.kind).toBe('menu_proyectos');
    if (out.kind === 'menu_proyectos') expect(out.botones).toHaveLength(2);
  });

  it('el estado de cada agente sale del gateway', async () => {
    const store = await storeVinculado(700);
    const p = await store.crearProyecto('demo', USUARIO);
    await store.registrarAgente(p, 'c1', 'Arriba');
    await store.registrarAgente(p, 'c2', 'Abajo');

    const out = await handleIncoming(
      { chatId: 700, messageId: 1, text: '/menu' },
      deps({
        store,
        listarAgentes: async () => [
          { id: 'c1' as const, arriba: true, cuenta: true },
          { id: 'c2' as const, arriba: false, cuenta: true },
        ],
      }),
    );

    if (out.kind === 'menu_agentes') {
      expect(out.botones[0]![0]!.label).toBe('● Arriba');
      expect(out.botones[1]![0]!.label).toBe('○ Abajo');
    }
  });

  // Quien sabe si un slot tiene cuenta es el gateway, no la tabla.
  it('el agente sin cuenta se marca y no se puede elegir', async () => {
    const store = await storeVinculado(700);
    const p = await store.crearProyecto('demo', USUARIO);
    await store.registrarAgente(p, 'c1', 'Nuevo');

    const out = await handleIncoming(
      { chatId: 700, messageId: 1, text: '/menu' },
      deps({
        store,
        listarAgentes: async () => [{ id: 'c1' as const, arriba: false, cuenta: false }],
      }),
    );

    if (out.kind === 'menu_agentes') {
      expect(out.botones[0]![0]!.label).toBe('⚠ Nuevo');
      expect(out.botones[0]![0]!.data).toBe('x:');
    }
  });

  it('si el gateway no contesta, el menu igual aparece', async () => {
    // Un gateway caido no puede dejarte sin poder ver que agentes tenes: se
    // muestran todos apagados, que es lo peor que puede ser cierto.
    const store = await storeVinculado(700);
    const p = await store.crearProyecto('demo', USUARIO);
    await store.registrarAgente(p, 'c1', 'Backend');

    const out = await handleIncoming(
      { chatId: 700, messageId: 1, text: '/menu' },
      deps({
        store,
        listarAgentes: async () => {
          throw new Error('agent_unavailable');
        },
      }),
    );

    expect(out.kind).toBe('menu_agentes');
    if (out.kind === 'menu_agentes') expect(out.botones[0]![0]!.label).toBe('⚠ Backend');
  });

  it('un chat sin vincular no ve ningun menu', async () => {
    const out = await handleIncoming({ chatId: 701, messageId: 1, text: '/menu' }, deps());
    expect(out.kind).toBe('sin_vincular');
  });
});

describe('el relevo cuando un slot se queda sin tokens', () => {
  const PROYECTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USUARIO = USUARIO_DE_PRUEBA;
  const TURNO = {
    proyectoId: PROYECTO,
    proyecto: 'demo',
    agente: 'c1' as const,
    usuarioId: USUARIO,
    prompt: 'segui con el endpoint',
    origen: 'panel' as const,
  };
  const CON_CUENTA = [
    { id: 'c1' as const, arriba: false, cuenta: true },
    { id: 'c2' as const, arriba: false, cuenta: true },
  ];

  /** Falla con usage_limit en los slots nombrados y contesta bien en el resto. */
  function agotados(...sinTokens: string[]) {
    const pedidos: { agent: string; prompt: string }[] = [];
    const ask = vi.fn(async (req: { jobId: string; agent: string; prompt: string }) => {
      pedidos.push({ agent: req.agent, prompt: req.prompt });
      if (sinTokens.includes(req.agent)) throw new Error('usage_limit');
      return { jobId: req.jobId, sessionId: 'sess-1', text: 'listo', turns: 1 };
    });
    return { ask, pedidos };
  }

  it('pasa al slot siguiente y devuelve su respuesta', async () => {
    const { ask, pedidos } = agotados('c1');
    const r = await ejecutarTurnoConRelevo(
      deps({ ask, listarAgentes: async () => CON_CUENTA }),
      TURNO,
    );

    expect(r.texto).toBe('listo');
    expect(pedidos.map((p) => p.agent)).toEqual(['c1', 'c2']);
    expect(r.relevos).toEqual(['c1 -> c2']);
  });

  /*
   * El punto de todo esto: el slot que releva tiene que saber que hay trabajo
   * hecho en el worktree.
   *
   * No puede hacer `resume` de la sesion de c1 —el transcript vive en el HOME de
   * c1— asi que arranca de cero. Sin este aviso, empieza el trabajo otra vez y
   * pisa lo que estaba: el worktree es compartido por proyecto, no por slot.
   */
  it('el que releva recibe el contexto y el aviso del worktree', async () => {
    const store = new InMemoryStore();
    // Un turno anterior de c1, que es de donde sale el contexto.
    store.turnosRecientes = async () => [
      { prompt: 'crea el endpoint', respuesta: 'lo cree en server.ts' },
    ];
    const { ask, pedidos } = agotados('c1');

    await ejecutarTurnoConRelevo(
      deps({ store, ask, listarAgentes: async () => CON_CUENTA }),
      TURNO,
    );

    const aC2 = pedidos[1]!.prompt;
    expect(aC2).toContain('lo cree en server.ts');
    expect(aC2.toLowerCase()).toContain('worktree');
    expect(aC2).toContain('segui con el endpoint');
    // Y el de c1 va limpio: el aviso de relevo solo tiene sentido para el que releva.
    expect(pedidos[0]!.prompt).toBe('segui con el endpoint');
  });

  it('sin ningun slot con cuenta, el error sube tal cual', async () => {
    const { ask } = agotados('c1');
    await expect(
      ejecutarTurnoConRelevo(
        deps({ ask, listarAgentes: async () => [{ id: 'c1' as const, arriba: false, cuenta: true }] }),
        TURNO,
      ),
    ).rejects.toThrow('usage_limit');
  });

  // Relevar cualquier fallo repetiria el mismo error en otro slot y esconderia
  // la causa: un worktree sucio lo sigue estando desde el slot que sea.
  it('no releva por un error que no es de tokens', async () => {
    const pedidos: string[] = [];
    const ask = vi.fn(async (req: { agent: string }) => {
      pedidos.push(req.agent);
      throw new Error('worktree_dirty');
    });

    await expect(
      ejecutarTurnoConRelevo(deps({ ask, listarAgentes: async () => CON_CUENTA }), TURNO),
    ).rejects.toThrow('worktree_dirty');
    expect(pedidos).toEqual(['c1']);
  });

  // Sin tope, con seis slots agotados el turno gira seis veces y el usuario
  // espera el timeout de todos.
  it('se rinde despues de unos pocos intentos', async () => {
    const { ask, pedidos } = agotados('c1', 'c2', 'c3', 'c4', 'c5');
    const todos = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({
      id: id as 'c1',
      arriba: false,
      cuenta: true,
    }));

    await expect(
      ejecutarTurnoConRelevo(deps({ ask, listarAgentes: async () => todos }), TURNO),
    ).rejects.toThrow('usage_limit');
    // No los seis: el tope corta antes.
    expect(pedidos.length).toBeLessThanOrEqual(4);
  });

  it('si el gateway no contesta no hay relevo, y el error original sube', async () => {
    const { ask } = agotados('c1');
    await expect(
      ejecutarTurnoConRelevo(
        deps({
          ask,
          listarAgentes: async () => {
            throw new Error('agent_unavailable');
          },
        }),
        TURNO,
      ),
    ).rejects.toThrow('usage_limit');
  });
});

describe('ejecutarTurno', () => {
  const PROYECTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USUARIO = USUARIO_DE_PRUEBA;

  it('dos turnos seguidos reusan la sesion del proyecto', async () => {
    const store = new InMemoryStore();
    const sesiones: (string | undefined)[] = [];
    const propias = deps({
      store,
      ask: async (req) => {
        sesiones.push(req.sessionId);
        return { jobId: req.jobId, sessionId: 'sess-1', text: 'ok', turns: 1 };
      },
    });

    await ejecutarTurno(propias, {
      proyectoId: PROYECTO,
      proyecto: 'demo',
      agente: 'c1',
      usuarioId: USUARIO,
      prompt: 'uno',
      origen: 'panel',
    });
    await ejecutarTurno(propias, {
      proyectoId: PROYECTO,
      proyecto: 'demo',
      agente: 'c1',
      usuarioId: USUARIO,
      prompt: 'dos',
      origen: 'telegram',
    });

    // El segundo turno reusa la sesion que dejo el primero, aunque venga de
    // otro frente: eso ES el hilo compartido.
    expect(sesiones).toEqual([undefined, 'sess-1']);
  });

  it('el turno guarda la respuesta del agente', async () => {
    const store = new InMemoryStore();
    const { jobId } = await ejecutarTurno(
      deps({
        store,
        ask: async (r) => ({ jobId: r.jobId, sessionId: 's', text: 'la respuesta', turns: 1 }),
      }),
      {
        proyectoId: PROYECTO,
        proyecto: 'demo',
        agente: 'c1',
        usuarioId: USUARIO,
        prompt: 'hola',
        origen: 'panel',
      },
    );

    expect(await store.getJobRespuesta(jobId)).toBe('la respuesta');
  });

  // Sin el poller, un agente que pide permiso desde un turno del panel se
  // cuelga hasta el timeout de 15 minutos, sin decir por que.
  it('cuelga el poller de aprobaciones tambien en un turno del panel', async () => {
    let colgados = 0;
    let parados = 0;
    await ejecutarTurno(
      deps({
        store: new InMemoryStore(),
        watchApprovals: () => {
          colgados += 1;
          return () => {
            parados += 1;
          };
        },
      }),
      {
        proyectoId: PROYECTO,
        proyecto: 'demo',
        agente: 'c1',
        usuarioId: USUARIO,
        prompt: 'hola',
        origen: 'panel',
      },
    );

    expect(colgados).toBe(1);
    expect(parados).toBe(1);
  });

  it('un turno que falla cierra el job y suelta el poller', async () => {
    const store = new InMemoryStore();
    let parados = 0;

    await expect(
      ejecutarTurno(
        deps({
          store,
          ask: async () => {
            throw new Error('agent_unavailable');
          },
          watchApprovals: () => () => {
            parados += 1;
          },
        }),
        {
          proyectoId: PROYECTO,
          proyecto: 'demo',
          agente: 'c1',
          usuarioId: USUARIO,
          prompt: 'hola',
          origen: 'panel',
        },
      ),
    ).rejects.toThrow('agent_unavailable');

    expect(parados).toBe(1);
  });

  // Sin proyecto no hay clave con que guardar la sesion, pero el turno corre.
  it('sin proyectoId no guarda sesion y no rompe', async () => {
    const store = new InMemoryStore();
    const r = await ejecutarTurno(
      deps({ store, ask: async (q) => ({ jobId: q.jobId, sessionId: 's', text: 'ok', turns: 1 }) }),
      { proyecto: 'demo', agente: 'c1', usuarioId: USUARIO, prompt: 'hola', origen: 'panel' },
    );

    expect(r.texto).toBe('ok');
  });
});

/**
 * El agotamiento: lo que pasa cuando una cuenta se queda sin tokens.
 *
 * El bug que motivo todo esto tenia tres mitades, y cada una se prueba aparte:
 * el cartel no se reconocia (eso vive en `@multicodigo/shared`), el aviso salia
 * en ingles, y el estado no se guardaba en ningun lado — asi que el menu
 * seguia ofreciendo un slot vacio.
 */
describe('quedarse sin tokens', () => {
  /** Un `ask` que falla como falla el gateway cuando la cuenta se agoto. */
  function askSinTokens(resets?: string): Mock {
    return vi.fn(async () => {
      const e = new Error('usage_limit') as Error & { resets?: string };
      e.resets = resets;
      throw e;
    });
  }

  it('avisa en castellano y dice cuando vuelve la cuenta', async () => {
    const d = deps({ ask: askSinTokens('1:30am (UTC)') });
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    expect(out.kind).toBe('error');
    // Ni una palabra del cartel de Anthropic: eso es lo que llegaba antes.
    expect(out.kind === 'error' && out.text).toBe('C1 se quedo sin tokens. La cuenta vuelve 1:30am (UTC).');
  });

  it('sin hora de reset, avisa igual sin inventarla', async () => {
    const d = deps({ ask: askSinTokens() });
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    expect(out.kind === 'error' && out.text).toBe('C1 se quedo sin tokens.');
  });

  it('siempre deja como salir a elegir otro agente', async () => {
    const d = deps({
      ask: askSinTokens('1:30am (UTC)'),
      listarAgentes: async () => [
        { id: 'c1' as const, arriba: true, cuenta: true },
        { id: 'c2' as const, arriba: false, cuenta: true },
      ],
    });
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    // c2 NO aparece como atajo, y es correcto: el relevo automatico ya lo
    // probo en este mismo turno y tambien se quedo sin tokens. Ofrecerlo seria
    // mandar a la persona a repetir el error que acaba de pasar.
    expect(out.kind === 'error' && out.botones).toEqual([
      [{ label: '🔀 Elegir otro agente', data: 'm:' }],
    ]);
  });

  it('ofrece el atajo al slot que el relevo no llego a probar', async () => {
    // El relevo se rinde a los 3 intentos (TOPE_DE_RELEVOS), asi que con cinco
    // cuentas queda una sin probar y sin marcar. Ese es el unico caso en que un
    // atajo directo ahorra toques de verdad, y por eso existe.
    const d = deps({
      ask: askSinTokens('1:30am (UTC)'),
      listarAgentes: async () =>
        (['c1', 'c2', 'c3', 'c4', 'c5'] as const).map((id) => ({ id, arriba: true, cuenta: true })),
    });
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);
    const botones = out.kind === 'error' ? out.botones : undefined;

    // c5 quedo sin probar: se ofrece derecho.
    expect(botones?.[0]).toEqual([{ label: 'Seguir con C5', data: 'a:c5' }]);
    // Y el menu siempre cierra la lista.
    expect(botones?.at(-1)).toEqual([{ label: '🔀 Elegir otro agente', data: 'm:' }]);
  });

  it('deja anotado el slot para que el menu no lo ofrezca', async () => {
    const d = deps({ ask: askSinTokens('1:30am (UTC)') });
    await vincular(d.store, 1);

    await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    // Esto es lo que no existia: el dato sobrevive al turno.
    const agotados = await d.store.slotsAgotados();
    expect(agotados.get('c1')?.resets).toBe('1:30am (UTC)');
  });

  it('borra la marca cuando el slot vuelve a contestar bien', async () => {
    const d = deps();
    await vincular(d.store, 1);
    await d.store.marcarAgotado('c1', '1:30am (UTC)');

    await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    // Un turno que salio bien es la unica prueba de que hay tokens.
    expect((await d.store.slotsAgotados()).has('c1')).toBe(false);
  });

  it('atrapa el cartel aunque el agente lo devuelva como respuesta buena', async () => {
    // La red de seguridad. Es exactamente la fila del 2026-09-02: el agente
    // contesto 200 con el cartel adentro y sin codigo de error.
    const d = deps({
      ask: vi.fn(async () => ({
        jobId: '00000000-0000-4000-8000-000000000001',
        sessionId: 'sess-1',
        text: "You're out of extra usage · resets 1:30am (UTC)",
        turns: 1,
      })),
    });
    await vincular(d.store, 1);

    const out = await handleIncoming({ chatId: 1, messageId: 5, text: 'hola' }, d);

    // Antes esto era un `answer` con el cartel adentro.
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.text).toBe('C1 se quedo sin tokens. La cuenta vuelve 1:30am (UTC).');
    expect((await d.store.slotsAgotados()).has('c1')).toBe(true);
  });
});

/**
 * Un slot lo usa una persona a la vez.
 *
 * El gateway es el que lleva la cuenta —ver `Tenencia` alla— y contesta 409
 * `agente_ocupado`. Lo que se prueba aca es la otra mitad: que eso llegue al
 * chat como una eleccion y no como una falla.
 */
describe('handleIncoming: el agente esta ocupado', () => {
  /** El error tal como lo levanta `askAgent` a partir del 409 del gateway. */
  function ocupadoPor(usuarioId: string, desde?: number) {
    const e = new Error('agente_ocupado') as Error & {
      duenio?: { usuarioId?: string; desde?: number };
    };
    e.duenio = { usuarioId, desde };
    return e;
  }

  const OTRO = '11111111-1111-4111-8111-111111111111';

  async function conOcupado(desde?: number) {
    const store = new InMemoryStore();
    store.ponerNombre(OTRO, 'martin');
    const d = deps({
      store,
      ask: vi.fn(async () => {
        throw ocupadoPor(OTRO, desde);
      }),
    });
    await vincular(d.store, 7);
    return d;
  }

  it('no lo reporta como error: es un outcome propio', async () => {
    const d = await conOcupado();
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    expect(r.kind).toBe('ocupado');
  });

  it('dice quien lo tiene, por su nombre', async () => {
    const d = await conOcupado();
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    if (r.kind !== 'ocupado') throw new Error('no es ocupado');
    expect(r.quien).toBe('martin');
    expect(r.agent).toBe('c1');
  });

  // Un aviso sin salida obliga a escribir de nuevo desde cero. El prompt ya
  // esta escrito: lo unico que falta es a quien mandarselo.
  it('siempre ofrece botones para irse a otro agente', async () => {
    const d = await conOcupado();
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    if (r.kind !== 'ocupado') throw new Error('no es ocupado');
    expect(r.botones.length).toBeGreaterThan(0);
  });

  // No saber el nombre degrada el mensaje, no lo voltea.
  it('sin nombre para el dueño, el aviso sale igual', async () => {
    const store = new InMemoryStore();
    const d = deps({
      store,
      ask: vi.fn(async () => {
        throw ocupadoPor(OTRO);
      }),
    });
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    if (r.kind !== 'ocupado') throw new Error('no es ocupado');
    expect(r.quien).toBeUndefined();
  });

  it('pasa el instante en que lo tomaron, para poder decir hace cuanto', async () => {
    const d = await conOcupado(1_700_000_000_000);
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    if (r.kind !== 'ocupado') throw new Error('no es ocupado');
    expect(r.desde).toBe(1_700_000_000_000);
  });
});

describe('quien pide el turno viaja al gateway', () => {
  it('el turno le dice al gateway de quien es', async () => {
    const d = deps();
    await vincular(d.store, 7);
    await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);

    expect(d.ask.mock.calls[0]![1]).toMatchObject({
      usuarioId: USUARIO_DE_PRUEBA,
      chatId: 7,
    });
  });
});

describe('el mensaje que quedo esperando', () => {
  const OTRO = '11111111-1111-4111-8111-111111111111';

  it('se guarda cuando el agente estaba ocupado', async () => {
    const store = new InMemoryStore();
    const d = deps({
      store,
      ask: vi.fn(async () => {
        const e = new Error('agente_ocupado') as Error & { duenio?: { usuarioId?: string } };
        e.duenio = { usuarioId: OTRO };
        throw e;
      }),
    });
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: 'arregla el stock' }, d);
    expect(await store.tomarPendiente(7)).toBe('arregla el stock');
  });

  it('no se guarda nada cuando el turno sale bien', async () => {
    const store = new InMemoryStore();
    const d = deps({ store });
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: 'hola' }, d);
    expect(await store.tomarPendiente(7)).toBeUndefined();
  });

  // Un pendiente se manda UNA vez: dos toques al boton no pueden disparar el
  // mismo turno dos veces.
  it('tomarlo lo borra', async () => {
    const store = new InMemoryStore();
    await store.setPendiente(7, 'hola');
    expect(await store.tomarPendiente(7)).toBe('hola');
    expect(await store.tomarPendiente(7)).toBeUndefined();
  });

  it('el segundo mensaje pisa al primero: vale el ultimo', async () => {
    const store = new InMemoryStore();
    await store.setPendiente(7, 'primero');
    await store.setPendiente(7, 'segundo');
    expect(await store.tomarPendiente(7)).toBe('segundo');
  });
});

describe('/cowork: mas de un agente en el mismo chat', () => {
  it('sin agentes de mas, dice solo a quien le hablas', async () => {
    const d = deps();
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/cowork' }, d);
    expect(r).toEqual({ kind: 'cowork', primario: 'c1', otros: [] });
  });

  it('suma un agente a la lista', async () => {
    const d = deps();
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/cowork c2' }, d);
    expect(r).toEqual({ kind: 'cowork', primario: 'c1', otros: ['c2'] });
  });

  // Es un toggle: sumar y sacar son la misma decision vista dos veces.
  it('el mismo comando otra vez lo saca', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: '/cowork c2' }, d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/cowork c2' }, d);
    expect(r).toEqual({ kind: 'cowork', primario: 'c1', otros: [] });
  });

  // Mostrarlo dos veces no agrega nada y confunde sobre a quien le llega el
  // texto suelto.
  it('el primario no aparece ademas en la lista de al lado', async () => {
    const d = deps();
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/cowork c1' }, d);
    if (r.kind !== 'cowork') throw new Error('no es cowork');
    expect(r.otros).toEqual([]);
  });

  it('/status muestra la misma lista', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: '/cowork c3' }, d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    expect(r).toEqual({ kind: 'status', agent: 'c1', otros: ['c3'] });
  });

  // Lo que hace que cowork sirva: hablarle a uno no cambia a quien le llega el
  // texto suelto. Sin esto habria que estar cambiando de agente todo el tiempo.
  it('hablarle a otro agente no cambia el primario', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: '/c2 arregla el stock' }, d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.agent).toBe('c1');
  });
});

describe('/permisos: cuanto se pregunta antes de actuar', () => {
  it('sin haber elegido nunca, muestra preguntar', async () => {
    const d = deps();
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/permisos' }, d);
    expect(r).toEqual({ kind: 'permisos', modo: 'preguntar', cambiado: false });
  });

  it('cambia el modo y lo confirma', async () => {
    const d = deps();
    await vincular(d.store, 7);

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/permisos todo' }, d);
    expect(r).toEqual({ kind: 'permisos', modo: 'todo', cambiado: true });
  });

  // Confirmar un cambio que no se hizo seria mentir: el mismo outcome contesta
  // a /permisos y a /permisos todo.
  it('consultarlo despues de cambiarlo no dice que se cambio', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: '/permisos todo' }, d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/permisos' }, d);
    expect(r).toEqual({ kind: 'permisos', modo: 'todo', cambiado: false });
  });

  // Lo que hace que todo esto sirva: el modo tiene que LLEGAR al agente, que es
  // quien decide si pregunta.
  it('el modo elegido viaja en el turno', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: '/permisos ediciones' }, d);
    await handleIncoming({ chatId: 7, messageId: 2, text: 'arregla el stock' }, d);

    expect(d.ask.mock.calls[0]![0]).toMatchObject({ modo: 'ediciones' });
  });

  // Sin modo el agente cae en su default, que es el estricto: se pregunta de
  // mas, que es el lado correcto para equivocarse.
  it('sin modo elegido, el turno no manda ninguno', async () => {
    const d = deps();
    await vincular(d.store, 7);

    await handleIncoming({ chatId: 7, messageId: 1, text: 'arregla el stock' }, d);
    expect(d.ask.mock.calls[0]![0].modo).toBeUndefined();
  });

  // Es del chat, no del proyecto: dos personas sobre el mismo proyecto pueden
  // querer distinto y ninguna le impone la suya a la otra.
  it('el modo es de cada chat', async () => {
    const d = deps();
    await vincular(d.store, 7);
    const codigo = await d.store.crearCodigoVinculacion(8, 10);
    await d.store.canjearCodigo(codigo, '22222222-2222-4222-8222-222222222222');

    await handleIncoming({ chatId: 7, messageId: 1, text: '/permisos todo' }, d);
    const otro = await handleIncoming({ chatId: 8, messageId: 1, text: '/permisos' }, d);
    expect(otro).toEqual({ kind: 'permisos', modo: 'preguntar', cambiado: false });
  });
});
