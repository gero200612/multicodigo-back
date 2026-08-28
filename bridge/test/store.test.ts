import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
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
        agent: 'c1' as const,
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
        agent: 'c1' as const,
        project: 'x',
        prompt: 'y',
        messageId: 1,
      });
      await store.finishJob(id, 'failed', 'agent_unavailable');
      expect(await store.getJobStatus(id)).toBe('failed');
      expect(await store.getJobError(id)).toBe('agent_unavailable');
    });

    it('sin membresias no hay proyectos', async () => {
      expect(await store.proyectosDeUsuario('55555555-5555-4555-8555-555555555555'))
        .toEqual([]);
    });

    it('devuelve los proyectos del usuario ordenados por nombre', async () => {
      const usuario = '55555555-5555-4555-8555-555555555555';
      const b = await store.crearProyecto('zeta', usuario);
      const a = await store.crearProyecto('alfa', usuario);

      const proyectos = await store.proyectosDeUsuario(usuario);
      expect(proyectos.map((p) => p.nombre)).toEqual(['alfa', 'zeta']);
      expect(proyectos.map((p) => p.id)).toEqual([a, b]);
    });

    it('no devuelve proyectos de otro usuario', async () => {
      const mio = '55555555-5555-4555-8555-555555555555';
      const ajeno = '66666666-6666-4666-8666-666666666666';
      await store.crearProyecto('mio', mio);

      expect(await store.proyectosDeUsuario(ajeno)).toEqual([]);
    });

    it('lista los agentes de un proyecto ordenados por slot', async () => {
      const usuario = '55555555-5555-4555-8555-555555555555';
      const proyecto = await store.crearProyecto('con-agentes', usuario);
      await store.registrarAgente(proyecto, 'c2', 'Frontend');
      await store.registrarAgente(proyecto, 'c1', 'Backend');

      const agentes = await store.agentesDeProyecto(proyecto);
      expect(agentes.map((a) => a.slot)).toEqual(['c1', 'c2']);
      expect(agentes[0]!.nombre).toBe('Backend');
    });
  },
);

const url = process.env.DATABASE_URL;

/**
 * Las rutas se resuelven contra ESTE archivo y no contra el working directory:
 * un 'migrations/001_init.sql' relativo solo funciona si vitest corre parado en
 * `bridge/`. Antes decian 'src/bridge/migrations/...', que era la ruta de
 * cuando el bridge vivia en el monorepo, y como el bloque se saltea sin
 * DATABASE_URL nadie lo noto.
 */
const migracion = (nombre: string) =>
  fileURLToPath(new URL('../migrations/' + nombre, import.meta.url));

const TODAS_LAS_MIGRACIONES = [
  '001_init.sql',
  '002_approvals.sql',
  '003_multiproyecto.sql',
  '004_proyectos.sql',
  '005_agentes.sql',
  '006_telegram.sql',
  '007_jobs.sql',
  '008_rls.sql',
].map(migracion);

