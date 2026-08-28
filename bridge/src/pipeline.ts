import { sanitizeForTelegram, type AgentId, type PromptRequest, type PromptResponse } from '@multicodigo/shared';
import { parseCommand } from './router.js';
import type { Store } from './store.js';
import { LimitePorChat, MINUTOS_DE_CODIGO } from './vinculacion.js';

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
  /** Cuantos codigos de vinculacion puede pedir cada chat. */
  limite: LimitePorChat;
  ask: (req: PromptRequest) => Promise<PromptResponse>;
  transcribe: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  /**
   * Arranca el poller de aprobaciones de este job y devuelve como pararlo.
   *
   * Es opcional para que el pipeline siga siendo testeable sin el, pero sin
   * esto el turno se cuelga en silencio: el hijo bloquea esperando un OK que
   * nadie va a ir a buscar, porque el hijo no tiene egress a Render.
   */
  watchApprovals?: (ctx: {
    agent: AgentId;
    jobId: string;
    messageId: number;
    chatId: number;
  }) => () => void;
}

export type PipelineOutcome =
  | { kind: 'answer'; text: string; agent: AgentId; jobId: string; transcript?: string }
  | { kind: 'switched'; agent: AgentId }
  | { kind: 'status'; agent: AgentId }
  | { kind: 'project'; project: string }
  /** El chat no esta atado a ninguna cuenta del panel. */
  | { kind: 'sin_vincular'; yaEstaba: boolean }
  | { kind: 'codigo'; codigo: string; minutos: number }
  | { kind: 'ignored' }
  | { kind: 'error'; text: string; jobId: string };

const ERROR_TEXT: Record<string, string> = {
  auth_expired: 'Ese agente necesita re-login: su credencial vencio.',
  // Distinto de auth_expired a proposito: ahi habia una cuenta y se vencio, aca
  // nunca hubo ninguna. La accion del usuario es otra, asi que el mensaje no
  // puede ser el mismo.
  sin_credencial: 'Ese slot todavia no tiene una cuenta de Claude cargada. Cargasela y volve a escribir.',
  agent_unavailable: 'No pude contactar al agente. Puede estar reiniciandose.',
  agent_timeout: 'El agente tardo demasiado y corte la espera.',
  unknown_agent: 'Ese agente no existe.',
  unknown_project: 'Ese proyecto no esta configurado en el agente.',
  approval_timeout: 'Me quede esperando tu OK 15 minutos y lo cancele.',
  forbidden_branch: 'Esa branch no se puede tocar.',
  git_failed: 'Git fallo. Fijate el detalle en el ultimo mensaje del agente.',
  run_failed: 'La tarea fallo. El agente te cuenta el detalle en su respuesta.',
  run_timeout: 'La tarea tardo demasiado y la corte.',
  unknown_task: 'Esa tarea no esta configurada para el proyecto.',
  worktree_dirty: 'El worktree tiene cambios sin commitear, asi que no lo actualice.',
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

  // El vinculo se resuelve ANTES que cualquier otro comando: un chat que no es
  // de nadie no puede cambiar de agente, ni de proyecto, ni pedir un turno.
  const usuarioId = await deps.store.usuarioDeChat(input.chatId);

  if (command.kind === 'vincular') {
    if (usuarioId) return { kind: 'sin_vincular', yaEstaba: true };
    if (!deps.limite.permite(input.chatId)) return { kind: 'sin_vincular', yaEstaba: false };
    const codigo = await deps.store.crearCodigoVinculacion(input.chatId, MINUTOS_DE_CODIGO);
    return { kind: 'codigo', codigo, minutos: MINUTOS_DE_CODIGO };
  }

  if (!usuarioId) return { kind: 'sin_vincular', yaEstaba: false };

  if (command.kind === 'switch') {
    await deps.store.setActiveAgent(input.chatId, command.agent);
    return { kind: 'switched', agent: command.agent };
  }

  if (command.kind === 'project') {
    if (command.project) await deps.store.setActiveProject(input.chatId, command.project);
    const activo =
      command.project ?? (await deps.store.getActiveProject(input.chatId)) ?? deps.project;
    return { kind: 'project', project: activo };
  }

  if (command.kind === 'status') {
    const active = (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
    return { kind: 'status', agent: active };
  }

  const agent =
    command.agent ?? (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
  // El proyecto del turno: lo que eligio el chat, o el default del bridge.
  const project = (await deps.store.getActiveProject(input.chatId)) ?? deps.project;
  const sessionId = await deps.store.getSession(input.chatId, agent, project);

  const jobId = await deps.store.createJob({
    chatId: input.chatId,
    agent,
    project,
    prompt: command.text,
    messageId: input.messageId,
  });

  const stopWatching =
    deps.watchApprovals?.({ agent, jobId, messageId: input.messageId, chatId: input.chatId }) ??
    (() => {});

  try {
    const response = await deps.ask({
      jobId,
      agent,
      project,
      prompt: command.text,
      sessionId,
    });
    await deps.store.setSession(input.chatId, agent, project, response.sessionId);
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
  } finally {
    // En `finally`: si el turno explota, el poller tiene que morir igual o
    // queda un setInterval vivo por cada mensaje que fallo.
    stopWatching();
  }
}
