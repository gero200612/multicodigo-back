import { randomUUID } from 'node:crypto';
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

export interface Store {
  getActiveAgent(chatId: number): Promise<AgentId | undefined>;
  setActiveAgent(chatId: number, agent: AgentId): Promise<void>;
  getSession(chatId: number, agent: AgentId, project: string): Promise<string | undefined>;
  setSession(chatId: number, agent: AgentId, project: string, sessionId: string): Promise<void>;
  createJob(job: NewJob): Promise<string>;
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
  /** Toma la decision de forma atomica. Solo el primer llamado gana. */
  claimApproval(approvalId: string, decision: ApprovalDecision): Promise<ClaimResult>;
  setAwaitingFeedback(chatId: number, approvalId: string | null): Promise<void>;
  getAwaitingFeedback(chatId: number): Promise<string | undefined>;
}

export class InMemoryStore implements Store {
  private active = new Map<number, AgentId>();
  private sessions = new Map<string, string>();
  private jobs = new Map<string, { status: JobStatus; error?: string }>();

  private key(chatId: number, agent: AgentId, project: string) {
    return `${chatId}:${agent}:${project}`;
  }

  async getActiveAgent(chatId: number) {
    return this.active.get(chatId);
  }
  async setActiveAgent(chatId: number, agent: AgentId) {
    this.active.set(chatId, agent);
  }
  async getSession(chatId: number, agent: AgentId, project: string) {
    return this.sessions.get(this.key(chatId, agent, project));
  }
  async setSession(chatId: number, agent: AgentId, project: string, sessionId: string) {
    this.sessions.set(this.key(chatId, agent, project), sessionId);
  }
  async createJob(_job: NewJob) {
    const id = randomUUID();
    this.jobs.set(id, { status: 'running' });
    return id;
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

  async claimApproval(approvalId: string, _decision: ApprovalDecision): Promise<ClaimResult> {
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

  async claimApproval(approvalId: string, decision: ApprovalDecision): Promise<ClaimResult> {
    // UN solo UPDATE condicional, no un SELECT y despues un UPDATE: dos toques
    // del boton que lleguen a la vez son dos requests concurrentes de Render, y
    // con SELECT-despues-UPDATE los dos leerian "pendiente" y los dos
    // avanzarian. `WHERE decision IS NULL` lo resuelve en la base.
    const r = await this.pool.query(
      `UPDATE approvals SET decision = $2, feedback = $3, decided_at = now()
       WHERE approval_id = $1 AND decision IS NULL
       RETURNING approval_id`,
      [approvalId, decision.decision, decision.feedback ?? null],
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
}