describe.skipIf(!url)('PgStore contra postgres real', () => {
  let store: PgStore;

  it('aplica la migracion y persiste el agente activo', async () => {
    store = await PgStore.connect(url!, TODAS_LAS_MIGRACIONES);
    await store.setActiveAgent(999, 'c2');
    expect(await store.getActiveAgent(999)).toBe('c2');
  });

  it('crea un proyecto con su dueño y rechaza un nombre con barra', async () => {
    const pool = store['pool'];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre, repo_url, tareas)
       VALUES ('plan1-demo', 'git@github.com:ejemplo/demo.git', '{"test":["pnpm","test"]}'::jsonb)
       RETURNING id`,
    );
    const proyectoId = rows[0]!.id;
    expect(proyectoId).toMatch(/^[0-9a-f-]{36}$/);

    // El nombre viaja a una ruta de filesystem: una barra lo sacaria de /srv/work.
    await expect(
      pool.query(`INSERT INTO proyectos (nombre) VALUES ('con/barra')`),
    ).rejects.toThrow(/proyectos_nombre_forma/);

    // El rol es cerrado: sólo dueño o miembro.
    await expect(
      pool.query(
        `INSERT INTO miembros (proyecto_id, usuario_id, rol)
         VALUES ($1, gen_random_uuid(), 'jefe')`,
        [proyectoId],
      ),
    ).rejects.toThrow(/miembros_rol_valido/);

    await pool.query(`DELETE FROM proyectos WHERE id = $1`, [proyectoId]);
  });

  it('un agente pertenece a un proyecto y su slot respeta AgentId', async () => {
    const pool = store['pool'];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre) VALUES ('plan1-agentes') RETURNING id`,
    );
    const proyectoId = rows[0]!.id;

    await pool.query(
      `INSERT INTO agentes (slot, proyecto_id, nombre) VALUES ('c7', $1, 'Backend')`,
      [proyectoId],
    );

    const { rows: leidos } = await pool.query<{ nombre: string }>(
      `SELECT nombre FROM agentes WHERE slot = 'c7'`,
    );
    expect(leidos[0]!.nombre).toBe('Backend');

    // 'c0' no es un slot valido: el regex de AgentId prohibe el cero.
    await expect(
      pool.query(`INSERT INTO agentes (slot, proyecto_id) VALUES ('c0', $1)`, [proyectoId]),
    ).rejects.toThrow(/agentes_slot_forma/);

    // Borrar el proyecto se lleva sus agentes: un slot huerfano no significa nada.
    await pool.query(`DELETE FROM proyectos WHERE id = $1`, [proyectoId]);
    const { rows: quedan } = await pool.query(`SELECT 1 FROM agentes WHERE slot = 'c7'`);
    expect(quedan).toHaveLength(0);
  });

  it('un chat de telegram se vincula a un solo usuario', async () => {
    const pool = store['pool'];
    const usuario = '33333333-3333-4333-8333-333333333333';

    await pool.query(
      `INSERT INTO telegram_vinculos (chat_id, usuario_id) VALUES (777, $1)`,
      [usuario],
    );

    // El chat es la clave: un segundo vinculo del mismo chat es un conflicto,
    // no una segunda fila. Si no, un chat podria hablar por dos personas.
    await expect(
      pool.query(
        `INSERT INTO telegram_vinculos (chat_id, usuario_id) VALUES (777, gen_random_uuid())`,
      ),
    ).rejects.toThrow(/duplicate key/);

    await pool.query(`DELETE FROM telegram_vinculos WHERE chat_id = 777`);
  });

  it('un codigo de vinculacion se usa una sola vez', async () => {
    const pool = store['pool'];
    await pool.query(
      `INSERT INTO telegram_codigos (codigo, chat_id, expira_en)
       VALUES ('ABC12345', 777, now() + interval '10 minutes')`,
    );

    // Marcarlo usado es una transicion de NULL a no-NULL, y sólo la gana uno:
    // es la misma idempotencia que ya usan las aprobaciones.
    const primero = await pool.query(
      `UPDATE telegram_codigos SET usado_en = now()
       WHERE codigo = 'ABC12345' AND usado_en IS NULL RETURNING chat_id`,
    );
    expect(primero.rowCount).toBe(1);

    const segundo = await pool.query(
      `UPDATE telegram_codigos SET usado_en = now()
       WHERE codigo = 'ABC12345' AND usado_en IS NULL RETURNING chat_id`,
    );
    expect(segundo.rowCount).toBe(0);

    await pool.query(`DELETE FROM telegram_codigos WHERE codigo = 'ABC12345'`);
  });

  it('un job guarda de quien es, de donde vino y que contesto el agente', async () => {
    const pool = store['pool'];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre) VALUES ('plan1-jobs') RETURNING id`,
    );
    const proyectoId = rows[0]!.id;
    const jobId = '44444444-4444-4444-8444-444444444444';

    await pool.query(
      `INSERT INTO jobs (id, chat_id, agent, project, prompt, status,
                         proyecto_id, usuario_id, origen, respuesta)
       VALUES ($1, 1, 'c1', 'plan1-jobs', 'hola', 'done',
               $2, gen_random_uuid(), 'telegram', 'hola, en que te ayudo')`,
      [jobId, proyectoId],
    );

    const { rows: leidos } = await pool.query<{ origen: string; respuesta: string }>(
      `SELECT origen, respuesta FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(leidos[0]!.origen).toBe('telegram');
    expect(leidos[0]!.respuesta).toBe('hola, en que te ayudo');

    // El origen es cerrado: o vino del bot o vino del panel.
    await expect(
      pool.query(`UPDATE jobs SET origen = 'sms' WHERE id = $1`, [jobId]),
    ).rejects.toThrow(/jobs_origen_valido/);

    await pool.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
    await pool.query(`DELETE FROM proyectos WHERE id = $1`, [proyectoId]);
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

describe('estados del job (spec §5)', () => {
  it('un job nace en running', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    expect(await s.getJobStatus(id)).toBe('running');
  });

  // Sin esto, la tabla dice 'running' mientras el agente lleva 10 minutos
  // esperando un OK: no se puede distinguir "pensando" de "trabado".
  it('marca awaiting_approval sin cerrar el job', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    await s.setJobStatus(id, 'awaiting_approval');
    expect(await s.getJobStatus(id)).toBe('awaiting_approval');
  });

  it('marca awaiting_build mientras hace cola', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    await s.setJobStatus(id, 'awaiting_build');
    expect(await s.getJobStatus(id)).toBe('awaiting_build');
  });

  it('vuelve a running cuando la aprobacion se resuelve', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    await s.setJobStatus(id, 'awaiting_approval');
    await s.setJobStatus(id, 'running');
    expect(await s.getJobStatus(id)).toBe('running');
  });

  it('finishJob cierra con done y no lo revive setJobStatus', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    await s.finishJob(id, 'done');
    // Un estado transitorio que llega tarde —el poller vio una aprobacion
    // justo cuando el turno terminaba— no puede reabrir un job cerrado.
    await s.setJobStatus(id, 'awaiting_approval');
    expect(await s.getJobStatus(id)).toBe('done');
  });

  it('tampoco revive un job que fallo', async () => {
    const s = new InMemoryStore();
    const id = await s.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 2 });
    await s.finishJob(id, 'failed', 'agent_unavailable');
    await s.setJobStatus(id, 'running');
    expect(await s.getJobStatus(id)).toBe('failed');
  });

  it('setJobStatus sobre un job que no existe no rompe', async () => {
    const s = new InMemoryStore();
    await expect(s.setJobStatus('no-existe', 'running')).resolves.toBeUndefined();
  });
});

