import { promptDeRelevo, proximoSlot } from './relevo.js';
import {
  esAvisoDeLimite,
  horaDeReset,
  sanitizeForTelegram,
  type AgentId,
  type PromptRequest,
  type PromptResponse,
  type RepoDelPedido,
} from '@multicodigo/shared';
import { parseCommand } from './router.js';
import {
  tecladoDeProyectos,
  tecladoDeAgentes,
  tecladoDeAcciones,
  datosDeAgente,
  datosDeMenu,
} from './menu.js';
import type { Boton } from './render.js';
import type { Store, Proyecto, ModoPermiso, ClaveDeModelo } from './store.js';
import { partirEnTareas, type Tarea } from './cola.js';
import { aHoraArgentina } from './horas.js';
import type { Quien } from './agents-client.js';
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
  /**
   * Manda el turno al gateway.
   *
   * `quien` va aparte del pedido y no adentro: el gateway lo manda por headers
   * para que no termine en el cuerpo que le reenvia al hijo. Sin esto, el
   * gateway no puede saber de quien es el slot mientras dura el turno.
   */
  ask: (
    req: PromptConToken,
    quien: Quien,
  ) => Promise<PromptResponse & { tokens?: number; costoUsd?: number }>;
  /**
   * Le pide al panel que firme el token de una instalacion.
   *
   * Opcional: sin esto —o si el panel no contesta— los turnos de Telegram van
   * por SSH, que es como funcionaban antes de la GitHub App. Ver panel-client.ts
   * para por que la firma la hace el panel y no este servicio.
   */
  firmarToken?: (installationId: number) => Promise<string | undefined>;
  /**
   * De donde salen los documentos del proyecto.
   *
   * Ya no es una dependencia opcional: se leen del store, que siempre esta.
   * Antes se pedian por HTTP a la API REST de Supabase con la `service_role`, y
   * sin esa clave la funcion no se pasaba —los documentos quedaban apagados
   * enteros y el agente no veia ningun archivo, ni del panel ni del bot—. El
   * bridge se conecta a la misma base como `postgres`, asi que ese rodeo
   * costaba una clave y una llamada de red para nada.
   */
  transcribe: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  /**
   * El estado de los agentes, del gateway.
   *
   * Se le pasa el proyecto porque el gateway lista todos los slots de la
   * maquina, no solo los de un proyecto.
   */
  listarAgentes: (
    proyecto: string,
  ) => Promise<{ id: AgentId; arriba: boolean; cuenta: boolean; ocupado?: boolean }[]>;
  /**
   * Arranca el poller de aprobaciones de este job y devuelve como pararlo.
   *
   * Es opcional para que el pipeline siga siendo testeable sin el, pero sin
   * esto el turno se cuelga en silencio: el hijo bloquea esperando un OK que
   * nadie va a ir a buscar, porque el hijo no tiene egress a Render.
   */
  /**
   * Las aprobaciones que el agente tiene pendientes.
   *
   * Solo para explicar POR QUE un slot esta ocupado: un turno frenado
   * esperando un OK retiene el slot hasta quince minutos, y "ocupado" a secas
   * no dice si conviene esperar o irse a otro agente.
   *
   * Opcional: sin esto el aviso sale igual, un poco mas pobre.
   */
  pendientesDe?: (agent: AgentId) => Promise<unknown[]>;
  watchApprovals?: (ctx: {
    agent: AgentId;
    jobId: string;
    messageId: number;
    chatId: number;
  }) => () => void;
}

