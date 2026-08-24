import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AgentId } from '@multicodigo/shared';

export type JobStatus = 'running' | 'done' | 'failed';

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
  getJobStatus(jobId: string): Promise<JobStatus | undefined>;
  getJobError(jobId: string): Promise<string | undefined>;
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
  async getJobStatus(jobId: string) {
    return this.jobs.get(jobId)?.status;
  }
  async getJobError(jobId: string) {
    return this.jobs.get(jobId)?.error;
  }
}

export class PgStore implements Store {
  constructor(private pool: Pool) {}

  static async connect(connectionString: string, migrationPath: string): Promise<PgStore> {
    const pool = new Pool({ connectionString });
    await pool.query(await readFile(migrationPath, 'utf8'));
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
}
