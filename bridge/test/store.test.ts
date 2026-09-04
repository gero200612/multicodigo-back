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

    /**
     * De quien y de que proyecto es un turno.
     *
     * Lo necesita el documento que ESCRIBE el agente: llega por el gateway, que
     * solo conoce el slot, el nombre del proyecto y el `jobId`. La fila de
     * `documentos` pide el UUID del proyecto y el del usuario, y el job es el
     * unico lugar donde los dos ya estan juntos.
     */
    it('el contexto de un job trae el proyecto y el usuario', async () => {
      const jobId = await store.createJob({
        chatId,
        agent: 'c1',
        project: 'demo',
        proyectoId: '11111111-1111-4111-8111-111111111111',
        usuarioId: '22222222-2222-4222-8222-222222222222',
        prompt: 'redacta la sentencia',
        messageId: 1,
      });

      expect(await store.contextoDeJob(jobId)).toEqual({
        proyectoId: '11111111-1111-4111-8111-111111111111',
        usuarioId: '22222222-2222-4222-8222-222222222222',
      });
    });

    it('un job que no existe no tiene contexto', async () => {
      expect(await store.contextoDeJob('99999999-9999-4999-8999-999999999999')).toBeUndefined();
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

    // El mismo hilo, se pregunte desde donde se pregunte: es lo que hace que el
    // panel y Telegram compartan conversacion.
    it('la sesion es por proyecto y agente, no por chat', async () => {
      const proyecto = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await store.setSession(proyecto, 'c1', 'sess-a');
      expect(await store.getSession(proyecto, 'c1')).toBe('sess-a');
    });

    it('agentes distintos del mismo proyecto tienen sesiones distintas', async () => {
      const proyecto = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await store.setSession(proyecto, 'c1', 'sess-a');
      await store.setSession(proyecto, 'c2', 'sess-b');
      expect(await store.getSession(proyecto, 'c1')).toBe('sess-a');
      expect(await store.getSession(proyecto, 'c2')).toBe('sess-b');
    });

    it('el mismo agente en otro proyecto es otra sesion', async () => {
      const uno = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const otro = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await store.setSession(uno, 'c1', 'sess-a');
      await store.setSession(otro, 'c1', 'sess-b');
      expect(await store.getSession(uno, 'c1')).toBe('sess-a');
      expect(await store.getSession(otro, 'c1')).toBe('sess-b');
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

    it('un chat sin vincular no tiene usuario', async () => {
      expect(await store.usuarioDeChat(123)).toBeUndefined();
    });

    it('canjear un codigo vincula el chat al usuario', async () => {
      const usuario = '77777777-7777-4777-8777-777777777777';
      const codigo = await store.crearCodigoVinculacion(123, 10);

      expect(await store.canjearCodigo(codigo, usuario)).toBe('ok');
      expect(await store.usuarioDeChat(123)).toBe(usuario);
    });

    it('un codigo no se puede canjear dos veces', async () => {
      const codigo = await store.crearCodigoVinculacion(124, 10);
      await store.canjearCodigo(codigo, '77777777-7777-4777-8777-777777777777');

      expect(await store.canjearCodigo(codigo, '88888888-8888-4888-8888-888888888888'))
        .toBe('usado');
      // Y el chat sigue siendo del primero.
      expect(await store.usuarioDeChat(124)).toBe('77777777-7777-4777-8777-777777777777');
    });

    it('un codigo vencido no sirve', async () => {
      const codigo = await store.crearCodigoVinculacion(125, -1);
      expect(await store.canjearCodigo(codigo, '77777777-7777-4777-8777-777777777777'))
        .toBe('vencido');
      expect(await store.usuarioDeChat(125)).toBeUndefined();
    });

    it('un codigo que no existe se distingue de uno usado', async () => {
      expect(await store.canjearCodigo('NOEXISTE', '77777777-7777-4777-8777-777777777777'))
        .toBe('desconocido');
    });
  },
);

describe('InMemoryStore', () => {
  it('deleteSessions borra las sesiones de un agente y deja las de los otros', async () => {
    const store = new InMemoryStore();
    const uno = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otro = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await store.setSession(uno, 'c1', 's-c1-uno');
    await store.setSession(otro, 'c1', 's-c1-otro');
    await store.setSession(uno, 'c2', 's-c2-uno');

    expect(await store.deleteSessions('c1')).toBe(2);
    expect(await store.getSession(uno, 'c1')).toBeUndefined();
    expect(await store.getSession(otro, 'c1')).toBeUndefined();
    expect(await store.getSession(uno, 'c2')).toBe('s-c2-uno');
  });

  it('deleteSessions de un agente sin sesiones no es un error', async () => {
    const store = new InMemoryStore();
    expect(await store.deleteSessions('c1')).toBe(0);
  });
});

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
  '009_agentes_insert.sql',
  '010_realtime.sql',
  '011_proyectos_rpc.sql',
  '012_aprobaciones.sql',
  '013_sesiones_por_proyecto.sql',
  '014_vinculos_visibles.sql',
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

  // PgStore es el que corre en produccion; InMemoryStore es solo para tests. Sin
  // este caso, un DELETE con la columna mal escrita o la condicion invertida no
  // lo detecta nadie hasta que se pierdan sesiones de verdad.
  it('deleteSessions borra las filas de ese agente en la tabla real', async () => {
    const pool = store['pool'];
    // La tabla tiene FK contra proyectos: la fila tiene que existir.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre) VALUES ('plan8-demo') RETURNING id`,
    );
    const proyectoId = rows[0]!.id;

    await store.setSession(proyectoId, 'c1', 's-c1');
    await store.setSession(proyectoId, 'c2', 's-c2');

    expect(await store.deleteSessions('c1')).toBe(1);
    expect(await store.getSession(proyectoId, 'c1')).toBeUndefined();
    expect(await store.getSession(proyectoId, 'c2')).toBe('s-c2');

    await pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
  });

  // La clave nueva: el mismo hilo se pregunte desde donde se pregunte.
  it('la sesion es del proyecto y el agente en la tabla real', async () => {
    const pool = store['pool'];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre) VALUES ('plan8-hilo') RETURNING id`,
    );
    const proyectoId = rows[0]!.id;

    await store.setSession(proyectoId, 'c1', 'sess-a');
    // Un segundo set del mismo par pisa, no duplica: el ON CONFLICT es sobre la
    // clave nueva, y si no coincidiera con la PK esto tiraria.
    await store.setSession(proyectoId, 'c1', 'sess-b');

    expect(await store.getSession(proyectoId, 'c1')).toBe('sess-b');

    await pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
  });

  // Sin proyecto_id lleno, todo lo que filtra por proyecto queda afuera: la
  // policy de RLS, el filtro de Realtime del panel en vivo y la aprobacion, que
  // lo hereda del job. Y no hay ningun error que lo explique.
  it('el job y su aprobacion heredan el proyecto', async () => {
    const pool = store['pool'];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO proyectos (nombre) VALUES ('plan7-demo') RETURNING id`,
    );
    const proyectoId = rows[0]!.id;

    const jobId = await store.createJob({
      chatId: 999,
      agent: 'c1',
      project: 'plan7-demo',
      prompt: 'hola',
      messageId: 1,
    });

    const job = await pool.query<{ proyecto_id: string }>(
      'SELECT proyecto_id FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job.rows[0]!.proyecto_id).toBe(proyectoId);

    const aprobacion = '66666666-6666-4666-8666-666666666666';
    await store.recordApproval({
      approvalId: aprobacion,
      jobId,
      chatId: 999,
      messageId: 1,
      agent: 'c1',
      tool: 'Write',
      summary: 'escribo a.ts',
    });

    const ap = await pool.query<{ proyecto_id: string }>(
      'SELECT proyecto_id FROM approvals WHERE approval_id = $1',
      [aprobacion],
    );
    expect(ap.rows[0]!.proyecto_id).toBe(proyectoId);

    await pool.query('DELETE FROM approvals WHERE approval_id = $1', [aprobacion]);
    await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    await pool.query('DELETE FROM proyectos WHERE id = $1', [proyectoId]);
  });

  // Un proyecto que no esta en la tabla —los de config/projects.json, que
  // todavia no se crearon desde el panel— no puede impedir que el turno corra.
  it('un proyecto que no existe deja el job sin proyecto, pero lo crea', async () => {
    const pool = store['pool'];
    const jobId = await store.createJob({
      chatId: 999,
      agent: 'c1',
      project: 'no-existe-este',
      prompt: 'hola',
      messageId: 1,
    });

    const { rows } = await pool.query<{ proyecto_id: string | null }>(
      'SELECT proyecto_id FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]!.proyecto_id).toBeNull();

    await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]);
  });

  // Las columnas nuevas de la 012. El CHECK importa: `decidido_desde` decide
  // que se le muestra al usuario ("lo decidiste desde el panel"), y un valor
  // que nadie espera no se ve hasta que alguien mira la pantalla.
  it('la aprobacion guarda quien decidio y desde donde', async () => {
    const pool = store['pool'];
    const id = '55555555-5555-4555-8555-555555555555';
    await pool.query(
      `INSERT INTO approvals (approval_id, job_id, chat_id, message_id, agent, tool, summary)
       VALUES ($1, $1, 999, 1, 'c1', 'Write', 'escribo a.ts')`,
      [id],
    );

    await pool.query(
      `UPDATE approvals SET decision='allow', decidido_por=gen_random_uuid(),
              decidido_desde='panel', decided_at=now() WHERE approval_id=$1`,
      [id],
    );

    const { rows } = await pool.query<{ decidido_desde: string }>(
      `SELECT decidido_desde FROM approvals WHERE approval_id=$1`,
      [id],
    );
    expect(rows[0]!.decidido_desde).toBe('panel');

    await expect(
      pool.query(`UPDATE approvals SET decidido_desde='fax' WHERE approval_id=$1`, [id]),
    ).rejects.toThrow(/approvals_desde_valido/);

    await pool.query(`DELETE FROM approvals WHERE approval_id=$1`, [id]);
  });

  afterAll(async () => {
    if (store) {
      await store['pool'].query('DELETE FROM chat_state WHERE chat_id = 999');
      await store['pool'].query('DELETE FROM agent_session WHERE chat_id = 999');
    }
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

/**
 * Desvincular un chat de Telegram.
 *
 * Faltaba: se podia vincular y nunca desatar, asi que un chat quedaba pegado a
 * la cuenta para siempre —y con el, quien pudiera escribirle al bot desde ahi—.
 */
describe('desvincular un chat', () => {
  const USUARIO = '99999999-9999-4999-8999-999999999999';
  const OTRO = '11111111-1111-4111-8111-111111111111';

  async function conVinculo(store: InMemoryStore, chatId: number, usuarioId: string) {
    const codigo = await store.crearCodigoVinculacion(chatId, 10);
    await store.canjearCodigo(codigo, usuarioId);
  }

  it('borra el vinculo y lo dice', async () => {
    const store = new InMemoryStore();
    await conVinculo(store, 7, USUARIO);

    expect(await store.desvincularChat(7, USUARIO)).toBe(true);
    expect(await store.usuarioDeChat(7)).toBeUndefined();
  });

  // Lo que impide que alguien con sesion desate el chat de otro pasando su id.
  it('no borra el chat de otra persona', async () => {
    const store = new InMemoryStore();
    await conVinculo(store, 7, USUARIO);

    expect(await store.desvincularChat(7, OTRO)).toBe(false);
    expect(await store.usuarioDeChat(7)).toBe(USUARIO);
  });

  it('un chat que no existe no rompe', async () => {
    const store = new InMemoryStore();
    expect(await store.desvincularChat(999, USUARIO)).toBe(false);
  });

  // Volver a vincularlo tiene que funcionar: desvincular no puede dejar el chat
  // en un estado del que no se sale.
  it('se puede volver a vincular despues', async () => {
    const store = new InMemoryStore();
    await conVinculo(store, 7, USUARIO);
    await store.desvincularChat(7, USUARIO);
    await conVinculo(store, 7, OTRO);

    expect(await store.usuarioDeChat(7)).toBe(OTRO);
  });
});

/**
 * Cuanto consumio cada agente en la ventana de 5 horas.
 *
 * Anthropic no publica cuanta cuota queda, asi que "que porcentaje va" no tiene
 * respuesta: no hay total contra el cual dividir. Lo medible es lo gastado, y
 * la ventana de 5h es la misma que usa Anthropic para su limite — sumar sobre
 * ella es lo que hace que el numero se pueda comparar con algo.
 */
describe('el consumo por agente', () => {
  it('suma los tokens y el costo de cada agente', async () => {
    const store = new InMemoryStore();
    const a = await store.createJob({
      chatId: 1, agent: 'c1', project: 'p', usuarioId: 'u', origen: 'telegram',
      prompt: 'x', messageId: 0,
    });
    const b = await store.createJob({
      chatId: 1, agent: 'c1', project: 'p', usuarioId: 'u', origen: 'telegram',
      prompt: 'y', messageId: 0,
    });
    await store.finishJob(a, 'done', undefined, 'ok', { tokens: 1000, costoUsd: 0.02 });
    await store.finishJob(b, 'done', undefined, 'ok', { tokens: 500, costoUsd: 0.01 });

    const c = await store.consumoPorAgente();
    expect(c.get('c1')).toEqual({ tokens: 1500, costoUsd: 0.03 });
  });

  it('separa por agente', async () => {
    const store = new InMemoryStore();
    const a = await store.createJob({
      chatId: 1, agent: 'c1', project: 'p', usuarioId: 'u', origen: 'telegram',
      prompt: 'x', messageId: 0,
    });
    const b = await store.createJob({
      chatId: 1, agent: 'c2', project: 'p', usuarioId: 'u', origen: 'telegram',
      prompt: 'y', messageId: 0,
    });
    await store.finishJob(a, 'done', undefined, 'ok', { tokens: 100, costoUsd: 0.001 });
    await store.finishJob(b, 'done', undefined, 'ok', { tokens: 900, costoUsd: 0.009 });

    const c = await store.consumoPorAgente();
    expect(c.get('c1')?.tokens).toBe(100);
    expect(c.get('c2')?.tokens).toBe(900);
  });

  // Un turno sin datos de uso —un SDK viejo, o uno que fallo— no puede
  // ensuciar la suma con un NaN.
  it('ignora los turnos sin datos de consumo', async () => {
    const store = new InMemoryStore();
    const a = await store.createJob({
      chatId: 1, agent: 'c1', project: 'p', usuarioId: 'u', origen: 'telegram',
      prompt: 'x', messageId: 0,
    });
    await store.finishJob(a, 'done', undefined, 'ok');

    expect(await store.consumoPorAgente()).toEqual(new Map());
  });

  it('un agente que no trabajo no aparece', async () => {
    const store = new InMemoryStore();
    expect((await store.consumoPorAgente()).get('c9')).toBeUndefined();
  });
});

/**
 * Los documentos de un proyecto salen del store, no de la API REST.
 *
 * Estaban detras de `SUPABASE_SERVICE_KEY` porque se leian por HTTP con la
 * service_role. El bridge ya se conecta a la MISMA base como `postgres` —sin
 * RLS— asi que esa clave era un rodeo: sin ella los documentos quedaban
 * apagados enteros y el agente no veia ningun archivo, ni del panel ni del bot.
 */
describe('los documentos de un proyecto', () => {
  const PROYECTO = 'd1b03617-c358-4da1-a94c-266bfcc66e6a';

  it('sin documentos devuelve una lista vacia', async () => {
    const store = new InMemoryStore();
    expect(await store.documentosDeProyecto(PROYECTO)).toEqual([]);
  });

  it('devuelve nombre y rutas de los que hay', async () => {
    const store = new InMemoryStore();
    store.ponerDocumento(PROYECTO, {
      nombre: 'pliego.pdf',
      ruta: `${PROYECTO}/pliego.pdf`,
      ruta_texto: `${PROYECTO}/pliego.pdf.md`,
    });

    expect(await store.documentosDeProyecto(PROYECTO)).toEqual([
      { nombre: 'pliego.pdf', ruta: `${PROYECTO}/pliego.pdf`, ruta_texto: `${PROYECTO}/pliego.pdf.md` },
    ]);
  });

  // Un documento de otro proyecto no puede aparecer en este turno: el agente
  // trabaja sobre un worktree y solo le corresponden los suyos.
  it('no mezcla los de otro proyecto', async () => {
    const store = new InMemoryStore();
    store.ponerDocumento(PROYECTO, { nombre: 'mio.pdf', ruta: 'a/mio.pdf' });
    store.ponerDocumento('otro-id', { nombre: 'ajeno.pdf', ruta: 'b/ajeno.pdf' });

    const docs = await store.documentosDeProyecto(PROYECTO);
    expect(docs.map((d) => d.nombre)).toEqual(['mio.pdf']);
  });

  // Un PDF que el conversor no pudo leer viaja igual: el agente no lo puede
  // leer pero lo puede citar, y el original se descarga del panel.
  it('un documento sin .md viaja igual', async () => {
    const store = new InMemoryStore();
    store.ponerDocumento(PROYECTO, { nombre: 'foto.pdf', ruta: 'a/foto.pdf', ruta_texto: null });

    const docs = await store.documentosDeProyecto(PROYECTO);
    expect(docs[0]!.ruta_texto).toBeNull();
  });
});

/**
 * La fila del documento se escribe por el store, no por la API REST.
 *
 * Era lo ultimo que ataba los documentos a `SUPABASE_SERVICE_KEY`: el archivo
 * ya iba al disco, pero la fila se mandaba por HTTP con esa clave. Sin ella el
 * bot aceptaba el archivo y no lo podia registrar, asi que subir por Telegram
 * quedaba apagado igual.
 */
describe('guardar la fila de un documento', () => {
  const PROYECTO = 'd1b03617-c358-4da1-a94c-266bfcc66e6a';
  const USUARIO = '99999999-9999-4999-8999-999999999999';

  const FILA = {
    proyectoId: PROYECTO,
    nombre: 'pliego.pdf',
    nombreOriginal: 'Pliego Final.pdf',
    ruta: `${PROYECTO}/pliego.pdf`,
    rutaTexto: `${PROYECTO}/pliego.pdf.md`,
    tipo: 'pdf',
    bytes: 1234,
    subidoPor: USUARIO,
  };

  it('lo deja disponible para el turno', async () => {
    const store = new InMemoryStore();
    await store.guardarDocumento(FILA);

    expect(await store.documentosDeProyecto(PROYECTO)).toEqual([
      { nombre: 'pliego.pdf', ruta: FILA.ruta, ruta_texto: FILA.rutaTexto },
    ]);
  });

  // Mandar de nuevo el mismo archivo lo reemplaza: es lo que espera quien
  // manda una version corregida, no un duplicado.
  it('el mismo nombre dos veces reemplaza en vez de duplicar', async () => {
    const store = new InMemoryStore();
    await store.guardarDocumento(FILA);
    await store.guardarDocumento({ ...FILA, bytes: 999 });

    expect(await store.documentosDeProyecto(PROYECTO)).toHaveLength(1);
  });

  // Un PDF que el conversor no pudo leer se guarda igual, con el motivo: perder
  // el archivo que la persona ya mando es peor que no poder convertirlo.
  it('guarda el que no se pudo convertir, con su error', async () => {
    const store = new InMemoryStore();
    await store.guardarDocumento({
      ...FILA, rutaTexto: null, error: 'el PDF es un escaneo',
    });

    const docs = await store.documentosDeProyecto(PROYECTO);
    expect(docs[0]!.ruta_texto).toBeNull();
  });
});
