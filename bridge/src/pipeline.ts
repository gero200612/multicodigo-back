import {
  sanitizeForTelegram,
  type AgentId,
  type PromptRequest,
  type PromptResponse,
  type RepoDelPedido,
} from '@multicodigo/shared';
import { parseCommand } from './router.js';
import { tecladoDeProyectos, tecladoDeAgentes } from './menu.js';
import type { Boton } from './render.js';
import type { Store, Proyecto } from './store.js';
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
  ask: (req: PromptConToken) => Promise<PromptResponse>;
  /**
   * Le pide al panel que firme el token de una instalacion.
   *
   * Opcional: sin esto —o si el panel no contesta— los turnos de Telegram van
   * por SSH, que es como funcionaban antes de la GitHub App. Ver panel-client.ts
   * para por que la firma la hace el panel y no este servicio.
   */
  firmarToken?: (installationId: number) => Promise<string | undefined>;
  transcribe: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  /**
   * El estado de los agentes, del gateway.
   *
   * Se le pasa el proyecto porque el gateway lista todos los slots de la
   * maquina, no solo los de un proyecto.
   */
  listarAgentes: (
    proyecto: string,
  ) => Promise<{ id: AgentId; arriba: boolean; cuenta: boolean }[]>;
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
  | { kind: 'menu_proyectos'; botones: Boton[][] }
  | { kind: 'menu_agentes'; proyecto: string; botones: Boton[][] }
  /** Vinculado, pero sin pertenecer a ningun proyecto todavia. */
  | { kind: 'sin_proyectos' }
  | { kind: 'elegido'; agente: AgentId; nombre: string; proyecto: string }
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

  if (command.kind === 'menu') {
    return await armarMenu(usuarioId, input.chatId, deps);
  }

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

  // El id del proyecto, para poder compartir el hilo con el panel. Puede no
  // existir —un proyecto de config/projects.json que nunca se creo desde el
  // panel— y en ese caso el turno corre igual, pero sin sesion compartida: no
  // hay clave con que guardarla.
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  const proyectoId = proyectos.find((p) => p.nombre === project)?.id;

  // Los repos y el token del proyecto, que en el camino del PANEL los pone el
  // panel. Aca los tiene que juntar el bridge: un turno de Telegram no pasa por
  // ahi, y sin ellos el gateway cae a su catalogo local —que solo conoce `demo`
  // y `sincroresto`— y clona por SSH.
  //
  // Los dos son opcionales y ninguna falla corta el turno.
  const repos = proyectoId ? await deps.store.reposDeProyecto(proyectoId) : undefined;
  const githubToken = await tokenDelProyecto(proyectoId, deps);

  try {
    const r = await ejecutarTurno(deps, {
      proyectoId,
      proyecto: project,
      agente: agent,
      usuarioId,
      prompt: command.text,
      repos,
      githubToken,
      origen: 'telegram',
      chatId: input.chatId,
      messageId: input.messageId,
    });
    return {
      kind: 'answer',
      text: sanitizeForTelegram(r.texto),
      agent,
      jobId: r.jobId,
      transcript,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : 'internal';
    const jobId = err instanceof ErrorDeTurno ? err.jobId : '';
    return { kind: 'error', text: ERROR_TEXT[code] ?? `Fallo el agente: ${code}`, jobId };
  }
}

/**
 * El pedido al agente, con el token del turno.
 *
 * Se extiende aca y no en `@multicodigo/shared` porque el token es cosa del
 * TRANSPORTE panel -> bridge -> gateway y no del contrato con el agente: el
 * gateway lo saca del cuerpo antes de reenviarlo, asi que el agente nunca ve
 * este campo. Meterlo en PromptRequest diria lo contrario.
 */
export type PromptConToken = PromptRequest & { githubToken?: string };

export interface Turno {
  /**
   * El proyecto al que pertenece el hilo. Sin el no hay sesion compartida: el
   * turno corre, pero arranca de cero cada vez.
   */
  proyectoId?: string;
  /** El nombre, que es lo que viaja al gateway (va en la ruta del worktree). */
  proyecto: string;
  agente: AgentId;
  usuarioId: string;
  prompt: string;
  origen: 'telegram' | 'panel';
  /** Solo cuando viene de Telegram: para poder colgar el poller del mensaje. */
  chatId?: number;
  messageId?: number;
  /**
   * Los repos del proyecto, para que el gateway sepa cuales preparar.
   *
   * Opcional, y quien lo deja vacio importa: los pone el PANEL, que los lee de
   * Supabase. El gateway no le habla a Supabase, asi que sin esto cae a su
   * catalogo local — que solo conoce `demo` y `sincroresto`.
   */
  repos?: RepoDelPedido[];
  /**
   * El installation token de la GitHub App, firmado por el panel.
   *
   * El bridge no lo mira ni lo guarda: lo reenvia al gateway, que lo usa para el
   * clone, el fetch y el push del turno y lo olvida. Nunca llega al agente — de
   * eso se ocupa el gateway.
   *
   * Opcional porque un proyecto puede no haber instalado la App: ahi el gateway
   * va por SSH con la deploy key, que es el camino de `demo`.
   */
  githubToken?: string;
}

/**
 * El error de un turno, con el job al que corresponde.
 *
 * El jobId hace falta para poder mostrar el detalle despues, y una excepcion
 * pelada lo perderia: quien la atrapa ya no tiene forma de saber que fila de la
 * tabla se cerro con ese error.
 */
