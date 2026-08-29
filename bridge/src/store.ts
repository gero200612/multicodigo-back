import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AgentId, ApprovalDecision } from '@multicodigo/shared';

/**
 * Los estados del spec 5.
 *
 * Los transitorios (running, awaiting_*) cuentan donde esta parado el turno;
 * los finales (done, failed) lo cierran. La distincion importa: sin
 * awaiting_approval la tabla dice 'running' mientras el agente lleva diez
 * minutos esperando un OK, y no hay forma de distinguir 'pensando' de
 * 'trabado'.
 */
export type JobStatus =
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_build'
  | 'done'
  | 'failed';

/** Estados que cierran el job. Un job cerrado ya no vuelve a moverse. */
const ESTADOS_FINALES: readonly JobStatus[] = ['done', 'failed'];

export type ClaimResult = 'claimed' | 'already_decided' | 'unknown';

/**
 * Una aprobacion, del lado del bridge.
 *
 * El registro del hijo se pierde si el contenedor reinicia; esta tabla es la
 * que hace que el boton siga siendo idempotente igual, porque Render sobrevive
 * a ese reinicio. Guarda chat y mensaje para poder contestar en el lugar
 * correcto cuando la decision llega minutos despues.
 */
export interface ApprovalRecord {
  approvalId: string;
  jobId: string;
  chatId: number;
  messageId: number;
  agent: AgentId;
  tool: string;
  summary: string;
}

export interface NewJob {
  chatId: number;
  agent: AgentId;
  project: string;
  prompt: string;
  messageId: number;
}

/**
 * Un job para mostrar en el panel. NO es la fila entera de `jobs`: el prompt
 * viene recortado y el chat_id no viaja.
 */
export interface JobResumen {
  id: string;
  agent: string;
  project: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  error?: string;
}

/** El prompt se muestra en una lista; mandarlo entero seria kilobytes por refresco. */
export const LARGO_PROMPT_RESUMEN = 160;

export function recortar(texto: string): string {
  return texto.length <= LARGO_PROMPT_RESUMEN
    ? texto
    : `${texto.slice(0, LARGO_PROMPT_RESUMEN - 1)}…`;
}

export interface Proyecto {
  id: string;
  nombre: string;
}

export interface AgenteResumen {
  slot: AgentId;
  nombre?: string;
  cuenta?: string;
}