export type PipelineOutcome =
  | {
      kind: 'answer';
      text: string;
      /**
       * Quien contesto DE VERDAD.
       *
       * Puede no ser a quien le escribiste: si ese slot se quedo sin tokens,
       * otro siguio el trabajo. Antes aca iba el agente original y el mensaje
       * salia firmado por alguien que no lo escribio.
       */
      agent: AgentId;
      jobId: string;
      /**
       * Los saltos que hubo, como `c1 -> c2`. Vacio en un turno normal.
       *
       * Se avisa porque el hilo NO se muda con el relevo: el que sigue arranca
       * una sesion nueva con el contexto reinyectado como texto (ver
       * relevo.ts). Quien escribe despues tiene que saber que le habla a otro.
       */
      relevos?: string[];
    }
  | { kind: 'switched'; agent: AgentId }
  | { kind: 'status'; agent: AgentId; otros: AgentId[] }
  | { kind: 'cowork'; primario: AgentId; otros: AgentId[] }
  /**
   * El modo de permisos del chat.
   *
   * `cambiado` separa "asi quedo" de "asi esta": el mismo outcome contesta a
   * `/permisos` y a `/permisos todo`, y confirmar un cambio que no se hizo
   * seria mentir.
   */
  | { kind: 'permisos'; modo: ModoPermiso; cambiado: boolean }
  /**
   * Con que modelo corre el chat.
   *
   * `modelo` puede faltar y eso es informacion: significa "el default del
   * CLI". Resolverlo a uno concreto aca seria inventar cual es.
   */
  | { kind: 'modelo'; modelo?: ClaveDeModelo; cambiado: boolean }
  /**
   * La cola de trabajo.
   *
   * `encoladas` en 0 significa "solo vine a mirar": el mismo outcome contesta
   * a `/cola` y a `/cola <lista>`, y decir "sume 0 tareas" seria raro.
   */
  | { kind: 'cola'; tareas: Tarea[]; encoladas: number; agente?: AgentId }
  | { kind: 'cola_cancelada'; cuantas: number }
  | { kind: 'project'; project: string }
  /** El chat no esta atado a ninguna cuenta del panel. */
  | { kind: 'sin_vincular'; yaEstaba: boolean }
  | { kind: 'codigo'; codigo: string; minutos: number }
  /**
   * El menu principal: que queres hacer.
   *
   * Es lo que `/menu` contesta ahora. Antes contestaba `menu_agentes`, que es
   * un paso del medio: elegir agente es UNA de las cosas que se pueden hacer,
   * y era la unica que el menu ofrecia.
   */
  | { kind: 'menu'; saluda: boolean; botones: Boton[][] }
  | { kind: 'menu_proyectos'; botones: Boton[][] }
  | { kind: 'menu_agentes'; proyecto: string; botones: Boton[][] }
  /** Vinculado, pero sin pertenecer a ningun proyecto todavia. */
  | { kind: 'sin_proyectos' }
  | { kind: 'elegido'; agente: AgentId; nombre: string; proyecto: string }
  | { kind: 'ignored' }
  /**
   * El slot lo esta usando otra persona.
   *
   * Separado de `error` porque no es una falla: el sistema hizo justo lo que
   * tiene que hacer. Y porque la salida es una eleccion —otro agente— y no
   * algo que haya que ir a arreglar.
   */
  | {
      kind: 'ocupado';
      agent: AgentId;
      quien?: string;
      desde?: number;
      /** El turno esta frenado esperando que el dueño apruebe algo. */
      esperandoOk?: boolean;
      botones: Boton[][];
    }
  | {
      kind: 'error';
      text: string;
      jobId: string;
      /**
       * Botones para salir del error, cuando los hay.
       *
       * Hoy solo los pone `usage_limit`: es el unico error en el que la salida
       * es una eleccion —otro Claude— y no algo que hay que ir a arreglar a
       * otro lado. Un mensaje que dice "carga otra cuenta" y no te deja
       * elegirla te manda al panel para algo que el chat ya puede hacer.
       */
      botones?: Boton[][];
    };

