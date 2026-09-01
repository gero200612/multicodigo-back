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