/**
 * Un codigo corto que una persona pueda leer de la pantalla del celular y
 * tipear en el navegador.
 *
 * Sin I, O, 0 ni 1: son los que se confunden al copiar a mano. Ocho caracteres
 * de este alfabeto son ~41 bits, de sobra para algo que vence en diez minutos.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codigoLegible(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join('');
}

export interface Store {
  getActiveAgent(chatId: number): Promise<AgentId | undefined>;
  setActiveAgent(chatId: number, agent: AgentId): Promise<void>;
  /**
   * El proyecto activo del chat. Como el agente activo, queda pegado hasta que
   * se lo cambie.  = usar el DEFAULT_PROJECT del bridge.
   */
  /**
   * El proyecto activo del chat. Como el agente activo, queda pegado hasta que
   * se lo cambie; `undefined` significa "usar el DEFAULT_PROJECT del bridge".
   */
  getActiveProject(chatId: number): Promise<string | undefined>;
  setActiveProject(chatId: number, project: string): Promise<void>;
  getSession(chatId: number, agent: AgentId, project: string): Promise<string | undefined>;
  setSession(chatId: number, agent: AgentId, project: string, sessionId: string): Promise<void>;
  /**
   * Borra todas las sesiones de un agente. Devuelve cuantas borro.
   *
   * Se llama cuando se saca o se rota la cuenta de un slot: los session_id
   * apuntan a transcripts que viven en el volumen de ESA cuenta, y con la
   * cuenta nueva ya no existen. Sin esto, el proximo mensaje falla en el resume
   * con un error que no le dice nada a nadie.
   */
  deleteSessions(agent: AgentId): Promise<number>;
  createJob(job: NewJob): Promise<string>;
  /**
   * Las ultimas peticiones, de la mas nueva a la mas vieja.
   *
   * Es la vista de "que le vengo pidiendo al sistema" del panel. Sale de la
   * misma tabla que usa el flujo de Telegram, asi que no hay un segundo
   * registro que se pueda desincronizar.
   */
  recentJobs(limite: number): Promise<JobResumen[]>;
  finishJob(jobId: string, status: JobStatus, error?: string): Promise<void>;
  /**
   * Mueve un job entre estados transitorios. No reabre uno ya cerrado: un
   * estado que llega tarde —el poller vio una aprobacion justo cuando el turno
   * terminaba— no puede revivir un job en done.
   */
  setJobStatus(jobId: string, status: JobStatus): Promise<void>;
  getJobStatus(jobId: string): Promise<JobStatus | undefined>;
  getJobError(jobId: string): Promise<string | undefined>;
  /** true si es la primera vez que se ve esta aprobacion (o sea: hay que anunciarla). */
  recordApproval(rec: ApprovalRecord): Promise<boolean>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /**
   * Toma la decision de forma atomica. Solo el primer llamado gana.
   *
   * `quien` es opcional porque la decision desde Telegram no tiene un usuario
   * del panel detras hasta que el chat este vinculado, y no vale la pena
   * bloquear una aprobacion por no saber a quien anotar.
   */
  claimApproval(
    approvalId: string,
    decision: ApprovalDecision,
    quien?: { usuarioId?: string; desde: 'telegram' | 'panel' },
  ): Promise<ClaimResult>;
  setAwaitingFeedback(chatId: number, approvalId: string | null): Promise<void>;
  getAwaitingFeedback(chatId: number): Promise<string | undefined>;
  /**
   * Los proyectos donde el usuario es miembro, por nombre.
   *
   * Ordenados para que el menu del bot no cambie el orden de los botones entre
   * dos llamados: un boton que se mueve solo es un toque equivocado.
   */
  proyectosDeUsuario(usuarioId: string): Promise<Proyecto[]>;
  /** Crea el proyecto y deja a quien lo crea como dueño. Devuelve su id. */
  crearProyecto(nombre: string, dueñoId: string): Promise<string>;
  /** Los agentes del proyecto, por slot. */
  agentesDeProyecto(proyectoId: string): Promise<AgenteResumen[]>;
  /** Anota que el slot pertenece al proyecto. NO crea el contenedor. */
  registrarAgente(proyectoId: string, slot: AgentId, nombre?: string): Promise<void>;
  /** El usuario del panel dueño de este chat, o undefined si no esta vinculado. */
  usuarioDeChat(chatId: number): Promise<string | undefined>;
  /** Un codigo de un solo uso para vincular este chat. */
  crearCodigoVinculacion(chatId: number, minutos: number): Promise<string>;
  /**
   * Canjea el codigo a nombre del usuario.
   *
   * Distingue los tres modos de falla porque el panel los explica distinto:
   * "pedí uno nuevo" no es lo mismo que "ese ya lo usaste".
   */
  canjearCodigo(
    codigo: string,
    usuarioId: string,
  ): Promise<'ok' | 'vencido' | 'usado' | 'desconocido'>;
}

export class InMemoryStore implements Store {
  private active = new Map<number, AgentId>();
  private activeProject = new Map<number, string>();
  private sessions = new Map<string, string>();
  private jobs = new Map<string, { status: JobStatus; error?: string; resumen?: JobResumen }>();

  private key(chatId: number, agent: AgentId, project: string) {
    return `${chatId}:${agent}:${project}`;
  }