describe('proyecto activo por chat', () => {
  it('sin estado previo no hay proyecto activo', async () => {
    expect(await new InMemoryStore().getActiveProject(7)).toBeUndefined();
  });

  it('guarda y devuelve el proyecto activo', async () => {
    const s = new InMemoryStore();
    await s.setActiveProject(7, 'sincroresto');
    expect(await s.getActiveProject(7)).toBe('sincroresto');
  });

  it('lo sobreescribe', async () => {
    const s = new InMemoryStore();
    await s.setActiveProject(7, 'uno');
    await s.setActiveProject(7, 'dos');
    expect(await s.getActiveProject(7)).toBe('dos');
  });

  // Cada chat lleva el suyo, igual que el agente activo.
  it('es por chat', async () => {
    const s = new InMemoryStore();
    await s.setActiveProject(7, 'uno');
    await s.setActiveProject(8, 'dos');
    expect(await s.getActiveProject(7)).toBe('uno');
    expect(await s.getActiveProject(8)).toBe('dos');
  });
});

describe('recentJobs', () => {
  it('devuelve los mas nuevos primero', async () => {
    const store = new InMemoryStore();
    const a = await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'uno', messageId: 1 });
    const b = await store.createJob({ chatId: 1, agent: 'c2' as const, project: 'demo', prompt: 'dos', messageId: 1 });
    const jobs = await store.recentJobs(10);
    expect(jobs.map((j) => j.id)).toEqual([b, a]);
  });

  it('respeta el limite', async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: `p${i}`, messageId: 1 });
    }
    expect(await store.recentJobs(3)).toHaveLength(3);
  });

  it('trae el estado y el agente de cada uno', async () => {
    const store = new InMemoryStore();
    const id = await store.createJob({ chatId: 7, agent: 'c2' as const, project: 'sincroresto', prompt: 'que hace el stock', messageId: 1 });
    await store.setJobStatus(id, 'awaiting_approval');
    const [job] = await store.recentJobs(1);
    expect(job).toMatchObject({
      id,
      agent: 'c2' as const,
      project: 'sincroresto',
      status: 'awaiting_approval',
      prompt: 'que hace el stock',
    });
    expect(typeof job!.createdAt).toBe('string');
  });

  // El prompt puede ser largo y esto se muestra en una lista. Cortarlo en el
  // store y no en el front evita mandar kilobytes por cada refresco.
  it('recorta el prompt', async () => {
    const store = new InMemoryStore();
    await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x'.repeat(500), messageId: 1 });
    const [job] = await store.recentJobs(1);
    expect(job!.prompt.length).toBeLessThanOrEqual(160);
  });
});
