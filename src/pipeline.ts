import { sanitizeForTelegram, type AgentId, type PromptRequest, type PromptResponse } from '@multicodigo/shared';
import { parseCommand } from './router.js';
import type { Store } from './store.js';

export interface IncomingMessage {
  chatId: number;
  messageId: number;
  text?: string;
  audio?: { bytes: Uint8Array; mimeType: string };
}

export interface PipelineDeps {
  store: Store;
  defaultAgent: AgentId;
  project: string;
  ask: (req: PromptRequest) => Promise<PromptResponse>;
  transcribe: (bytes: Uint8Array, mimeType: string) => Promise<string>;
}

export type PipelineOutcome =
  | { kind: 'answer'; text: string; agent: AgentId; jobId: string; transcript?: string }
  | { kind: 'switched'; agent: AgentId }
  | { kind: 'status'; agent: AgentId }
  | { kind: 'ignored' }
  | { kind: 'error'; text: string; jobId: string };

const ERROR_TEXT: Record<string, string> = {
  auth_expired: 'Ese agente necesita re-login: su credencial vencio.',
  agent_unavailable: 'No pude contactar al agente. Puede estar reiniciandose.',
  agent_timeout: 'El agente tardo demasiado y corte la espera.',
  unknown_agent: 'Ese agente no existe.',
  unknown_project: 'Ese proyecto no esta configurado en el agente.',
};

export async function handleIncoming(
  input: IncomingMessage,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  let transcript: string | undefined;
  let raw = input.text ?? '';

  if (input.audio) {
    transcript = await deps.transcribe(input.audio.bytes, input.audio.mimeType);
    raw = transcript;
  }

  const command = parseCommand(raw);

  if (command.kind === 'empty') return { kind: 'ignored' };

  if (command.kind === 'switch') {
    await deps.store.setActiveAgent(input.chatId, command.agent);
    return { kind: 'switched', agent: command.agent };
  }

  if (command.kind === 'status') {
    const active = (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
    return { kind: 'status', agent: active };
  }

  const agent =
    command.agent ?? (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
  const sessionId = await deps.store.getSession(input.chatId, agent, deps.project);

  const jobId = await deps.store.createJob({
    chatId: input.chatId,
    agent,
    project: deps.project,
    prompt: command.text,
    messageId: input.messageId,
  });

  try {
    const response = await deps.ask({
      jobId,
      agent,
      project: deps.project,
      prompt: command.text,
      sessionId,
    });
    await deps.store.setSession(input.chatId, agent, deps.project, response.sessionId);
    await deps.store.finishJob(jobId, 'done');
    return {
      kind: 'answer',
      text: sanitizeForTelegram(response.text),
      agent,
      jobId,
      transcript,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : 'internal';
    await deps.store.finishJob(jobId, 'failed', code);
    return { kind: 'error', text: ERROR_TEXT[code] ?? `Fallo el agente: ${code}`, jobId };
  }
}