  async getActiveAgent(chatId: number) {
    return this.active.get(chatId);
  }
  async setActiveAgent(chatId: number, agent: AgentId) {
    this.active.set(chatId, agent);
  }
  async getActiveProject(chatId: number) {
    return this.activeProject.get(chatId);
  }
  async setActiveProject(chatId: number, project: string) {
    this.activeProject.set(chatId, project);
  }
  async getSession(chatId: number, agent: AgentId, project: string) {
    return this.sessions.get(this.key(chatId, agent, project));
  }
  async setSession(chatId: number, agent: AgentId, project: string, sessionId: string) {
    this.sessions.set(this.key(chatId, agent, project), sessionId);
  }
  async deleteSessions(agent: AgentId) {
    let borradas = 0;
    for (const clave of [...this.sessions.keys()]) {
      // La clave es chatId:agente:proyecto. Se parte por el separador y se
      // compara el campo del medio: un `includes(agent)` daria falsos positivos
      // con un proyecto que se llame como un slot.
      if (clave.split(':')[1] !== agent) continue;
      this.sessions.delete(clave);
      borradas += 1;
    }
    return borradas;
  }
  async createJob(job: NewJob) {
    const id = randomUUID();
    this.jobs.set(id, {
      status: 'running',
      resumen: {
        id,
        agent: job.agent,
        project: job.project,
        prompt: recortar(job.prompt),
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    });
    return id;
  }

  async recentJobs(limite: number): Promise<JobResumen[]> {
    return [...this.jobs.values()]
      .filter((j): j is typeof j & { resumen: JobResumen } => j.resumen !== undefined)
      .map((j) => ({ ...j.resumen, status: j.status, ...(j.error ? { error: j.error } : {}) }))
      .reverse()
      .slice(0, limite);
  }
  async finishJob(jobId: string, status: JobStatus, error?: string) {
    this.jobs.set(jobId, { status, error });
  }
  async setJobStatus(jobId: string, status: JobStatus) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (ESTADOS_FINALES.includes(job.status)) return;
    job.status = status;
  }
  async getJobStatus(jobId: string) {
    return this.jobs.get(jobId)?.status;
  }
  async getJobError(jobId: string) {
    return this.jobs.get(jobId)?.error;
  }

  private approvals = new Map<string, { rec: ApprovalRecord; decided: boolean }>();
  private awaiting = new Map<number, string>();

  async recordApproval(rec: ApprovalRecord) {
    if (this.approvals.has(rec.approvalId)) return false;
    this.approvals.set(rec.approvalId, { rec, decided: false });
    return true;
  }

  async getApproval(approvalId: string) {
    return this.approvals.get(approvalId)?.rec;
  }

  async claimApproval(
    approvalId: string,
    _decision: ApprovalDecision,
    _quien?: { usuarioId?: string; desde: 'telegram' | 'panel' },
  ): Promise<ClaimResult> {
    const entry = this.approvals.get(approvalId);
    if (!entry) return 'unknown';
    if (entry.decided) return 'already_decided';
    entry.decided = true;
    return 'claimed';
  }

  async setAwaitingFeedback(chatId: number, approvalId: string | null) {
    if (approvalId === null) this.awaiting.delete(chatId);
    else this.awaiting.set(chatId, approvalId);
  }

  async getAwaitingFeedback(chatId: number) {
    return this.awaiting.get(chatId);
  }

  private proyectos = new Map<string, { nombre: string }>();
  private membresias: { proyectoId: string; usuarioId: string }[] = [];
  private agentes = new Map<string, { proyectoId: string; nombre?: string; cuenta?: string }>();