export class ErrorDeTurno extends Error {
  constructor(
    readonly jobId: string,
    codigo: string,
  ) {
    super(codigo);
    this.name = 'ErrorDeTurno';
  }
}

/**
 * Un turno, venga de donde venga.
 *
 * Salio de handleIncoming para que el panel pueda pedir turnos sin duplicar el
 * ciclo de vida: crear el job, colgar el poller de aprobaciones, guardar la
 * sesion, cerrar el job. Duplicarlo dejaria dos lugares donde acordarse del
 * poller, y olvidarlo en uno cuelga al agente hasta el timeout.
 */
/**
 * El token de la GitHub App del proyecto, o undefined.
 *
 * Dos pasos que viven en servicios distintos a proposito: el bridge SABE que
 * instalacion es —la lee de su propio Postgres, sin RLS— y el panel es el unico
 * que puede FIRMAR, porque tiene la clave privada de la App.
 */
async function tokenDelProyecto(
  proyectoId: string | undefined,
  deps: PipelineDeps,
): Promise<string | undefined> {
  if (!proyectoId || !deps.firmarToken) return undefined;
  const instalacion = await deps.store.instalacionDeProyecto(proyectoId);
  if (instalacion === undefined) return undefined;
  return deps.firmarToken(instalacion);
}

export async function ejecutarTurno(
  deps: PipelineDeps,
  t: Turno,
): Promise<{ jobId: string; texto: string }> {
  const sessionId = t.proyectoId
    ? await deps.store.getSession(t.proyectoId, t.agente)
    : undefined;

  const jobId = await deps.store.createJob({
    chatId: t.chatId ?? 0,
    agent: t.agente,
    project: t.proyecto,
    proyectoId: t.proyectoId,
    usuarioId: t.usuarioId,
    origen: t.origen,
    prompt: t.prompt,
    messageId: t.messageId ?? 0,
  });

  // El poller va SIEMPRE, no solo para Telegram: un agente que pide permiso
  // desde un turno del panel se cuelga igual si nadie va a buscar el pedido.
  const parar =
    deps.watchApprovals?.({
      agent: t.agente,
      jobId,
      messageId: t.messageId ?? 0,
      chatId: t.chatId ?? 0,
    }) ?? (() => {});

  try {
    const r = await deps.ask({
      jobId,
      agent: t.agente,
      project: t.proyecto,
      prompt: t.prompt,
      sessionId,
      repos: t.repos,
      githubToken: t.githubToken,
    });
    if (t.proyectoId) await deps.store.setSession(t.proyectoId, t.agente, r.sessionId);
    await deps.store.finishJob(jobId, 'done', undefined, r.text);
    return { jobId, texto: r.text };
  } catch (err) {
    const codigo = err instanceof Error ? err.message : 'internal';
    await deps.store.finishJob(jobId, 'failed', codigo);
    throw new ErrorDeTurno(jobId, codigo);
  } finally {
    // En `finally`: si el turno explota, el poller tiene que morir igual o
    // queda un setInterval vivo por cada mensaje que fallo.
    parar();
  }
}

/**
 * El primer paso del menu.
 *
 * Con un solo proyecto se saltea la eleccion: preguntar entre una opcion es un
 * toque de mas que no decide nada.
 */
async function armarMenu(
  usuarioId: string,
  chatId: number,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  if (proyectos.length === 0) return { kind: 'sin_proyectos' };

  if (proyectos.length > 1) {
    return { kind: 'menu_proyectos', botones: tecladoDeProyectos(proyectos) };
  }

  const unico = proyectos[0]!;
  await deps.store.setActiveProject(chatId, unico.nombre);
  return await armarMenuDeAgentes(unico, deps);
}

export async function armarMenuDeAgentes(
  proyecto: Proyecto,
  deps: Pick<PipelineDeps, 'store' | 'listarAgentes'>,
): Promise<PipelineOutcome> {
  const registrados = await deps.store.agentesDeProyecto(proyecto.id);

  // Un gateway caido no puede dejarte sin ver que agentes tenes. Se muestran
  // todos apagados, que es lo peor que puede ser cierto.
  let estados: { id: AgentId; arriba: boolean; cuenta: boolean }[] = [];
  try {
    estados = await deps.listarAgentes(proyecto.nombre);
  } catch {
    estados = [];
  }

  const porSlot = new Map(estados.map((e) => [e.id, e]));
  const conEstado = registrados.map((a) => {
    const estado = porSlot.get(a.slot);
    return {
      ...a,
      arriba: estado?.arriba ?? false,
      // Quien sabe si el slot tiene cuenta es el gateway: el marcador lo
      // escribe el servicio de login, en la VM. La columna `cuenta` de la tabla
      // es el respaldo para cuando el gateway no contesta, y hoy nadie la
      // llena, asi que sin gateway el menu muestra todo como "sin cuenta". Es
      // el lado correcto para equivocarse: un boton que no anda es peor que uno
      // que avisa.
      tieneCuenta: estado?.cuenta ?? Boolean(a.cuenta),
    };
  });

  return {
    kind: 'menu_agentes',
    proyecto: proyecto.nombre,
    botones: tecladoDeAgentes(conEstado),
  };
}