const ERROR_TEXT: Record<string, string> = {
  auth_expired: 'Ese agente necesita re-login: su credencial vencio.',
  // Distinto de auth_expired a proposito: ahi habia una cuenta y se vencio, aca
  // nunca hubo ninguna. La accion del usuario es otra, asi que el mensaje no
  // puede ser el mismo.
  sin_credencial: 'Ese slot todavia no tiene una cuenta de Claude cargada. Cargasela y volve a escribir.',
  agent_unavailable: 'No pude contactar al agente. Puede estar reiniciandose.',
  // "Sigue trabajando" y no "fallo", que es lo que decia antes. El bridge se
  // rinde a los 11 minutos, pero el gateway tiene su propio tope y el turno
  // sigue corriendo de verdad —con el slot tomado—. Decir que fallo invita a
  // reintentar contra un agente que esta ocupado con lo mismo que se pidio.
  agent_timeout:
    'El agente tardo mas de lo que puedo esperar, asi que solte la espera. ' +
    'Igual sigue trabajando: preguntale con /status o escribile en un rato.',
  // `fetch failed` es lo que tira undici cuando el gateway no contesta a
  // tiempo, y llegaba CRUDO: "Fallo el agente: fetch failed", que no le dice
  // nada a nadie y suena a que se rompio la red. Casi siempre es lo mismo que
  // agent_timeout —un turno que tardo mas que la espera— asi que se dice igual.
  'fetch failed':
    'Perdi la conexion con el agente mientras trabajaba. ' +
    'Puede seguir andando: preguntale con /status o escribile en un rato.',
  agent_unavailable_timeout:
    'El agente tardo demasiado y solte la espera. Fijate con /status si sigue trabajando.',
  unknown_agent: 'Ese agente no existe.',
  unknown_project: 'Ese proyecto no esta configurado en el agente.',
  // Este mensaje dice QUE hacer y no solo que fallo. Sin el, el sintoma que
  // llegaba era "spawn node ENOENT" convertido en "algo fallo del lado del
  // servidor": el agente arranca con un cwd que no existe porque sin repos no
  // hay worktree, y eso manda a mirar el servidor cuando lo que falta es
  // vincular un repo.
  sin_repos:
    'Ese proyecto no tiene ningun repo vinculado, asi que el agente no tiene sobre que trabajar. ' +
    'Vincula uno desde el panel, en Configuracion.',
  // El mensaje de git viaja en el `message`, no en el codigo, asi que este texto
  // dice donde mirar y el detalle llega aparte.
  worktree_failed:
    'No pude preparar el repositorio del proyecto. Fijate que la App de GitHub ' +
    'tenga acceso a ese repo, o que la clave del servidor este cargada.',
  // Ver `textoDeAgotado`: este es el texto de respaldo, para cuando no se sabe
  // ni que slot fue ni cuando vuelve.
  usage_limit:
    'Ese agente se quedo sin tokens y no habia otro libre para seguir. ' +
    'Proba mas tarde o carga otra cuenta.',
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
  let raw = input.text ?? '';

  // La transcripcion se usa como si el usuario la hubiera escrito, y nada mas:
  // ya no vuelve al chat. Ver `renderOutcome` en telegram.ts.
  if (input.audio) {
    raw = await deps.transcribe(input.audio.bytes, input.audio.mimeType);
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
    return { kind: 'menu', saluda: command.saluda, botones: tecladoDeAcciones() };
  }

  if (command.kind === 'agentes') {
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

  if (command.kind === 'cola') {
    const tareas = partirEnTareas(command.texto);
    if (tareas.length === 0) {
      // Sin texto: se muestra como va, que es lo que quiere quien escribe
      // `/cola` a secas.
      return { kind: 'cola', tareas: await deps.store.tareasDeChat(input.chatId), encoladas: 0 };
    }

    const agente =
      (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
    const proyecto = (await deps.store.getActiveProject(input.chatId)) ?? deps.project;
    const n = await deps.store.encolar(input.chatId, { agente, proyecto, textos: tareas });
    return {
      kind: 'cola',
      tareas: await deps.store.tareasDeChat(input.chatId),
      encoladas: n,
      agente,
    };
  }

  if (command.kind === 'cola_cancelar') {
    const n = await deps.store.cancelarCola(input.chatId);
    return { kind: 'cola_cancelada', cuantas: n };
  }

  if (command.kind === 'modelo') {
    if (command.modelo) await deps.store.setModeloDeChat(input.chatId, command.modelo);
    const modelo = command.modelo ?? (await deps.store.modeloDeChat(input.chatId));
    return { kind: 'modelo', modelo, cambiado: command.modelo !== undefined };
  }

  if (command.kind === 'permisos') {
    if (command.modo) await deps.store.setModoDeChat(input.chatId, command.modo);
    // El actual, o el default del agente si nunca eligio. Se resuelve aca —y no
    // se muestra "sin elegir"— porque lo que importa saber es que va a pasar la
    // proxima vez que el agente quiera escribir, no si alguien toco un boton.
    const modo = command.modo ?? (await deps.store.modoDeChat(input.chatId)) ?? 'preguntar';
    return { kind: 'permisos', modo, cambiado: command.modo !== undefined };
  }

  if (command.kind === 'cowork') {
    if (command.agent) await deps.store.alternarCowork(input.chatId, command.agent);
    const primario = (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
    // El primario no puede estar ademas en la lista de al lado: seria el mismo
    // agente mostrado dos veces, y sacarlo de ahi no cambia nada de lo que se
    // puede hacer con el.
    const otros = (await deps.store.agentesDeCowork(input.chatId)).filter((a) => a !== primario);
    return { kind: 'cowork', primario, otros };
  }

  if (command.kind === 'status') {
    const primario = (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
    const otros = (await deps.store.agentesDeCowork(input.chatId)).filter((a) => a !== primario);
    return { kind: 'status', agent: primario, otros };
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

  // Los documentos, igual que los repos: en el camino del panel los pone el
  // panel, y aca los tiene que juntar el bridge. Sin proyecto en la base no hay
  // documentos que buscar — no hay clave con que buscarlos.
  const documentos =
    proyectoId
      // `catch`: no poder leerlos degrada el turno —el agente trabaja sobre el
      // codigo— pero no lo voltea.
      ? await deps.store.documentosDeProyecto(proyectoId).catch(() => undefined)
      : undefined;

  // El modo del chat. Un fallo aca no puede voltear el turno: sin modo corre
  // con el default del agente, que es el estricto — se pregunta de mas, que es
  // el lado correcto para equivocarse.
  const modo = await deps.store.modoDeChat(input.chatId).catch(() => undefined);
  // Igual que el modo: un fallo aca no voltea el turno, corre con el default.
  const modelo = await deps.store.modeloDeChat(input.chatId).catch(() => undefined);

  try {
    const r = await ejecutarTurnoConRelevo(deps, {
      proyectoId,
      proyecto: project,
      agente: agent,
      usuarioId,
      prompt: command.text,
      modo,
      modelo,
      repos,
      githubToken,
      documentos,
      origen: 'telegram',
      chatId: input.chatId,
      messageId: input.messageId,
    });
    return {
      kind: 'answer',
      text: sanitizeForTelegram(r.texto),
      // El que contesto, no el que se le pidio: con un relevo en el medio son
      // dos agentes distintos.
      agent: r.agente,
      jobId: r.jobId,
      relevos: r.relevos,
    };
  } catch (err) {
    const code = err instanceof Error ? err.message : 'internal';
    const jobId = err instanceof ErrorDeTurno ? err.jobId : '';

    // Ocupado no es una falla: el sistema hizo exactamente lo que tiene que
    // hacer. Y la salida es una eleccion —otro agente—, no algo que haya que ir
    // a arreglar a otro lado, asi que sale por su propio outcome y con botones.
    if (code === 'agente_ocupado') {
      const duenio = err instanceof ErrorDeTurno ? err.duenio : undefined;
      // El prompt se guarda para que el boton del agente siguiente lo mande.
      // Sin esto, el aviso obliga a reescribir el mismo texto que ya se
      // escribio, que es cambiar un "no" por una molestia.
      //
      // `catch` vacio: no poder guardarlo degrada el boton a un cambio de
      // agente pelado, que es lo que hacia antes. No puede voltear el aviso.
      await deps.store.setPendiente(input.chatId, command.text).catch(() => {});
      // Por que esta ocupado, cuando se puede saber. Un turno frenado en una
      // aprobacion no es lo mismo que uno trabajando: el primero se destraba
      // con un toque de la otra persona y el segundo hay que esperarlo.
      //
      // `catch`: no poder preguntarle al agente degrada el aviso, no lo voltea.
      const esperandoOk = deps.pendientesDe
        ? await deps.pendientesDe(agent).then((p) => p.length > 0).catch(() => false)
        : false;

      return {
        kind: 'ocupado',
        agent,
        esperandoOk,
        // `catch` a undefined: no saber el nombre degrada el mensaje a "otra
        // persona", que sigue siendo util. Voltear el aviso por no poder leer
        // un email seria cambiar un mensaje incompleto por ninguno.
        quien: duenio?.usuarioId
          ? await deps.store.nombreDeUsuario(duenio.usuarioId).catch(() => undefined)
          : undefined,
        desde: duenio?.desde,
        botones: await botonesDeRelevo(agent, project, deps),
      };
    }

    if (code === 'usage_limit') {
      const resets = err instanceof ErrorDeTurno ? err.resets : undefined;
      return {
        kind: 'error',
        jobId,
        text: textoDeAgotado(agent, resets),
        botones: await botonesDeRelevo(agent, project, deps),
      };
    }

    return { kind: 'error', text: ERROR_TEXT[code] ?? `Fallo el agente: ${code}`, jobId };
  }
}

/**
 * El aviso de que un slot se quedo sin tokens, en castellano.
 *
 * Existe porque el aviso de Anthropic llegaba tal cual: en ingles, con la hora
 * en UTC y sin decir de que agente hablaba. Y llegaba porque el turno lo tomaba
 * por una respuesta valida — ver `esAvisoDeLimite` en el agente, que es donde
 * estaba el bug de verdad. Esto es la otra mitad: una vez detectado, decirlo
 * como se lo diria una persona.
 *
 * La hora se pasa a hora de Argentina. Antes se mostraba cruda, con su `(UTC)`
 * incluido, porque el bot no sabia en que zona estaba quien lee — ahora si, y
 * esa hora es la que decide si conviene esperar o cambiar de agente: leerla
 * tres horas corrida es peor que no tenerla. Un formato que `aHoraArgentina` no
 * reconoce vuelve tal cual, que es como se comportaba antes.
 */
export function textoDeAgotado(agente: AgentId, resets?: string): string {
  const quien = agente.toUpperCase();
  return resets
    ? `${quien} se quedo sin tokens. La cuenta vuelve ${aHoraArgentina(resets)}.`
    : `${quien} se quedo sin tokens.`;
}

/**
 * Como cambiar de Claude desde el mensaje de error.
 *
 * ## Por que casi siempre es el menu y no un slot
 *
 * La primera version ofrecia "Seguir con C2" y nada mas, y un test la tiro
 * abajo: para cuando este mensaje se escribe, `ejecutarTurnoConRelevo` YA
 * probo los otros slots —hasta tres— y los marco agotados a todos. O sea que
 * el boton que ofrecia el slot siguiente no tenia, en el caso normal, ningun
 * slot que ofrecer.
 *
 * Eso no significa que no haya nada que ofrecer: significa que lo util es
 * MOSTRAR el estado, no proponer un salto. El menu dice cual esta agotado y
 * hasta que hora, y deja elegir. Por eso el boton del menu va siempre.
 *
 * Un slot suelto se ofrece igual cuando de verdad quedo alguno sin probar —hay
 * mas slots que el tope de relevos, o el gateway lo listo despues— porque ahi
 * es un toque en vez de tres.
 */
async function botonesDeRelevo(
  agotado: AgentId,
  proyecto: string,
  deps: Pick<PipelineDeps, 'store' | 'listarAgentes'>,
): Promise<Boton[][]> {
  const menu: Boton[][] = [[{ label: '🔀 Elegir otro agente', data: datosDeMenu() }]];

  let candidatos: { id: AgentId; arriba: boolean; cuenta: boolean; ocupado?: boolean }[] = [];
  try {
    candidatos = await deps.listarAgentes(proyecto);
  } catch {
    // Sin gateway no se puede saber quien esta libre, pero el menu se ofrece
    // igual: sabe caerse solo a "todos apagados" y sigue mostrando los nombres.
    return menu;
  }

  const sinTokens = await deps.store.slotsAgotados().catch(() => new Map<string, unknown>());
  // `!c.ocupado`: ofrecer "seguir con C2" cuando C2 lo esta usando otra persona
  // manda a chocar contra un segundo 409. Es el mismo aviso dos veces y ningun
  // camino de salida.
  const libres = candidatos
    .filter((c) => c.cuenta && !c.ocupado && c.id !== agotado && !sinTokens.has(c.id))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  return [
    ...libres.map((c) => [
      { label: `Seguir con ${c.id.toUpperCase()}`, data: datosDeAgente(c.id) },
    ]),
    ...menu,
  ];
}

/**
 * El pedido al agente, con el token del turno.
 *
 * Se extiende aca y no en `@multicodigo/shared` porque el token es cosa del
 * TRANSPORTE panel -> bridge -> gateway y no del contrato con el agente: el
 * gateway lo saca del cuerpo antes de reenviarlo, asi que el agente nunca ve
 * este campo. Meterlo en PromptRequest diria lo contrario.
 */
export type PromptConToken = PromptRequest & {
  githubToken?: string;
  /**
   * El modo de permisos del turno.
   *
   * Se extiende aca y no en `@multicodigo/shared` por lo mismo que el token:
   * ese contrato vive en un paquete publicado por tag, y agregarle un campo
   * obliga a publicarlo y actualizarlo en los tres servicios antes de que nada
   * ande. El agente lo lee al lado de `PromptRequest`, y zod descarta lo que no
   * declara sin fallar.
   */
  modo?: ModoPermiso;
  /**
   * La CLAVE del modelo (`sonnet`), no su id.
   *
   * El id lo resuelve el agente contra su propia lista: es quien habla con el
   * SDK, y mandarlo desde aca dejaria dos lugares que hay que actualizar cuando
   * un modelo se retira.
   */
  modelo?: ClaveDeModelo;
  documentos?: Array<{ nombre: string; ruta: string; ruta_texto?: string | null }>;
};

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
  /**
   * Cuanto se le pregunta antes de actuar.
   *
   * Del CHAT y no del proyecto: es una preferencia de quien lee las preguntas.
   * Ausente = el default del agente, que es el mas estricto.
   */
  modo?: ModoPermiso;
  /** Con que modelo corre. Ausente = el default del CLI de Claude. */
  modelo?: ClaveDeModelo;
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
  /**
   * Los documentos del proyecto, con URLs firmadas por el panel.
   *
   * El bridge no los mira ni los guarda: los reenvia al gateway, igual que el
   * token. Las URLs vencen en una hora, asi que no sirven guardadas.
   */
  documentos?: Array<{ nombre: string; ruta: string; ruta_texto?: string | null }>;
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
    /**
     * El codigo del agente (`usage_limit`, `auth_expired`, ...).
     *
     * `readonly` y no solo el `message` de Error: quien decide si relevar tiene
     * que poder preguntar por el codigo, y comparar contra `message` obliga a
     * confiar en que nadie le agregue un prefijo.
     */
    readonly codigo: string,
    /**
     * Cuando vuelve la cuenta, si el aviso lo decia. Solo en `usage_limit`.
     *
     * Viaja hasta aca desde el agente para que el mensaje pueda decir "vuelve
     * a la 1:30am" en vez de "proba mas tarde", que no le dice a nadie si son
     * dos minutos o cinco horas.
     */
    readonly resets?: string,
    /**
     * Quien tiene el slot. Solo en `agente_ocupado`.
     *
     * Es un `usuarioId` crudo: el gateway no puede traducirlo a un nombre
     * porque no le habla a Supabase. Lo traduce quien arma el mensaje.
     */
    readonly duenio?: { usuarioId?: string; desde?: number },
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

/** Cuantos slots se prueban antes de darse por vencido. */
const TOPE_DE_RELEVOS = 3;

/**
 * Corre el turno, y si el slot se queda sin tokens lo sigue otro.
 *
 * Envuelve a `ejecutarTurno` en vez de meterle la logica adentro: ese hace UNA
 * cosa —el ciclo de vida de un turno: crear el job, colgar el poller, guardar la
 * sesion, cerrar— y el relevo es correr ese ciclo mas de una vez.
 *
 * Cada intento es su propio job, y es a proposito: en la actividad del panel
 * queda "c1 se quedo sin tokens" y despues "c2 lo continuo", que es lo que hace
 * falta para entender una respuesta que llego de otro agente.
 *
 * El contexto se reinyecta como texto porque no se puede resumir la sesion desde
 * otro slot. Ver relevo.ts.
 */
export async function ejecutarTurnoConRelevo(
  deps: PipelineDeps,
  t: Turno,
): Promise<{ jobId: string; texto: string; relevos: string[]; agente: AgentId }> {
  const probados: string[] = [];
  const relevos: string[] = [];
  let turno = t;

  for (let intento = 0; intento < TOPE_DE_RELEVOS; intento++) {
    probados.push(turno.agente);
    try {
      const r = await ejecutarTurno(deps, turno);
      // `turno.agente` y no `t.agente`: despues de un relevo son distintos, y
      // el que importa es el que contesto.
      return { ...r, relevos, agente: turno.agente };
    } catch (err) {
      const codigo = err instanceof ErrorDeTurno ? err.codigo : '';
      // Solo por tokens. Cualquier otro fallo se propaga: relevar un
      // `worktree_dirty` o un `git_failed` lo unico que hace es repetir el mismo
      // error en otro slot y esconder la causa.
      if (codigo !== 'usage_limit') throw err;

      const siguiente = await elegirRelevo(deps, turno.proyecto, probados);
      if (!siguiente) throw err;

      // El hilo del slot que se agoto, no del que releva: es donde esta lo que
      // venia pasando.
      const historia = turno.proyectoId
        ? await deps.store
            .turnosRecientes(turno.proyectoId, turno.agente, 12)
            .catch(() => [])
        : [];

      relevos.push(`${turno.agente} -> ${siguiente}`);
      turno = {
        ...turno,
        agente: siguiente as Turno['agente'],
        prompt: promptDeRelevo(t.prompt, historia, turno.agente),
      };
    }
  }

  // Se agoto el tope. Se corre el ultimo intento sin atrapar nada para que el
  // error que llegue al usuario sea el de verdad y no un "no quedan slots".
  return { ...(await ejecutarTurno(deps, turno)), relevos, agente: turno.agente };
}

/** Los candidatos que conoce el gateway, o ninguno si no se le puede preguntar. */
async function elegirRelevo(
  deps: PipelineDeps,
  proyecto: string,
  probados: readonly string[],
): Promise<string | undefined> {
  if (!deps.listarAgentes) return undefined;
  try {
    return proximoSlot(await deps.listarAgentes(proyecto), probados);
  } catch {
    // Si el gateway no contesta, no hay relevo: el error original sube y dice
    // que paso. Inventar un slot seria peor.
    return undefined;
  }
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
    const r = await deps.ask(
      {
        jobId,
        agent: t.agente,
        project: t.proyecto,
        prompt: t.prompt,
        sessionId,
        repos: t.repos,
        githubToken: t.githubToken,
        documentos: t.documentos,
        // En el CUERPO y no en un header, al contrario de quien pide el turno:
        // el modo lo necesita el agente, que es quien decide si pregunta. El
        // gateway le reenvia el cuerpo, asi que llega sin que nadie lo copie.
        modo: t.modo,
        modelo: t.modelo,
      },
      { usuarioId: t.usuarioId, chatId: t.chatId },
    );
    // La red de seguridad. El agente ya mira este mismo cartel y deberia haber
    // tirado `usage_limit` antes de llegar aca; esto existe porque el 2026-09-02
    // NO lo hizo y el aviso se guardo como una respuesta buena, en ingles y sin
    // relevo. Que el agente falle en reconocerlo no puede volver a significar
    // que el sistema entero se lo coma.
    //
    // Se tira ANTES de guardar la sesion y de cerrar el job: el `catch` de abajo
    // lo cierra como `failed` con el codigo correcto, y el relevo lo agarra.
    if (esAvisoDeLimite(r.text)) {
      const e = new Error('usage_limit') as Error & { resets?: string };
      e.resets = horaDeReset(r.text);
      throw e;
    }

    if (t.proyectoId) await deps.store.setSession(t.proyectoId, t.agente, r.sessionId);
    // El consumo del turno, si el agente lo mando. Es lo que despues suma
    // `consumoPorAgente` para mostrar cuanto gasto cada uno.
    const consumo =
      r.tokens !== undefined || r.costoUsd !== undefined
        ? { tokens: r.tokens ?? 0, costoUsd: r.costoUsd ?? 0 }
        : undefined;
    await deps.store.finishJob(jobId, 'done', undefined, r.text, consumo);
    // Un turno que salio bien PRUEBA que la cuenta tiene tokens, y es la unica
    // prueba que existe. Por eso la marca se borra aca y no con un reloj: se
    // limpia sola en cuanto el slot vuelve a trabajar.
    //
    // `catch` vacio: la marca es un adorno del menu, y no puede voltear un
    // turno que ya salio bien y que el usuario esta esperando.
    await deps.store.limpiarAgotado(t.agente).catch(() => {});
    return { jobId, texto: r.text };
  } catch (err) {
    const codigo = err instanceof Error ? err.message : 'internal';
    const resets = err instanceof Error ? (err as { resets?: string }).resets : undefined;
    const duenio =
      err instanceof Error
        ? (err as { duenio?: { usuarioId?: string; desde?: number } }).duenio
        : undefined;
    await deps.store.finishJob(jobId, 'failed', codigo);
    if (codigo === 'usage_limit') {
      // Se anota ANTES de relevar: el relevo puede tardar minutos, y si el
      // proceso se cae en el medio la marca ya quedo. Al reves se perderia
      // justo en el caso en que mas hace falta.
      await deps.store.marcarAgotado(t.agente, resets).catch(() => {});
    }
    throw new ErrorDeTurno(jobId, codigo, resets, duenio);
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
export async function armarMenu(
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
  let estados: { id: AgentId; arriba: boolean; cuenta: boolean; ocupado?: boolean }[] = [];
  try {
    estados = await deps.listarAgentes(proyecto.nombre);
  } catch {
    estados = [];
  }

  // Los agotados salen de la base y no del gateway: el gateway sabe que
  // contenedores hay y si tienen cuenta cargada, pero no cuanto le queda a esa
  // cuenta. Eso lo aprende el bridge cuando un turno se choca con el limite.
  //
  // Un fallo aca no puede voltear el menu: sin esto se muestra lo de antes, que
  // es todo como disponible. Es el mismo criterio con el que se trata al
  // gateway caido dos lineas mas arriba.
  const agotados = await deps.store.slotsAgotados().catch(() => new Map());

  const porSlot = new Map(estados.map((e) => [e.id, e]));
  const conEstado = registrados.map((a) => {
    const estado = porSlot.get(a.slot);
    const sinTokens = agotados.get(a.slot);
    return {
      ...a,
      agotado: sinTokens ? { resets: sinTokens.resets } : undefined,
      arriba: estado?.arriba ?? false,
      // Quien sabe si el slot tiene cuenta es el gateway: el marcador lo
      // escribe el servicio de login, en la VM. La columna `cuenta` de la tabla
      // es el respaldo para cuando el gateway no contesta, y hoy nadie la
      // llena, asi que sin gateway el menu muestra todo como "sin cuenta". Es
      // el lado correcto para equivocarse: un boton que no anda es peor que uno
      // que avisa.
      tieneCuenta: estado?.cuenta ?? Boolean(a.cuenta),
      // Ocupado por otro. Sin gateway se asume que no: mostrar todo como
      // ocupado dejaria el menu sin ningun boton que tocar, que es peor que
      // ofrecer uno que puede chocar contra un 409 y avisar.
      ocupado: estado?.ocupado ?? false,
    };
  });

  return {
    kind: 'menu_agentes',
    proyecto: proyecto.nombre,
    botones: tecladoDeAgentes(conEstado),
  };
}

/**
 * Recorre la cola de un chat, una tarea por vez, hasta que no queda nada.
 *
 * ## Por que de a una y no en paralelo
 *
 * Podria repartir entre agentes —hay varios— pero las tareas de una lista
 * suelen depender de la anterior ("arregla el bug", "ahora corre los tests"), y
 * hacerlas juntas sobre el mismo worktree es pisarse. Ademas el slot lo toma
 * una persona a la vez: dos tareas del mismo chat contra el mismo agente
 * chocarian con el 409 de la tenencia.
 *
 * ## Por que se detiene ante un fallo
 *
 * Seguir con la siguiente cuando la anterior no salio es hacer trabajo sobre
 * una base que nadie miro. Se avisa y se deja lo que queda como pendiente, para
 * que se pueda retomar o cancelar.
 *
 * ## Por que no hay `await` afuera
 *
 * Quien la dispara no la espera: una cola de cinco tareas puede tardar media
 * hora, y el handler de Telegram tiene que contestar ya. El progreso llega por
 * `avisar`.
 */
export async function correrCola(
  chatId: number,
  deps: PipelineDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<void> {
  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return;

  for (;;) {
    const tarea = await deps.store.tomarProxima(chatId);
    if (!tarea) return;

    const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
    const proyectoId = proyectos.find((p) => p.nombre === tarea.proyecto)?.id;
    const repos = proyectoId ? await deps.store.reposDeProyecto(proyectoId) : undefined;
    const githubToken = await tokenDelProyecto(proyectoId, deps);
    const documentos =
      proyectoId
        ? await deps.store.documentosDeProyecto(proyectoId).catch(() => undefined)
        : undefined;
    const modo = await deps.store.modoDeChat(chatId).catch(() => undefined);
    const modelo = await deps.store.modeloDeChat(chatId).catch(() => undefined);

    try {
      const r = await ejecutarTurnoConRelevo(deps, {
        proyectoId,
        proyecto: tarea.proyecto,
        agente: tarea.agente as AgentId,
        usuarioId,
        prompt: tarea.texto,
        modo,
        modelo,
        repos,
        githubToken,
        documentos,
        origen: 'telegram',
        chatId,
      });
      await deps.store.cerrarTarea(tarea.id, 'lista', r.texto);
      await avisar(`✅ ${tarea.texto}

${sanitizeForTelegram(r.texto)}`);
    } catch (err) {
      const codigo = err instanceof Error ? err.message : 'internal';
      await deps.store.cerrarTarea(tarea.id, 'fallida', codigo);
      // Se cuenta lo que queda ANTES de avisar: el mensaje dice cuanto se
      // detuvo, que es lo que decide si se retoma o se cancela.
      const quedan = (await deps.store.tareasDeChat(chatId)).filter(
        (t) => t.estado === 'pendiente',
      ).length;
      await avisar(
        `⛔ Fallo: ${tarea.texto}

${ERROR_TEXT[codigo] ?? codigo}

` +
          (quedan > 0
            ? `Pare la cola con ${quedan} tarea(s) sin hacer. Mandame /cola para verlas o /cancelar para descartarlas.`
            : 'Era la ultima de la cola.'),
      );
      return;
    }
  }
}