  async proyectosDeUsuario(usuarioId: string): Promise<Proyecto[]> {
    return this.membresias
      .filter((m) => m.usuarioId === usuarioId)
      .map((m) => ({ id: m.proyectoId, nombre: this.proyectos.get(m.proyectoId)!.nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  async crearProyecto(nombre: string, dueñoId: string): Promise<string> {
    const id = randomUUID();
    this.proyectos.set(id, { nombre });
    this.membresias.push({ proyectoId: id, usuarioId: dueñoId });
    return id;
  }

  async agentesDeProyecto(proyectoId: string): Promise<AgenteResumen[]> {
    return [...this.agentes.entries()]
      .filter(([, a]) => a.proyectoId === proyectoId)
      .map(([slot, a]) => ({ slot: slot as AgentId, nombre: a.nombre, cuenta: a.cuenta }))
      .sort((a, b) => a.slot.localeCompare(b.slot));
  }

  async registrarAgente(proyectoId: string, slot: AgentId, nombre?: string): Promise<void> {
    const previo = this.agentes.get(slot);
    this.agentes.set(slot, { proyectoId, nombre: nombre ?? previo?.nombre, cuenta: previo?.cuenta });
  }

  private vinculos = new Map<number, string>();
  private codigos = new Map<string, { chatId: number; expira: number; usado: boolean }>();

  async usuarioDeChat(chatId: number): Promise<string | undefined> {
    return this.vinculos.get(chatId);
  }

  async crearCodigoVinculacion(chatId: number, minutos: number): Promise<string> {
    const codigo = codigoLegible();
    this.codigos.set(codigo, { chatId, expira: Date.now() + minutos * 60_000, usado: false });
    return codigo;
  }

  async canjearCodigo(codigo: string, usuarioId: string) {
    const c = this.codigos.get(codigo);
    if (!c) return 'desconocido' as const;
    if (c.usado) return 'usado' as const;
    if (c.expira <= Date.now()) return 'vencido' as const;
    c.usado = true;
    this.vinculos.set(c.chatId, usuarioId);
    return 'ok' as const;
  }
}

export class PgStore implements Store {
  constructor(private pool: Pool) {}

  static async connect(connectionString: string, migrationPaths: string[]): Promise<PgStore> {
    const pool = new Pool({ connectionString });
    // En orden: cada archivo es idempotente (IF NOT EXISTS), asi que correrlos
    // en cada arranque es seguro y evita un runner de migraciones aparte.
    for (const path of migrationPaths) {
      await pool.query(await readFile(path, 'utf8'));
    }
    return new PgStore(pool);
  }

  async getActiveAgent(chatId: number) {
    const r = await this.pool.query<{ active_agent: AgentId }>(
      'SELECT active_agent FROM chat_state WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.active_agent;
  }

  async setActiveAgent(chatId: number, agent: AgentId) {
    await this.pool.query(
      `INSERT INTO chat_state (chat_id, active_agent) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET active_agent = $2, updated_at = now()`,
      [chatId, agent],
    );
  }

  async getActiveProject(chatId: number) {
    const r = await this.pool.query<{ active_project: string | null }>(
      'SELECT active_project FROM chat_state WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.active_project ?? undefined;
  }

  async setActiveProject(chatId: number, project: string) {
    // El INSERT necesita un active_agent porque la columna es NOT NULL; si la
    // fila ya existe, el DO UPDATE no lo toca.
    await this.pool.query(
      `INSERT INTO chat_state (chat_id, active_agent, active_project) VALUES ($1, 'c1', $2)
       ON CONFLICT (chat_id) DO UPDATE SET active_project = $2, updated_at = now()`,
      [chatId, project],
    );
  }

  async getSession(chatId: number, agent: AgentId, project: string) {
    const r = await this.pool.query<{ session_id: string }>(
      'SELECT session_id FROM agent_session WHERE chat_id = $1 AND agent = $2 AND project = $3',
      [chatId, agent, project],
    );
    return r.rows[0]?.session_id;
  }

  async setSession(chatId: number, agent: AgentId, project: string, sessionId: string) {
    await this.pool.query(
      `INSERT INTO agent_session (chat_id, agent, project, session_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id, agent, project)
       DO UPDATE SET session_id = $4, updated_at = now()`,
      [chatId, agent, project, sessionId],
    );
  }

  async deleteSessions(agent: AgentId) {
    const r = await this.pool.query('DELETE FROM agent_session WHERE agent = $1', [agent]);
    return r.rowCount ?? 0;
  }

  async createJob(job: NewJob) {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO jobs (id, chat_id, agent, project, prompt, status, message_id)
       VALUES ($1, $2, $3, $4, $5, 'running', $6)`,
      [id, job.chatId, job.agent, job.project, job.prompt, job.messageId],
    );
    return id;
  }

  async finishJob(jobId: string, status: JobStatus, error?: string) {
    await this.pool.query(
      'UPDATE jobs SET status = $2, error = $3, ended_at = now() WHERE id = $1',
      [jobId, status, error ?? null],
    );
  }

  async recentJobs(limite: number): Promise<JobResumen[]> {
    // El recorte va en SQL y no en JS: un prompt de 50 kB no tiene por que
    // viajar desde la base para que despues lo tiremos.
    const { rows } = await this.pool.query<{
      id: string;
      agent: string;
      project: string;
      prompt: string;
      status: JobStatus;
      created_at: Date;
      error: string | null;
    }>(
      `SELECT id, agent, project, left(prompt, $2) AS prompt, status, created_at, error
         FROM jobs
        ORDER BY created_at DESC
        LIMIT $1`,
      [limite, LARGO_PROMPT_RESUMEN],
    );
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      project: r.project,
      prompt: r.prompt,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  async setJobStatus(jobId: string, status: JobStatus) {
    // El WHERE hace el guard en la base: dos requests concurrentes —el poller
    // marcando awaiting_approval y el turno cerrando en done— no pueden dejar
    // el job en un estado transitorio para siempre.
    await this.pool.query(
      `UPDATE jobs SET status = $2 WHERE id = $1 AND status NOT IN ('done', 'failed')`,
      [jobId, status],
    );
  }

  async getJobStatus(jobId: string) {
    const r = await this.pool.query<{ status: JobStatus }>('SELECT status FROM jobs WHERE id = $1', [
      jobId,
    ]);
    return r.rows[0]?.status;
  }

  async getJobError(jobId: string) {
    const r = await this.pool.query<{ error: string | null }>(
      'SELECT error FROM jobs WHERE id = $1',
      [jobId],
    );
    return r.rows[0]?.error ?? undefined;
  }

  async recordApproval(rec: ApprovalRecord) {
    const r = await this.pool.query(
      `INSERT INTO approvals (approval_id, job_id, chat_id, message_id, agent, tool, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (approval_id) DO NOTHING`,
      [rec.approvalId, rec.jobId, rec.chatId, rec.messageId, rec.agent, rec.tool, rec.summary],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getApproval(approvalId: string) {
    const r = await this.pool.query<{
      approval_id: string;
      job_id: string;
      chat_id: string;
      message_id: string;
      agent: AgentId;
      tool: string;
      summary: string;
    }>(
      `SELECT approval_id, job_id, chat_id, message_id, agent, tool, summary
       FROM approvals WHERE approval_id = $1`,
      [approvalId],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      approvalId: row.approval_id,
      jobId: row.job_id,
      // pg devuelve BIGINT como string para no perder precision; los ids de
      // Telegram entran en un number sin problema.
      chatId: Number(row.chat_id),
      messageId: Number(row.message_id),
      agent: row.agent,
      tool: row.tool,
      summary: row.summary,
    };
  }

  async claimApproval(
    approvalId: string,
    decision: ApprovalDecision,
    quien?: { usuarioId?: string; desde: 'telegram' | 'panel' },
  ): Promise<ClaimResult> {
    // UN solo UPDATE condicional, no un SELECT y despues un UPDATE: dos toques
    // del boton que lleguen a la vez son dos requests concurrentes de Render, y
    // con SELECT-despues-UPDATE los dos leerian "pendiente" y los dos
    // avanzarian. `WHERE decision IS NULL` lo resuelve en la base.
    const r = await this.pool.query(
      `UPDATE approvals
          SET decision = $2, feedback = $3, decided_at = now(),
              decidido_por = $4, decidido_desde = $5
        WHERE approval_id = $1 AND decision IS NULL
       RETURNING approval_id`,
      [
        approvalId,
        decision.decision,
        decision.feedback ?? null,
        quien?.usuarioId ?? null,
        quien?.desde ?? null,
      ],
    );
    if ((r.rowCount ?? 0) > 0) return 'claimed';
    const existe = await this.pool.query('SELECT 1 FROM approvals WHERE approval_id = $1', [
      approvalId,
    ]);
    return (existe.rowCount ?? 0) > 0 ? 'already_decided' : 'unknown';
  }

  async setAwaitingFeedback(chatId: number, approvalId: string | null) {
    if (approvalId === null) {
      await this.pool.query('DELETE FROM awaiting_feedback WHERE chat_id = $1', [chatId]);
      return;
    }
    await this.pool.query(
      `INSERT INTO awaiting_feedback (chat_id, approval_id) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET approval_id = $2, created_at = now()`,
      [chatId, approvalId],
    );
  }

  async getAwaitingFeedback(chatId: number) {
    const r = await this.pool.query<{ approval_id: string }>(
      'SELECT approval_id FROM awaiting_feedback WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.approval_id;
  }

  async proyectosDeUsuario(usuarioId: string): Promise<Proyecto[]> {
    const r = await this.pool.query<{ id: string; nombre: string }>(
      `SELECT p.id, p.nombre
         FROM proyectos p
         JOIN miembros m ON m.proyecto_id = p.id
        WHERE m.usuario_id = $1
        ORDER BY p.nombre`,
      [usuarioId],
    );
    return r.rows;
  }

  async crearProyecto(nombre: string, dueñoId: string): Promise<string> {
    // Las dos filas van juntas o no va ninguna: un proyecto sin dueño no lo ve
    // nadie —la policy pregunta por membresia— y quedaria invisible para
    // siempre.
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const r = await cliente.query<{ id: string }>(
        `INSERT INTO proyectos (nombre) VALUES ($1) RETURNING id`,
        [nombre],
      );
      const id = r.rows[0]!.id;
      await cliente.query(
        `INSERT INTO miembros (proyecto_id, usuario_id, rol) VALUES ($1, $2, 'dueño')`,
        [id, dueñoId],
      );
      await cliente.query('COMMIT');
      return id;
    } catch (e) {
      await cliente.query('ROLLBACK');
      throw e;
    } finally {
      cliente.release();
    }
  }

  async agentesDeProyecto(proyectoId: string): Promise<AgenteResumen[]> {
    const r = await this.pool.query<{ slot: AgentId; nombre: string | null; cuenta: string | null }>(
      `SELECT slot, nombre, cuenta FROM agentes WHERE proyecto_id = $1 ORDER BY slot`,
      [proyectoId],
    );
    return r.rows.map((f) => ({
      slot: f.slot,
      nombre: f.nombre ?? undefined,
      cuenta: f.cuenta ?? undefined,
    }));
  }

  async registrarAgente(proyectoId: string, slot: AgentId, nombre?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agentes (slot, proyecto_id, nombre) VALUES ($1, $2, $3)
       ON CONFLICT (slot) DO UPDATE SET proyecto_id = $2, nombre = COALESCE($3, agentes.nombre)`,
      [slot, proyectoId, nombre ?? null],
    );
  }

  async usuarioDeChat(chatId: number): Promise<string | undefined> {
    const r = await this.pool.query<{ usuario_id: string }>(
      'SELECT usuario_id FROM telegram_vinculos WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.usuario_id;
  }

  async crearCodigoVinculacion(chatId: number, minutos: number): Promise<string> {
    const codigo = codigoLegible();
    await this.pool.query(
      `INSERT INTO telegram_codigos (codigo, chat_id, expira_en)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [codigo, chatId, String(minutos)],
    );
    return codigo;
  }

  async canjearCodigo(codigo: string, usuarioId: string) {
    // Marcar usado y leer el chat en UNA sentencia: si fueran dos, dos canjes
    // simultaneos del mismo codigo pasarian los dos.
    const r = await this.pool.query<{ chat_id: string }>(
      `UPDATE telegram_codigos SET usado_en = now()
        WHERE codigo = $1 AND usado_en IS NULL AND expira_en > now()
        RETURNING chat_id`,
      [codigo],
    );

    if (r.rowCount === 0) {
      const existe = await this.pool.query<{ usado_en: Date | null; expira_en: Date }>(
        'SELECT usado_en, expira_en FROM telegram_codigos WHERE codigo = $1',
        [codigo],
      );
      const fila = existe.rows[0];
      if (!fila) return 'desconocido' as const;
      return fila.usado_en ? ('usado' as const) : ('vencido' as const);
    }

    await this.pool.query(
      `INSERT INTO telegram_vinculos (chat_id, usuario_id) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET usuario_id = $2, vinculado_en = now()`,
      [Number(r.rows[0]!.chat_id), usuarioId],
    );
    return 'ok' as const;
  }
}
