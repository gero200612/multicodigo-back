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
import { separarInstructivo, type DocumentoConMarca } from './documentos.js';
import {
  tecladoDeProyectos,
  tecladoDeAgentes,
  tecladoDeAcciones,
  tecladoDeDesvincular,
  tecladoDeOrgs,
  datosDeAgente,
  datosDeMenu,
} from './menu.js';
import type { Boton } from './render.js';
import type { Store, Proyecto, ModoPermiso, ModoDeTurno, ClaveDeModelo } from './store.js';
import { partirEnTareas, type Tarea } from './cola.js';
import { horaArgentinaDe } from './horas.js';
import {
  parseOpcionesDeCorrida,
  cuandoReintentar,
  limiteDeHora,
  promptDePlan,
  TECHO_RONDAS_POR_DEFECTO,
  TECHO_HORA_POR_DEFECTO,
  SIN_RESPUESTA,
  type OpcionesDeCorrida,
  promptDeAnalisis,
  techoAlcanzado,
  textoDeInforme,
  type Corrida,
  type MotivoDeCierre,
  type ResumenDeTareas,
} from './corrida.js';
import { aHoraArgentina } from './horas.js';
import { conCodigoParaTelegram, escaparHtml } from './codigo.js';
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
   * Le pide al panel que cree un repo en GitHub.
   *
   * Opcional por lo mismo que `firmarToken`: la firma la tiene el panel. Pero
   * a diferencia de aquella, sin esto NO hay degradacion posible — si no se
   * puede crear el repo, no hay repo. Por eso devuelve el motivo en vez de
   * `undefined`: la persona tiene que poder leer que falto.
   */
  crearRepo?: (
    installationId: number,
    nombre: string,
    descripcion?: string,
  ) => Promise<{ ok: true; nombre: string; github: string } | { ok: false; code: string }>;
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
  /**
   * Con quien hablas, y —si hay una corrida— como va.
   *
   * La corrida es opcional porque `/status` sirve para las dos cosas: sin
   * corrida es lo de siempre. Con una abierta, lo que se pregunta a las tres de
   * la mañana no es a que agente le hablas sino si todavia esta trabajando.
   */
  | {
      kind: 'status';
      agent: AgentId;
      otros: AgentId[];
      corrida?: Corrida;
      /** Como viene la cola de esa corrida. Ver `ResumenDeTareas`. */
      tareas?: ResumenDeTareas;
      /** Lo que esta haciendo ahora, si hay una tarea tomada. */
      haciendo?: string;
      /** Cuando corta por hora. Se muestra el tiempo que falta. */
      limite?: Date;
    }
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
  /**
   * Una corrida desatendida.
   *
   * `abierta` distingue los tres casos que contesta el mismo comando: recien
   * abierta, ya habia una —y no se abre otra—, y `/corrida` a secas para mirar.
   */
  | {
      kind: 'corrida';
      corrida?: Corrida;
      recienAbierta: boolean;
      /** Habia una abierta y por eso no se abrio la nueva. */
      yaHabia: boolean;
      /** Lo que se creo de paso: el proyecto y los repos. Ver `armarProyecto`. */
      creado?: LoCreado;
    }
  /**
   * No se pudo armar el proyecto, asi que NO se abrio la corrida.
   *
   * Separado de `error` porque casi siempre es algo que la persona resuelve
   * —falta un permiso, la org no esta conectada, el nombre esta repetido— y
   * porque lo importante es lo que NO paso: no hay una corrida a medias
   * esperando la noche.
   */
  | { kind: 'corrida_sin_armar'; motivo: string }
  /**
   * Hay que elegir en que organizacion nacen los repos, y todavia no se eligio.
   *
   * Se pregunta con BOTONES y una sola vez: despues queda guardada. Antes esto
   * era un mensaje que pedia escribir `org=<cuenta>` a mano, o sea un dato que
   * no cambia entre corridas escrito de nuevo cada vez.
   */
  | { kind: 'corrida_elegir_org'; cuentas: string[]; botones: Boton[][]; error?: string }
  /**
   * Un paso del `/corrida` conversacional: lo que hay que contestar ahora.
   *
   * `error` cuando lo que llego no sirvio y se vuelve a preguntar lo mismo.
   */
  | {
      kind: 'corrida_paso';
      paso: 'nombre' | 'pliego';
      error?: string;
      /** Lo que se creo al pasar del nombre al pliego. */
      creado?: LoCreado;
    }
  /**
   * La corrida se abrio y hay que planificarla.
   *
   * Es un outcome propio porque quien lo recibe tiene TRABAJO que hacer: correr
   * el turno de planificacion, que tarda minutos. El pipeline no lo corre solo
   * —igual que la cola— porque el handler de Telegram tiene que contestar ya.
   */
  | { kind: 'corrida_planificando'; corrida: Corrida }
  | { kind: 'cola_cancelada'; cuantas: number; corridaCerrada: boolean }
  /**
   * Un `/proyecto <nombre>` que no es ninguno de los de la persona.
   *
   * Separado de `error` porque no es una falla del sistema: es un dedazo, y la
   * salida es elegir de la lista. Existe porque antes NO existia — el nombre se
   * guardaba igual y el chat quedaba apuntando a un proyecto inexistente, que
   * es peor que un error: el agente pierde sesion, repos y documentos sin decir
   * nada.
   */
  | {
      kind: 'project_desconocido';
      pedido: string;
      mios: Proyecto[];
      botones: Boton[][];
    }
  /**
   * El proyecto activo del chat.
   *
   * `mios` y `botones` van SIEMPRE aunque el mensaje solo nombre uno: el
   * mensaje de "cambiaste a X" tambien se lee para saber a que otro se puede
   * cambiar, y sin la lista hay que acordarse los nombres de memoria.
   * `cambiado` distingue "lo cambie" de "te digo cual es".
   */
  | {
      kind: 'project';
      project: string;
      mios?: Proyecto[];
      botones?: Boton[][];
      cambiado?: boolean;
    }
  /** El chat no esta atado a ninguna cuenta del panel. */
  /**
   * El chat no esta atado a ninguna cuenta, o ya lo esta.
   *
   * `botones` solo cuando YA estaba: es el de desvincular. Antes este mensaje
   * era un callejon —decia "ya esta vinculado" y nada mas— y desatarlo solo se
   * podia desde el panel.
   */
  | { kind: 'sin_vincular'; yaEstaba: boolean; botones?: Boton[][] }
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
    if (usuarioId) {
      return { kind: 'sin_vincular', yaEstaba: true, botones: tecladoDeDesvincular() };
    }
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
    const mios = await deps.store.proyectosDeUsuario(usuarioId);

    // Sin nombre: la LISTA con botones, no solo el activo.
    //
    // Antes contestaba "Proyecto activo: X." y nada mas, que es un callejon:
    // para cambiar hay que escribir el nombre exacto, y el nombre exacto es
    // justo lo que no se ve en ningun lado. El boton lo elige de una lista
    // real, asi que no se puede escribir mal.
    if (!command.project) {
      const activo = await proyectoDelChat(input.chatId, usuarioId, deps);
      return { kind: 'project', project: activo, mios, botones: tecladoDeProyectos(mios) };
    }

    // El nombre se VALIDA contra los proyectos de la persona, y esto es lo que
    // faltaba: `setActiveProject` guarda el string que le den, asi que un
    // `/proyecto punchii` con un dedazo dejaba el chat apuntando a un proyecto
    // que no existe. Y no fallaba: `proyectoId` quedaba en undefined, o sea sin
    // sesion (el agente arranca de cero en cada mensaje), sin repos y sin
    // documentos, sin un solo error que lo explique. Se veia como un agente que
    // de golpe se volvio tonto.
    //
    // La comparacion es SIN mayusculas y se guarda el nombre canonico: hay un
    // proyecto que se llama "Punchi" con mayuscula, y `/proyecto punchi` es
    // exactamente el dedazo que mas se va a escribir.
    const elegido = mios.find(
      (p) => p.nombre.toLowerCase() === command.project!.toLowerCase(),
    );
    if (!elegido) {
      return { kind: 'project_desconocido', pedido: command.project, mios, botones: tecladoDeProyectos(mios) };
    }

    await deps.store.setActiveProject(input.chatId, elegido.nombre);
    return { kind: 'project', project: elegido.nombre, mios, cambiado: true };
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
    const proyecto = await proyectoDelChat(input.chatId, usuarioId, deps);
    const n = await deps.store.encolar(input.chatId, { agente, proyecto, textos: tareas });
    return {
      kind: 'cola',
      tareas: await deps.store.tareasDeChat(input.chatId),
      encoladas: n,
      agente,
    };
  }

  if (command.kind === 'corrida') {
    // El borrador se mira ANTES de parsear, y es lo que hace que el paso a paso
    // funcione: con uno en curso, lo que venga atras de /corrida es la RESPUESTA
    // al paso y no un pliego. Sin este orden, `acme` se parsea como el pliego
    // —no es una opcion `x=y`, asi que cae en el MD— y el paso 1 abriria una
    // corrida con una palabra de pliego.
    if (await deps.store.borradorDeChat(input.chatId)) {
      return await pasoDeCorrida({ chatId: input.chatId, texto: command.texto }, usuarioId, deps);
    }

    const opciones = parseOpcionesDeCorrida(command.texto);
    const { md, techoRondas, techoHora } = opciones;
    const abierta = await deps.store.corridaAbierta(input.chatId);

    // Sin pliego y CON una corrida abierta: "mostrame como va".
    if (md === '' && abierta) {
      return { kind: 'corrida', corrida: abierta, recienAbierta: false, yaHabia: false };
    }
    // Sin pliego y sin corrida: arranca el paso a paso.
    //
    // Las OPCIONES se guardan antes de arrancarlo, y eso no es un detalle: sin
    // esto habia un circulo cerrado del que no se salia.
    //
    // Con mas de una cuenta conectada, el sistema pide
    // `/corrida proyecto=X org=Y`. Pero ese comando no trae pliego, y "sin
    // pliego" significaba "arranca el paso a paso" tirando las dos opciones.
    // Entonces el paso volvia a preguntar el nombre, y al contestarlo el
    // sistema volvia a no saber la org y pedia lo mismo otra vez. La persona
    // hacia exactamente lo que el mensaje le pedia y no pasaba nada.
    if (md === '') {
      return await pasoDeCorrida(
        {
          chatId: input.chatId,
          texto: '',
          ...(opciones.proyecto ? { proyecto: opciones.proyecto } : {}),
          ...(opciones.org ? { org: opciones.org } : {}),
        },
        usuarioId,
        deps,
      );
    }
    // Con pliego y una ya abierta: NO se abre otra. Dos corridas sobre el mismo
    // chat competirian por los mismos slots y ninguna de las dos terminaria.
    if (abierta) {
      return { kind: 'corrida', corrida: abierta, recienAbierta: false, yaHabia: true };
    }

    // El proyecto: el activo, o uno NUEVO si se pidio con `proyecto=`.
    //
    // El armado va antes de abrir la corrida y no despues, y eso decide como se
    // ve un fallo: si el proyecto o los repos no se pueden crear, no queda una
    // corrida abierta sobre un proyecto a medias — no queda nada, y el mensaje
    // dice que falto. Al reves, la corrida arrancaria a la noche contra un
    // worktree sin repos y el informe de la mañana no explicaria por que.
    const armado = await armarProyecto(input.chatId, usuarioId, opciones, deps);
    if (!armado.ok) return { kind: 'corrida_sin_armar', motivo: armado.motivo };

    const nueva = await deps.store.abrirCorrida({
      chatId: input.chatId,
      proyecto: armado.proyecto,
      md,
      techoRondas,
      techoHora,
    });
    // `undefined` = la base rechazo el INSERT por el indice unico, o sea que
    // otro `/corrida` gano la carrera entre el SELECT de arriba y esto. Se
    // contesta lo mismo que si el chequeo la hubiera visto.
    if (!nueva) {
      return {
        kind: 'corrida',
        corrida: await deps.store.corridaAbierta(input.chatId),
        recienAbierta: false,
        yaHabia: true,
      };
    }
    // Los pendientes recien ahora: la corrida acaba de nacer, y antes no habia
    // a que fila anotarlos.
    for (const p of armado.creado.pendientes ?? []) {
      await deps.store.anotarPendiente(nueva.id, p);
    }
    return {
      kind: 'corrida',
      corrida: nueva,
      recienAbierta: true,
      yaHabia: false,
      creado: armado.creado,
    };
  }

  if (command.kind === 'cola_cancelar') {
    const n = await deps.store.cancelarCola(input.chatId);
    // Y la corrida, si habia una. Sin esto la cola queda vacia, el ciclo la ve
    // vacia con una corrida abierta, y arranca un analisis: cancelar
    // resucitaria el trabajo que se acaba de cancelar.
    const abierta = await deps.store.corridaAbierta(input.chatId);
    if (abierta) await deps.store.cerrarCorrida(abierta.id, 'cancelada');
    // Y el borrador. Sin esto el chat quedaba ATRAPADO: mientras hay un
    // `/corrida` a medias, todo mensaje se lee como la respuesta al paso, y
    // `/cancelar` —lo unico que la gente prueba para salir— no lo borraba. El
    // sintoma fue un chat contestando "ese nombre no sirve" a cualquier cosa,
    // sin salida.
    await deps.store.borrarBorrador(input.chatId).catch(() => undefined);
    return { kind: 'cola_cancelada', cuantas: n, corridaCerrada: Boolean(abierta) };
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
    const corrida = await deps.store.corridaAbierta(input.chatId);
    if (!corrida) return { kind: 'status', agent: primario, otros };

    // Las tareas de la CORRIDA y no las del chat: una cola dictada a mano antes
    // de abrirla no es parte de esta noche, y contarla haria que el resumen no
    // coincida con el informe de la mañana.
    const tareas = await deps.store.tareasDeCorrida(corrida.id);
    const corriendo = tareas.find((t) => t.estado === 'corriendo');
    return {
      kind: 'status',
      agent: primario,
      otros,
      corrida,
      tareas: {
        hechas: tareas.filter((t) => t.estado === 'lista').length,
        fallidas: tareas.filter((t) => t.estado === 'fallida').length,
        pendientes: tareas.filter((t) => t.estado === 'pendiente').length,
        sinResolver: [],
      },
      ...(corriendo ? { haciendo: corriendo.texto } : {}),
      limite: limiteDeHora(corrida.creadoEn, corrida.techoHora),
    };
  }

  const agent =
    command.agent ?? (await deps.store.getActiveAgent(input.chatId)) ?? deps.defaultAgent;
  // El proyecto del turno: lo que eligio el chat, o el default del bridge.
  const project = await proyectoDelChat(input.chatId, usuarioId, deps);

  // El id del proyecto, para poder compartir el hilo con el panel. Puede no
  // existir —un proyecto de config/projects.json que nunca se creo desde el
  // panel— y en ese caso el turno corre igual, pero sin sesion compartida: no
  // hay clave con que guardarla.
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  // Sin mayusculas, igual que en `proyectoDelChat`: el nombre puede venir del
  // default del bridge o de un `chat_state` viejo, y una `S` de diferencia deja
  // el turno sin sesion, sin repos y sin documentos.
  const proyectoId = proyectos.find(
    (p) => p.nombre.toLowerCase() === project.toLowerCase(),
  )?.id;

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
      text: conCodigoParaTelegram(r.texto),
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
  modo?: ModoDeTurno;
  /**
   * La CLAVE del modelo (`sonnet`), no su id.
   *
   * El id lo resuelve el agente contra su propia lista: es quien habla con el
   * SDK, y mandarlo desde aca dejaria dos lugares que hay que actualizar cuando
   * un modelo se retira.
   */
  modelo?: ClaveDeModelo;
  documentos?: DocumentoConMarca[];
  /**
   * El instructivo del proyecto, aparte de `documentos`.
   *
   * Aparte y no un flag adentro del arreglo porque el consumidor es otro: de
   * `documentos` sale una copia a `_docs` del worktree, y de esto sale el texto
   * que el gateway lee y le mete al system prompt. Con un campo propio, "hay a
   * lo sumo uno" lo dice el tipo.
   *
   * Sigue siendo una RUTA y no el texto: el unico proceso que monta `/srv/docs`
   * —y el que tiene la validacion de rutas— es el gateway.
   */
  instrucciones?: DocumentoConMarca;
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
   *
   * `ModoDeTurno` y no `ModoPermiso` porque adentro de una corrida el ciclo
   * manda `desatendido`, que nadie puede elegir con /permisos. Ver
   * `MODO_DESATENDIDO` en store.ts.
   */
  modo?: ModoDeTurno;
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
   * Los documentos del proyecto: rutas en el disco que el panel y el gateway
   * montan los dos.
   *
   * El bridge no los mira ni los guarda: los reenvia al gateway, igual que el
   * token. Incluye al instructivo, para que el gateway lo copie a `_docs`.
   */
  documentos?: DocumentoConMarca[];
  /**
   * El instructivo del proyecto, aparte.
   *
   * Aparte y no un flag adentro del arreglo porque el consumidor es otro: de
   * `documentos` sale una copia al worktree, y de esto sale el texto que va al
   * system prompt. Con un campo propio, "hay a lo sumo uno" lo dice el tipo y
   * el gateway no tiene que filtrar la lista ni acordarse de la regla.
   *
   * Sigue siendo una RUTA y no el texto: el que lee el archivo es el gateway,
   * que es el unico que monta `/srv/docs`.
   */
  instrucciones?: DocumentoConMarca;
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

/**
 * Cuantos slots se prueban antes de darse por vencido.
 *
 * Subio de 3 a 10, que es mas que los slots que hay: el punto es probar TODOS.
 * Con 3 y seis cuentas cargadas, una corrida se daba por vencida con la mitad
 * de los tokens sin usar — y el informe decia "se agotaron los tokens de todas
 * las cuentas", que no era cierto.
 *
 * El tope sigue existiendo porque `elegirRelevo` puede devolver algo raro y un
 * bucle sin techo es un bucle infinito. Diez es "todos los que puede haber, mas
 * margen".
 */
const TOPE_DE_RELEVOS = 10;

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
    // El instructivo del proyecto se separa ACA y no en cada camino de entrada.
    //
    // Es el unico lugar por el que pasan los dos —el turno del panel, que trae
    // los documentos en el pedido, y el de Telegram, donde los junta el
    // bridge— asi que separar aca es lo que hace que el bot tenga instructivo
    // sin duplicar la logica. El instructivo viaja ADEMAS adentro de
    // `documentos`, para que el gateway lo copie a `_docs` y el agente lo pueda
    // citar. Ver
    // `multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md`.
    const separados = separarInstructivo(t.documentos);

    const r = await deps.ask(
      {
        jobId,
        agent: t.agente,
        project: t.proyecto,
        prompt: t.prompt,
        sessionId,
        repos: t.repos,
        githubToken: t.githubToken,
        documentos: separados.documentos,
        instrucciones: separados.instrucciones,
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
 * El proyecto sobre el que trabaja un chat.
 *
 * El que eligio, o —si nunca eligio y tiene UNO SOLO— ese, o el default del
 * bridge.
 *
 * ## Por que el medio no es un lujo
 *
 * Sin ese caso, un chat recien vinculado cae en `demo`: el default global, que
 * no es de nadie. Paso en produccion — alguien vinculo su chat, pidio trabajo
 * sobre SU proyecto, y los turnos corrieron contra `demo` con el worktree de
 * otro. El error que vio fue `worktree_failed`, tres capas abajo de la causa y
 * sin ninguna relacion con lo que hizo.
 *
 * Y se GUARDA, no solo se devuelve: si no, cada mensaje volveria a resolverlo y
 * la pantalla de `/proyecto` seguiria diciendo `demo` mientras los turnos van a
 * otro lado — dos verdades distintas sobre lo mismo.
 *
 * Con mas de uno NO se adivina: elegir por alguien sobre cual de sus proyectos
 * trabaja es peor que preguntarle, porque el trabajo termina en el equivocado y
 * se nota tarde.
 */
async function proyectoDelChat(
  chatId: number,
  usuarioId: string,
  deps: PipelineDeps,
): Promise<string> {
  const mios = await deps.store.proyectosDeUsuario(usuarioId);
  const elegido = await deps.store.getActiveProject(chatId);

  // El elegido se VALIDA contra los proyectos de la persona, y se devuelve el
  // nombre CANONICO. Esto es lo que arregla el fallo silencioso mas caro que
  // tuvo el sistema, asi que vale contarlo entero.
  //
  // El nombre del proyecto activo se guarda como texto en `chat_state`, y todo
  // lo que sigue se resuelve comparandolo con `p.nombre === project`. Una
  // comparacion exacta.
  //
  // Visto en produccion: un chat quedo con `active_project = "sincro"` y
  // despues se revinculo a OTRA cuenta, que tiene un proyecto llamado
  // "Sincro". La comparacion falla por una mayuscula, `proyectoId` queda
  // undefined, y de ahi en adelante el turno corre SIN sesion, SIN repos, SIN
  // documentos y SIN token de GitHub. Ninguna de las cuatro cosas falla: cada
  // una tiene su `if (proyectoId)` y degrada en silencio.
  //
  // Lo que la persona ve es un agente que "responde lo que quiere": dice que es
  // el primer mensaje de la conversacion, no encuentra el codigo, no ve los
  // documentos. Cuatro sintomas que no se parecen entre si ni apuntan a la
  // causa.
  if (elegido) {
    const igual = mios.find((p) => p.nombre.toLowerCase() === elegido.toLowerCase());
    if (igual) {
      // Se reescribe el canonico cuando difiere: si no, el proximo turno vuelve
      // a hacer el mismo baile de mayusculas.
      if (igual.nombre !== elegido) await deps.store.setActiveProject(chatId, igual.nombre);
      return igual.nombre;
    }
    // No es de esta persona. Pasa cuando el chat se revincula a otra cuenta, o
    // cuando el proyecto se borro. NO se devuelve: seguir con el nombre de un
    // proyecto ajeno es justo el estado roto de arriba.
  }

  if (mios.length === 1) {
    await deps.store.setActiveProject(chatId, mios[0]!.nombre);
    return mios[0]!.nombre;
  }
  return deps.project;
}

/**
 * Un paso del `/corrida` conversacional.
 *
 * El comando pedia cinco opciones bien escritas de una sola vez —nombre, org,
 * dos repos, dos referencias— y un dedazo en el medio perdia el comando entero.
 * Ahora se pregunta de a una cosa, y lo que se puede deducir no se pregunta.
 *
 * Lo que NO cambia: el comando largo sigue andando. Quien ya sabe que quiere lo
 * escribe de una, y los tests de eso siguen verdes. Este camino es el que se
 * toma cuando `/corrida` llega sin nada.
 */
export async function pasoDeCorrida(
  input: { chatId: number; texto: string; proyecto?: string; org?: string },
  usuarioId: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const borrador = await deps.store.borradorDeChat(input.chatId);
  const texto = input.texto.trim();

  // Lo que vino en el comando se GUARDA antes de cualquier otra cosa. Es lo que
  // hace que `/corrida proyecto=X org=Y` no se pierda, y que `org=` dicha una
  // vez valga para los pasos siguientes.
  const org = input.org ?? borrador?.org;
  const nombreDado = input.proyecto ?? borrador?.proyecto;
  if (input.org || input.proyecto) {
    await deps.store.guardarBorrador(
      input.chatId,
      borrador?.paso ?? 'nombre',
      input.proyecto,
      input.org,
    );
  }

  // Con el nombre YA dado en el comando, el paso 1 no tiene nada que preguntar:
  // se arma derecho. Es lo que convierte `/corrida proyecto=X org=Y` en un solo
  // mensaje en vez de tres.
  if (!borrador && nombreDado) {
    return await armarYPedirPliego(input.chatId, usuarioId, nombreDado, org, deps);
  }

  // Paso 1: el nombre. Es lo unico que no se puede deducir.
  if (!borrador) {
    await deps.store.guardarBorrador(input.chatId, 'nombre');
    return { kind: 'corrida_paso', paso: 'nombre' };
  }

  // Paso 'org': lo que se escriba es el nombre de la cuenta.
  //
  // El boton hace lo mismo por otro camino (`manejarMenu`), y los dos existen a
  // proposito: el boton es un toque, y escribir es lo que uno hace igual en un
  // chat. Aceptar solo el boton fue lo que dejo a alguien escribiendo
  // "Sincro-arg" tres veces.
  if (borrador.paso === 'org') {
    const cuentas = await deps.store.cuentasConectadas(usuarioId);
    const elegida = cuentas.find((c) => c.cuenta.toLowerCase() === texto.toLowerCase());
    if (!elegida) {
      return {
        kind: 'corrida_elegir_org',
        cuentas: cuentas.map((c) => c.cuenta),
        botones: tecladoDeOrgs(cuentas.map((c) => c.cuenta)),
        ...(texto !== '' ? { error: `no tengo conectada ninguna cuenta que se llame "${texto}"` } : {}),
      };
    }
    await deps.store.setOrgDeCorridas(usuarioId, elegida.cuenta);
    // Y se sigue con el nombre que ya estaba guardado: no hay que volver a
    // pedirlo por haber contestado algo en el medio.
    if (!borrador.proyecto) {
      await deps.store.guardarBorrador(input.chatId, 'nombre', undefined, elegida.cuenta);
      return { kind: 'corrida_paso', paso: 'nombre' };
    }
    return await armarYPedirPliego(
      input.chatId,
      usuarioId,
      borrador.proyecto,
      elegida.cuenta,
      deps,
    );
  }

  if (borrador.paso === 'nombre') {
    if (!nombreDeProyectoValido(texto)) {
      // No se avanza el paso: se vuelve a preguntar. Pero el motivo se dice
      // ESPECIFICO, porque "ese nombre no sirve" no ayuda a nadie.
      //
      // El caso real: la persona escribio "traete sincrostatus del drive"
      // —o sea, no estaba nombrando un proyecto— y recibio tres veces el mismo
      // cartel. Cuando el texto tiene espacios casi nunca es un nombre mal
      // escrito: es alguien que queria otra cosa.
      const motivo = /\s/.test(texto)
        ? 'eso parece un pedido, no el nombre de un proyecto'
        : 'ese nombre no sirve: solo letras, numeros, punto, guion y guion bajo';
      return { kind: 'corrida_paso', paso: 'nombre', error: motivo };
    }

    return await armarYPedirPliego(input.chatId, usuarioId, texto, org, deps);
  }

  // Paso 2: el pliego. Puede llegar como texto o como archivo adjunto —eso lo
  // resuelve el handler de Telegram, que convierte el .md en texto y lo manda
  // por aca.
  if (texto === '') {
    return { kind: 'corrida_paso', paso: 'pliego', error: 'no me llego nada' };
  }

  const proyecto = borrador.proyecto ?? (await deps.store.getActiveProject(input.chatId));
  if (!proyecto) {
    await deps.store.borrarBorrador(input.chatId);
    return { kind: 'corrida_sin_armar', motivo: 'perdi el nombre del proyecto. Empezá de nuevo con /corrida.' };
  }

  const nueva = await deps.store.abrirCorrida({
    chatId: input.chatId,
    proyecto,
    md: texto,
    techoRondas: TECHO_RONDAS_POR_DEFECTO,
    techoHora: TECHO_HORA_POR_DEFECTO,
  });
  await deps.store.borrarBorrador(input.chatId);
  if (nueva) {
    // Los mismos pendientes que en el comando largo. El paso a paso los junto
    // al crear los repos, en el paso del nombre — y los guardo en el borrador
    // no, porque el borrador no los tiene: se recalculan de los repos.
    for (const r of await deps.store.reposDeProyecto(
      (await deps.store.proyectosDeUsuario(usuarioId)).find(
        (p) => p.nombre.toLowerCase() === proyecto.toLowerCase(),
      )?.id ?? '',
    )) {
      if (r.solo_lectura) continue;
      await deps.store.anotarPendiente(
        nueva.id,
        `conectar ${r.github_repo} a Vercel o a Render (la primera vez es a mano; despues cada push hace un preview solo)`,
      );
    }
  }
  if (!nueva) {
    return {
      kind: 'corrida',
      corrida: await deps.store.corridaAbierta(input.chatId),
      recienAbierta: false,
      yaHabia: true,
    };
  }

  // La corrida queda ABIERTA pero la cola no arranca: la dispara el boton de
  // confirmar. Es lo que permite mostrar el plan antes de que empiece a
  // trabajar, y lo que hace que "cancelar" no tenga que deshacer nada.
  return { kind: 'corrida_planificando', corrida: nueva };
}

/**
 * Arma el proyecto y pasa al paso del pliego.
 *
 * Salio del paso 1 porque ahora hay dos formas de llegar: contestando el nombre,
 * o dandolo en el comando (`/corrida proyecto=X`). Duplicado eran dos lugares
 * donde acordarse de guardar el borrador con el nombre canonico.
 */
async function armarYPedirPliego(
  chatId: number,
  usuarioId: string,
  nombre: string,
  org: string | undefined,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const armado = await armarDesdeElNombre(chatId, usuarioId, nombre, org, deps);

  // Falta elegir la org. El borrador se DEJA VIVO —al contrario que en un
  // fallo— porque el nombre ya se dio y no hay que volver a pedirlo: al tocar
  // el boton, el flujo sigue desde acá con lo que ya sabe.
  if (!armado.ok && 'elegirOrg' in armado) {
    // Paso 'org' y no 'nombre': sin un paso propio, el texto que la persona
    // escribe para contestar se lee como el nombre del proyecto, y el sistema
    // vuelve a preguntar la org. Ese era el circulo.
    await deps.store.guardarBorrador(chatId, 'org', nombre);
    return {
      kind: 'corrida_elegir_org',
      cuentas: armado.elegirOrg,
      botones: tecladoDeOrgs(armado.elegirOrg),
    };
  }

  if (!armado.ok) {
    // El borrador se BORRA: el fallo es de configuracion —una cuenta que ya no
    // esta, un permiso que falta— y no se arregla reintentando el mismo
    // nombre. Dejarlo vivo haria que el proximo mensaje del chat se coma como
    // si fuera una respuesta.
    await deps.store.borrarBorrador(chatId);
    return { kind: 'corrida_sin_armar', motivo: armado.motivo };
  }
  await deps.store.guardarBorrador(chatId, 'pliego', armado.proyecto, org);
  return { kind: 'corrida_paso', paso: 'pliego', creado: armado.creado };
}

/** La misma forma que valida el router para `/proyecto`. */
function nombreDeProyectoValido(n: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(n) && n !== '.' && n !== '..' && n.length <= 60;
}

/**
 * Arma el proyecto entero a partir de UN nombre.
 *
 * `acme` se convierte en el proyecto `acme`, los repos `acme-front` y
 * `acme-back`, y las referencias que la persona ya tenga montadas en otro lado.
 *
 * ## Por que la org y las referencias no se preguntan
 *
 * Las dos ya estan en la base. La org sale de las instalaciones de SUS
 * proyectos —si conecto una sola, es esa— y las referencias de los repos que ya
 * marco `solo_lectura` alguna vez. Preguntarlas seria pedir dos veces lo mismo,
 * y escribirlas a mano en cada corrida es donde estaba el dedazo.
 *
 * Cuando hay MAS de una org no se adivina: se pide que la nombre. Elegir por el
 * sistema cual de dos organizaciones recibe el codigo de un cliente es
 * exactamente la clase de decision que no puede tomar un default.
 */
async function armarDesdeElNombre(
  chatId: number,
  usuarioId: string,
  nombre: string,
  orgPedida: string | undefined,
  deps: PipelineDeps,
): Promise<
  | { ok: true; proyecto: string; creado: LoCreado }
  | { ok: false; motivo: string }
  | { ok: false; elegirOrg: string[] }
> {
  const cuentas = await deps.store.cuentasConectadas(usuarioId);
  if (cuentas.length === 0) {
    return {
      ok: false,
      motivo:
        'no tenes ninguna cuenta de GitHub conectada. Conectala una vez desde el panel, ' +
        'en Configuracion, y despues la reuso sola.',
    };
  }

  // El orden de las tres fuentes, y cada una tiene su razon:
  //
  //  1. Lo que se pidio en el comando. Sigue andando para quien lo escribe, y
  //     ADEMAS se guarda como preferencia — asi no hay que repetirlo.
  //  2. La preferencia guardada. Es el camino normal despues de la primera vez.
  //  3. La unica cuenta que hay, si hay una sola. Preguntar por una lista de
  //     uno es un toque para nada.
  //
  // Si no hay ninguna de las tres, se PREGUNTA con botones. Antes se pedia
  // escribir `org=<cuenta>` a mano y eso era el problema.
  const guardada = await deps.store.orgDeCorridas(usuarioId).catch(() => undefined);
  const pedida = orgPedida ?? guardada;

  // Sin mayusculas, por lo mismo que en `/proyecto`: `sincro-arg` tiene que
  // encontrar `Sincro-arg`, porque ese string va a una URL de git.
  const elegida = pedida
    ? cuentas.find((c) => c.cuenta.toLowerCase() === pedida.toLowerCase())
    : cuentas.length === 1
      ? cuentas[0]
      : undefined;

  if (pedida && !elegida) {
    const lista = cuentas.map((c) => c.cuenta).join(', ');
    return {
      ok: false,
      // Se distingue de donde vino el nombre: una preferencia que apunta a una
      // cuenta que ya no esta conectada no es un error de tipeo, y decir "no
      // tenes ninguna que se llame asi" sonaria a que uno la escribio mal.
      motivo: orgPedida
        ? `no tenes conectada ninguna cuenta que se llame "${orgPedida}". Tenes: ${lista}`
        : `la organizacion que tenias elegida ("${pedida}") ya no esta conectada. Tenes: ${lista}`,
    };
  }

  if (!elegida) {
    return { ok: false, elegirOrg: cuentas.map((c) => c.cuenta) };
  }

  // Se GUARDA, y es lo que hace que esto se pregunte una sola vez.
  if (elegida.cuenta !== guardada) {
    await deps.store.setOrgDeCorridas(usuarioId, elegida.cuenta).catch(() => undefined);
  }

  const referencias = await deps.store.referenciasConocidas(usuarioId);
  return armarProyecto(
    chatId,
    usuarioId,
    {
      md: '',
      techoRondas: TECHO_RONDAS_POR_DEFECTO,
      techoHora: TECHO_HORA_POR_DEFECTO,
      proyecto: nombre,
      // La elegida, o la unica que hay. El `!` es seguro: si no hay elegida,
      // los dos `if` de arriba garantizan que `cuentas` tiene exactamente una.
      org: elegida.cuenta,
      // La convencion de nombres. Dos repos y no uno: es como esta armado el
      // proyecto de referencia, y lo que el pliego describe casi siempre tiene
      // las dos mitades.
      repos: [`${nombre}-front`, `${nombre}-back`],
      referencia: referencias,
    },
    deps,
  );
}

/** Lo que se creo al abrir una corrida, para poder contarlo. */
export interface LoCreado {
  /**
   * Los cables que quedaron sueltos por lo que se creo.
   *
   * Se juntan ACA y no se anotan directo porque `armarProyecto` corre ANTES de
   * que exista la corrida —es lo que decidimos para que un fallo no deje una
   * corrida a medias— asi que no hay a que fila anotarlos todavia.
   */
  pendientes?: string[];
  /** El proyecto, si nacio con este comando. */
  proyecto?: string;
  /** Los repos creados en GitHub, como `owner/nombre`. */
  repos: string[];
  /** Los repos de referencia que se montaron, como `owner/nombre`. */
  referencia: string[];
}

/**
 * Arma el proyecto sobre el que va a correr una corrida.
 *
 * Tres cosas, todas opcionales, en este orden: crear el proyecto, heredarle la
 * instalacion de GitHub, crear los repos. Sin ninguna opcion se usa el proyecto
 * activo y esto no hace nada — que es el comportamiento de siempre.
 *
 * ## Por que la instalacion se HEREDA y no se pide de nuevo
 *
 * La instalacion de la App es de la CUENTA, no del proyecto: la fila
 * `github_instalaciones` solo dice a que proyecto aplica una autorizacion que
 * la persona ya dio desde el panel. Copiarla a un proyecto nuevo del MISMO
 * usuario no otorga nada que no estuviera otorgado — y la alternativa es
 * mandarla a GitHub y volver por el callback, o sea salir de Telegram justo
 * cuando lo que se quiere es no salir.
 *
 * El filtro por usuario vive en `instalacionDeCuenta` y es la autorizacion: sin
 * el, nombrar la org de un desconocido alcanzaria para crear repos ahi.
 *
 * ## Por que un fallo cancela todo
 *
 * Si los repos no se pueden crear, no se abre la corrida. Una corrida que
 * arranca a la noche contra un worktree sin repos hace ocho horas de nada, y el
 * informe de la mañana no tendria como explicarlo. Lo que SI queda es lo que ya
 * se creo —el proyecto, los repos que entraron— porque borrarlos seria peor: un
 * repo de GitHub que este proceso borra solo es un accidente esperando pasar.
 */
async function armarProyecto(
  chatId: number,
  usuarioId: string,
  opciones: OpcionesDeCorrida,
  deps: PipelineDeps,
): Promise<{ ok: true; proyecto: string; creado: LoCreado } | { ok: false; motivo: string }> {
  const creado: LoCreado = { repos: [], referencia: [], pendientes: [] };

  // 1. El proyecto.
  let proyecto = await proyectoDelChat(chatId, usuarioId, deps);
  let proyectoId: string | undefined;
  const mios = await deps.store.proyectosDeUsuario(usuarioId);

  if (opciones.proyecto) {
    // Comparacion sin mayusculas, igual que en `/proyecto`: quien escribe
    // `proyecto=stock` sobre un "Stock" existente quiere ESE, no un segundo
    // proyecto con el mismo nombre en otra caja.
    const ya = mios.find((p) => p.nombre.toLowerCase() === opciones.proyecto!.toLowerCase());
    if (ya) {
      proyecto = ya.nombre;
      proyectoId = ya.id;
    } else {
      try {
        proyectoId = await deps.store.crearProyecto(opciones.proyecto, usuarioId);
        proyecto = opciones.proyecto;
        creado.proyecto = opciones.proyecto;
      } catch {
        // El motivo mas probable es el nombre repetido de OTRO usuario: la
        // tabla lo tiene unico y global. Se dice como se arregla en vez de
        // mostrar el error de Postgres.
        return {
          ok: false,
          motivo:
            `no pude crear el proyecto "${opciones.proyecto}". ` +
            'Puede que ya exista uno con ese nombre: proba con otro.',
        };
      }
    }
    await deps.store.setActiveProject(chatId, proyecto);
  } else {
    proyectoId = mios.find((p) => p.nombre.toLowerCase() === proyecto.toLowerCase())?.id;
  }

  if (opciones.repos.length === 0 && opciones.referencia.length === 0) {
    return { ok: true, proyecto, creado };
  }

  // 2. La instalacion de GitHub.
  if (!proyectoId) {
    return { ok: false, motivo: `el proyecto "${proyecto}" no esta en el panel, asi que no se donde crear los repos.` };
  }
  if (!deps.crearRepo) {
    return { ok: false, motivo: 'este bridge no puede crear repos: no tiene con quien firmarlos.' };
  }

  // Con la cuenta: es el `owner` de un repo de referencia, y lo que dice en
  // que org se crean los nuevos.
  const yaTiene = await deps.store.instalacionConCuenta(proyectoId);
  let instalacion = yaTiene?.installationId;
  let cuenta = yaTiene?.cuenta ?? opciones.org ?? '';
  if (!instalacion) {
    if (!opciones.org) {
      return {
        ok: false,
        motivo:
          `el proyecto "${proyecto}" no tiene GitHub conectado. ` +
          'Decime en que organizacion crear los repos con org=<nombre>, ' +
          'o conectala desde el panel.',
      };
    }
    const heredada = await deps.store.instalacionDeCuenta(usuarioId, opciones.org);
    if (!heredada) {
      // Se dice que hay que conectarla UNA vez desde el panel: es la unica
      // parte de esto que no se puede hacer desde Telegram, porque instalar una
      // App es una pantalla de GitHub donde decide la persona.
      return {
        ok: false,
        motivo:
          `no encontre la organizacion "${opciones.org}" entre las que conectaste. ` +
          'Conectala una vez desde el panel, en Configuracion, y despues la reuso sola.',
      };
    }
    await deps.store.guardarInstalacion(proyectoId, heredada.installationId, heredada.cuenta);
    instalacion = heredada.installationId;
    // La cuenta CANONICA, la que devolvio la base: `org=sincro-arg` en
    // minuscula tiene que terminar armando `Sincro-arg/repo`, porque ese string
    // va a una URL de git y GitHub no siempre perdona el caso.
    cuenta = heredada.cuenta;
  }

  // 3. Los repos, uno por uno.
  //
  // En serie y no en paralelo: son pocos, y si el tercero falla por permisos
  // los dos primeros ya existen y el mensaje puede decir exactamente cuales.
  // En paralelo, un 403 llegaria tres veces y el estado seria mas dificil de
  // contar que de arreglar.
  for (const nombre of opciones.repos) {
    const r = await deps.crearRepo(instalacion, nombre, `Creado desde una corrida de ${proyecto}`);
    if (!r.ok) {
      const explicacion = MOTIVO_DE_REPO[r.code] ?? `no se pudo crear "${nombre}" (${r.code})`;
      // Lo que YA se creo se nombra: sin esto, reintentar choca contra
      // "repo_ya_existe" y parece que nada funciona.
      const hechos = creado.repos.length > 0 ? ` Ya habia creado: ${creado.repos.join(', ')}.` : '';
      return { ok: false, motivo: `${explicacion}.${hechos}` };
    }
    await deps.store.vincularRepo(proyectoId, r.nombre, r.github);
    creado.repos.push(r.github);
    // El cable que queda: un repo recien creado NO esta conectado a Vercel ni a
    // Render, y hasta que alguien lo conecte el push del agente no despliega
    // nada. Es el paso manual que este sistema no automatiza, y decirlo en el
    // informe es la diferencia entre "18 tareas hechas" y "esto no levanta".
    creado.pendientes!.push(
      `conectar ${r.github} a Vercel o a Render (la primera vez es a mano; despues cada push hace un preview solo)`,
    );
  }

  // 4. Los de REFERENCIA: no se crean, se vinculan marcados de solo lectura.
  //
  // El `owner` sale de la cuenta de la instalacion y no se pregunta: el gateway
  // clona todo el proyecto con UN token, y un token es de una instalacion, o
  // sea de una cuenta. Un repo de referencia de otra cuenta no se podria clonar
  // — fallaria con un 404 que se lee como "no existe".
  //
  // No se verifica que existan en GitHub. El worktree lo va a decir en el
  // primer turno con un error de clone, y una verificacion aca seria una
  // llamada mas por repo para adelantar un error que igual se ve.
  for (const nombre of opciones.referencia) {
    await deps.store.vincularRepo(proyectoId, nombre, `${cuenta}/${nombre}`, true);
    creado.referencia.push(`${cuenta}/${nombre}`);
  }

  return { ok: true, proyecto, creado };
}

/** Los fallos de crear un repo, en castellano. */
const MOTIVO_DE_REPO: Record<string, string> = {
  repo_ya_existe: 'ya existe un repo con ese nombre en esa organizacion',
  cuenta_no_es_org:
    'esa instalacion es de una cuenta personal, y GitHub no deja crear repos ahi con una App. ' +
    'Necesitas una organizacion',
  // El permiso es el de REPOSITORIO y no el de organizacion, que es el error
  // que costo un intento fallido: con `organization_administration: write`
  // puesto, GitHub igual contesta "Resource not accessible by integration".
  github_403:
    'la App no tiene permiso para crear repos. En GitHub, en los permisos de la App: ' +
    'Repository permissions → Administration: Read and write',
  panel_no_responde: 'no pude hablar con el panel para crear el repo',
  nombre_invalido: 'ese nombre de repo no sirve: solo letras, numeros, punto, guion y guion bajo',
};

/**
 * Todo lo que un turno de la cola necesita saber del proyecto.
 *
 * Salio del bucle porque ahora hay DOS clases de turno —la tarea y el
 * analisis— y las dos necesitan lo mismo. Duplicado eran seis lookups
 * repetidos, con la garantia de que el dia que se agregue un septimo entre en
 * uno solo.
 */
async function contextoDeCola(
  chatId: number,
  proyecto: string,
  usuarioId: string,
  deps: PipelineDeps,
) {
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  const proyectoId = proyectos.find(
    (p) => p.nombre.toLowerCase() === proyecto.toLowerCase(),
  )?.id;
  return {
    proyectoId,
    repos: proyectoId ? await deps.store.reposDeProyecto(proyectoId) : undefined,
    githubToken: await tokenDelProyecto(proyectoId, deps),
    documentos: proyectoId
      ? await deps.store.documentosDeProyecto(proyectoId).catch(() => undefined)
      : undefined,
    modelo: await deps.store.modeloDeChat(chatId).catch(() => undefined),
  };
}

/**
 * Cierra la corrida y manda el informe.
 *
 * El cierre va ANTES del aviso, y ese orden importa: si Telegram falla —o el
 * proceso se cae mandando el mensaje— una corrida cerrada sin informe se
 * arregla mirando la tabla, pero una corrida abierta que ya informo vuelve a
 * arrancar un analisis la proxima vez que alguien encole algo.
 */
async function cerrarConInforme(
  corrida: Corrida,
  motivo: MotivoDeCierre,
  deps: PipelineDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<void> {
  await deps.store.cerrarCorrida(corrida.id, motivo);

  const tareas = await deps.store.tareasDeCorrida(corrida.id);
  const resumen: ResumenDeTareas = {
    hechas: tareas.filter((t) => t.estado === 'lista').length,
    fallidas: tareas.filter((t) => t.estado === 'fallida').length,
    pendientes: tareas.filter((t) => t.estado === 'pendiente').length,
    // Lo que fallo y lo que quedo sin empezar, en la MISMA lista: a la mañana
    // las dos cosas son "esto no esta", y separarlas en dos listas obliga a
    // leer las dos para saber que falta.
    sinResolver: tareas
      .filter((t) => t.estado === 'fallida' || t.estado === 'pendiente')
      .map((t) => ({ texto: t.texto, ...(t.ronda !== undefined ? { ronda: t.ronda } : {}) })),
  };

  // El PREFIJO de rama y no una rama concreta: el nombre exacto lo elige el
  // agente al pushear y el bridge no lo ve. Decir el prefijo es cierto y
  // alcanza para encontrarla; inventar un nombre completo seria mandar a
  // alguien a una rama que no existe.
  const agente = (await deps.store.getActiveAgent(corrida.chatId)) ?? deps.defaultAgent;
  // Se relee la corrida: los pendientes se anotaron DURANTE la noche, y la que
  // recibio esta funcion es de cuando el ciclo la leyo por ultima vez.
  const ahora = await deps.store.corridaAbierta(corrida.chatId);
  await avisar(
    textoDeInforme(
      corrida,
      motivo,
      resumen,
      `claude/${agente}/*`,
      ahora?.pendientes ?? corrida.pendientes,
    ),
  );
}

/**
 * La ronda de analisis: un agente limpio compara el pliego contra el repo.
 *
 * Devuelve si el ciclo SIGUE. Cuando devuelve false la corrida ya quedo
 * cerrada y el informe mandado, asi que quien llama solo tiene que volver.
 *
 * ## Sesion limpia, a proposito
 *
 * Si heredara la conversacion del constructor heredaria tambien sus puntos
 * ciegos y sus justificaciones: un agente que paso la noche diciendo "listo,
 * hecho" lee su propio trabajo con los mismos anteojos.
 *
 * ## Por que no se parsea la respuesta
 *
 * El analista encola llamando a `reportar_huecos`, que entra por
 * `/interno/corrida/huecos` y escribe directo en la cola. Este codigo no lee su
 * prosa: mira si aparecieron tareas. Parsear texto aca seria fragil de la peor
 * manera — un "parece que falta el modulo de stock" se traduciria en cero
 * tareas encoladas y una corrida que cierra diciendo que esta completa.
 */
async function rondaDeAnalisis(
  corrida: Corrida,
  usuarioId: string,
  deps: PipelineDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<boolean> {
  const chatId = corrida.chatId;
  const agente = (await deps.store.getActiveAgent(chatId)) ?? deps.defaultAgent;
  const ctx = await contextoDeCola(chatId, corrida.proyecto, usuarioId, deps);

  await avisar(`🔎 No queda nada pendiente. Reviso contra el pliego (ronda ${corrida.ronda}).`);

  try {
    await ejecutarTurnoConRelevo(deps, {
      proyectoId: ctx.proyectoId,
      proyecto: corrida.proyecto,
      agente: agente as AgentId,
      usuarioId,
      prompt: promptDeAnalisis(corrida.md, corrida.ronda),
      // El analista no escribe —el prompt se lo prohibe— pero el modo va igual:
      // con `preguntar`, un intento de editar dejaria el turno colgado quince
      // minutos esperando un OK que nadie va a dar a las tres de la mañana.
      modo: 'desatendido',
      modelo: ctx.modelo,
      repos: ctx.repos,
      githubToken: ctx.githubToken,
      documentos: ctx.documentos,
      origen: 'telegram',
      chatId,
    });
  } catch (err) {
    const codigo = err instanceof Error ? err.message : 'internal';
    // Sin cuentas: se espera si se sabe cuando vuelven, igual que en la cola.
    // El analisis no se reencola porque no es una tarea — el `return true`
    // vuelve al bucle, la cola sigue vacia, y se corre de nuevo.
    if (codigo === 'usage_limit') {
      if (await esperarQueVuelvan(corrida, deps, avisar)) return true;
      await cerrarConInforme(corrida, 'cuentas_agotadas', deps, avisar);
      return false;
    }
    const fallos = await deps.store.contarFallo(corrida.id, true);
    if (techoAlcanzado({ ...corrida, fallosSeguidos: fallos }, new Date()) !== null) {
      await cerrarConInforme(corrida, 'demasiados_fallos', deps, avisar);
      return false;
    }
    // Se vuelve al bucle SIN avanzar la ronda: el analisis se reintenta, y el
    // techo de fallos es lo que acota el reintento a tres.
    return true;
  }

  // ¿Llamo a la herramienta? Se relee la corrida porque el endpoint de
  // `reportar_huecos` la escribio despues de que este turno empezara.
  const despues = await deps.store.corridaAbierta(chatId);
  // La cancelaron mientras corria el analisis.
  if (!despues) return false;

  if (despues.huecosDeRonda !== corrida.ronda) {
    // Reviso y contesto en prosa sin llamar la herramienta. Es un turno fallido
    // y no una corrida completa: cerrar aca diciendo "completo" es exactamente
    // la falla silenciosa que este ciclo no puede tener.
    const fallos = await deps.store.contarFallo(corrida.id, true);
    await avisar('El analista no reporto por la herramienta. Reintento la revision.');
    if (techoAlcanzado({ ...despues, fallosSeguidos: fallos }, new Date()) !== null) {
      await cerrarConInforme(despues, 'demasiados_fallos', deps, avisar);
      return false;
    }
    return true;
  }

  await deps.store.contarFallo(corrida.id, false);

  // Llamo, y no aparecio nada: la corrida esta completa. Es el UNICO camino a
  // ese motivo, y por eso la marca de la herramienta es lo que lo habilita.
  if (!(await deps.store.proximaTarea(chatId))) {
    await cerrarConInforme(despues, 'completo', deps, avisar);
    return false;
  }

  const ronda = await deps.store.avanzarRonda(corrida.id);
  await avisar(`Encontre trabajo que falta. Arranco la ronda ${ronda}.`);
  return true;
}

/**
 * El turno de PLANIFICACION: arma la cola inicial de una corrida.
 *
 * Corre una sola vez, al abrir. Devuelve las tareas que quedaron encoladas,
 * para poder mostrarlas antes de arrancar.
 *
 * Usa la MISMA herramienta que el analista —`reportar_huecos`— asi que las
 * tareas entran por el endpoint de siempre y este codigo no parsea nada: mira
 * la cola despues. Es la misma decision que en el analisis, y por lo mismo — un
 * modelo que escribe la lista en prosa se traduce en cero tareas, y eso se ve.
 *
 * La corrida ya esta ABIERTA cuando esto corre, y hace falta: `reportar_huecos`
 * resuelve la corrida del jobId, asi que sin una abierta el modelo llamaria la
 * herramienta y le contestarian que no hay donde anotar.
 */
export async function planificarCorrida(
  corrida: Corrida,
  usuarioId: string,
  deps: PipelineDeps,
  /**
   * Lo que se contesto, si esto es el SEGUNDO intento.
   *
   * Ausente en el primero. Cuando llega, el prompt lo incluye y le dice al
   * modelo que no vuelva a preguntar.
   */
  respuestas?: string,
): Promise<
  | { ok: true; tareas: Tarea[] }
  | { ok: false; motivo: string }
  | { ok: false; preguntas: string[] }
> {
  const chatId = corrida.chatId;
  const agente = (await deps.store.getActiveAgent(chatId)) ?? deps.defaultAgent;
  const ctx = await contextoDeCola(chatId, corrida.proyecto, usuarioId, deps);

  // Las referencias que hay montadas, para nombrarlas en el prompt: sin esto el
  // modelo no sabe que existen y no las va a mirar.
  const referencias = (ctx.repos ?? [])
    .filter((r) => (r as { solo_lectura?: boolean }).solo_lectura)
    .map((r) => r.nombre);

  try {
    await ejecutarTurnoConRelevo(deps, {
      proyectoId: ctx.proyectoId,
      proyecto: corrida.proyecto,
      agente: agente as AgentId,
      usuarioId,
      prompt: promptDePlan(corrida.md, referencias, respuestas),
      // El planificador no escribe: solo lee y llama la herramienta. El modo va
      // igual porque con `preguntar` un intento de editar colgaria el turno
      // quince minutos esperando un OK.
      modo: 'desatendido',
      modelo: ctx.modelo,
      repos: ctx.repos,
      githubToken: ctx.githubToken,
      documentos: ctx.documentos,
      origen: 'telegram',
      chatId,
    });
  } catch (err) {
    const codigo = err instanceof Error ? err.message : 'internal';
    return {
      ok: false,
      motivo: codigo === 'usage_limit'
        ? 'se agotaron los tokens de todas las cuentas antes de poder planificar'
        : ERROR_TEXT[codigo] ?? codigo,
    };
  }

  // ¿Pregunto en vez de planificar? Se relee la corrida porque el endpoint de
  // `preguntar_antes_de_planificar` la escribio DESPUES de que este turno
  // empezara — igual que con los huecos.
  const despues = await deps.store.corridaAbierta(corrida.chatId);
  if (!despues) return { ok: false, motivo: 'la corrida se cerro mientras planificaba' };
  // `!respuestas` en la condicion: en el segundo intento las preguntas viejas
  // siguen en la fila, y sin esto se leerian como nuevas y el ciclo no
  // terminaria.
  if (!respuestas && despues.preguntas?.length) {
    return { ok: false, preguntas: despues.preguntas };
  }

  // Si nadie contesto las preguntas, el informe tiene que decirlo: el plan se
  // armo sobre supuestos del modelo, y a la mañana eso es lo primero que hay que
  // revisar. Sin esta linea, un plan hecho a ciegas se ve igual que uno hecho
  // con respuestas.
  if (respuestas === SIN_RESPUESTA && despues.preguntas?.length) {
    await deps.store
      .anotarPendiente(
        corrida.id,
        `revisar el plan: pregunte ${despues.preguntas.length} cosa(s) y nadie contesto, ` +
          'asi que elegi por mi cuenta',
      )
      .catch(() => undefined);
  }

  const tareas = await deps.store.tareasDeCorrida(corrida.id);
  if (tareas.length === 0) {
    // Llamo la herramienta con la lista vacia, o no la llamo. En los dos casos
    // no hay con que arrancar, y se dice asi en vez de abrir una corrida que va
    // a hacer un analisis sobre un repo vacio.
    return {
      ok: false,
      motivo: 'no pude sacar ninguna tarea de ese pliego. Proba con uno mas concreto.',
    };
  }
  return { ok: true, tareas };
}

/**
 * Espera a que vuelva alguna cuenta, o dice que no vale la pena.
 *
 * Devuelve `true` si esperó y el ciclo puede seguir; `false` si hay que cerrar.
 *
 * ## Por que esperar y no cerrar
 *
 * Los limites de Anthropic se reponen cada ~5 horas, y el cartel TRAE la hora:
 * el sistema ya la lee para decir "la cuenta vuelve 5:30am". Con las cuentas
 * agotadas a las 2am, la primera de vuelta a las 5 y un techo a las 7, cerrar
 * tira dos horas de trabajo posible.
 *
 * El spec decia "reintentar contra cuentas agotadas es esperar sin avisar", y
 * eso sigue siendo cierto para un reintento INMEDIATO. Esto es distinto: se
 * espera hasta un momento conocido, y se avisa.
 *
 * ## Lo que se rompe si el bridge se reinicia
 *
 * La espera vive en memoria. Un deploy a mitad de la noche la mata: la corrida
 * queda abierta con sus tareas pendientes, y nadie la retoma hasta que alguien
 * escriba al chat. Lo resuelve `retomarCorridas` al arrancar.
 */
async function esperarQueVuelvan(
  corrida: Corrida,
  deps: PipelineDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<boolean> {
  const ahora = new Date();
  const limite = limiteDeHora(corrida.creadoEn, corrida.techoHora);

  // Los slots agotados los anota `ejecutarTurno` con la hora que traia el
  // cartel, ANTES de relevar. Asi que para cuando llegamos aca, la tabla ya
  // tiene el reset de cada cuenta que se quedo sin tokens.
  const agotados = await deps.store.slotsAgotados().catch(() => new Map());
  const cuando = cuandoReintentar(agotados, limite, ahora);
  if (!cuando) return false;

  const minutos = Math.max(1, Math.round((cuando.getTime() - ahora.getTime()) / 60_000));
  const cuanto = minutos > 60 ? `${Math.floor(minutos / 60)}h ${minutos % 60}m` : `${minutos}m`;
  await avisar(
    `⏸ Se agotaron los tokens de todas las cuentas. La primera vuelve a las ` +
      `${horaArgentinaDe(cuando)} — espero ${cuanto} y sigo.`,
  );

  // El `+ 60_000` es un minuto de gracia sobre la hora del cartel: despertarse
  // exactamente en el minuto del reset y encontrar la cuenta todavia agotada
  // gastaria un turno para volver a esperar.
  await new Promise((r) => setTimeout(r, cuando.getTime() - Date.now() + 60_000));

  // Las marcas se limpian para que `elegirRelevo` vuelva a considerar esos
  // slots: sin esto, el proximo turno los saltea por la marca vieja y el ciclo
  // vuelve a "no hay cuentas" sin haber probado ninguna.
  for (const slot of agotados.keys()) {
    await deps.store.limpiarAgotado(slot as AgentId).catch(() => undefined);
  }
  await avisar('▶ Volvieron los tokens. Sigo con la cola.');
  return true;
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
 * ## Que cambia cuando hay una corrida abierta
 *
 * Dos cosas, y las dos SOLO adentro de la corrida:
 *
 * 1. **La cola vacia no termina el bucle**: corre un turno de analisis que
 *    compara el pliego contra el repo y rellena la cola. Ver `rondaDeAnalisis`.
 * 2. **Un fallo no detiene la cola**: se marca, se sigue con la siguiente, y el
 *    informe la lista. Afuera de una corrida se detiene igual que siempre — ahi
 *    hay alguien mirando, y parar es lo correcto.
 *
 * Sin corrida abierta esta funcion se comporta EXACTAMENTE como antes. Es la
 * condicion que hace que las corridas no puedan romper la cola que ya andaba.
 *
 * ## Por que no hay `await` afuera
 *
 * Quien la dispara no la espera: una corrida puede tardar ocho horas, y el
 * handler de Telegram tiene que contestar ya. El progreso llega por `avisar`.
 */
export async function correrCola(
  chatId: number,
  deps: PipelineDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<void> {
  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return;

  for (;;) {
    // Se relee en CADA vuelta y no una sola vez al entrar: la corrida se puede
    // cerrar desde afuera con /cancelar mientras el bucle corre, y un bucle que
    // se la guardo al empezar seguiria rellenando la cola despues.
    const corrida = await deps.store.corridaAbierta(chatId);

    // Los techos se miran ANTES de tomar la proxima, no solo cuando la cola se
    // vacia. Es lo que hace que el de fallos y el de hora corten en MEDIO de
    // una ronda, que es justo para lo que existen.
    if (corrida) {
      const motivo = techoAlcanzado(corrida, new Date());
      if (motivo) {
        await cerrarConInforme(corrida, motivo, deps, avisar);
        return;
      }
    }

    const tarea = await deps.store.tomarProxima(chatId);
    if (!tarea) {
      // Sin corrida, aca se terminaba la noche. Con corrida, empieza el ciclo.
      if (!corrida) return;
      if (!(await rondaDeAnalisis(corrida, usuarioId, deps, avisar))) return;
      continue;
    }

    const ctx = await contextoDeCola(chatId, tarea.proyecto, usuarioId, deps);
    // Adentro de una corrida el modo lo fija el CICLO y no se lee de la base: el
    // punto de la corrida es que nadie tenga que aprobar nada a las tres de la
    // mañana, y `preguntar` ahi es una noche perdida en la primera edicion.
    //
    // Muere con la corrida porque nunca se guardo. No existe
    // `/permisos desatendido`, y esa ausencia es deliberada: un modo que se
    // olvida prendido es la forma en que esto se vuelve un accidente en tres
    // semanas.
    const modo = corrida
      ? 'desatendido'
      : await deps.store.modoDeChat(chatId).catch(() => undefined);

    try {
      const r = await ejecutarTurnoConRelevo(deps, {
        proyectoId: ctx.proyectoId,
        proyecto: tarea.proyecto,
        agente: tarea.agente as AgentId,
        usuarioId,
        prompt: tarea.texto,
        modo,
        modelo: ctx.modelo,
        repos: ctx.repos,
        githubToken: ctx.githubToken,
        documentos: ctx.documentos,
        origen: 'telegram',
        chatId,
      });
      await deps.store.cerrarTarea(tarea.id, 'lista', r.texto);
      // Una que sale bien vuelve el contador a cero: lo que corta la corrida
      // son tres fallos SEGUIDOS, no tres en toda la noche.
      if (corrida) await deps.store.contarFallo(corrida.id, false);
      // El texto de la tarea se escapa; la respuesta del agente NO, porque
      // `conCodigoParaTelegram` ya la escapo entera antes de meterle sus
      // `<pre>`. Escaparla de nuevo dejaria los `&amp;lt;` a la vista.
      await avisar(`✅ ${escaparHtml(tarea.texto)}\n\n${conCodigoParaTelegram(r.texto)}`);
    } catch (err) {
      const codigo = err instanceof Error ? err.message : 'internal';
      await deps.store.cerrarTarea(tarea.id, 'fallida', codigo);

      if (corrida) {
        // Sin cuentas no se sigue, y NO cuenta como fallo: reintentar contra
        // cuentas agotadas es esperar sin avisar.
        if (codigo === 'usage_limit') {
          // Se ESPERA en vez de cerrar, si se sabe cuando vuelve alguna. La
          // tarea queda pendiente —se cerro como fallida arriba, pero la cola
          // sigue— y el ciclo la retoma cuando los tokens vuelven.
          //
          // Antes esto cerraba de una, y con seis cuentas eso significaba tirar
          // las horas que quedaban hasta el techo.
          if (await esperarQueVuelvan(corrida, deps, avisar)) {
            // La tarea que fallo se reencola: fallo por falta de tokens, no
            // porque estuviera mal. Sin esto se perderia justo la que se estaba
            // haciendo cuando se agotaron las cuentas.
            await deps.store
              .encolar(chatId, {
                agente: tarea.agente,
                proyecto: tarea.proyecto,
                textos: [tarea.texto],
                ...(tarea.corridaId ? { corridaId: tarea.corridaId } : {}),
                ...(tarea.ronda !== undefined ? { ronda: tarea.ronda } : {}),
              })
              .catch(() => undefined);
            continue;
          }
          await cerrarConInforme(corrida, 'cuentas_agotadas', deps, avisar);
          return;
        }
        await deps.store.contarFallo(corrida.id, true);
        // Y se SIGUE con la siguiente. El techo de fallos seguidos —que se mira
        // arriba, en la proxima vuelta— es lo que evita que esto queme la noche
        // entera contra el mismo error.
        await avisar(
          // El codigo del error tambien se escapa: cuando no hay traduccion se
          // manda crudo, y un `fetch failed <url>` cortaria el mensaje entero.
          `⛔ Fallo: ${escaparHtml(tarea.texto)}\n\n` +
            `${escaparHtml(ERROR_TEXT[codigo] ?? codigo)}\n\nSigo con la que viene.`,
        );
        continue;
      }

      // Afuera de una corrida, el comportamiento de siempre: se para.
      //
      // Se cuenta lo que queda ANTES de avisar: el mensaje dice cuanto se
      // detuvo, que es lo que decide si se retoma o se cancela.
      const quedan = (await deps.store.tareasDeChat(chatId)).filter(
        (t) => t.estado === 'pendiente',
      ).length;
      await avisar(
        `⛔ Fallo: ${escaparHtml(tarea.texto)}\n\n${escaparHtml(ERROR_TEXT[codigo] ?? codigo)}\n\n` +
          (quedan > 0
            ? `Pare la cola con ${quedan} tarea(s) sin hacer. Mandame /cola para verlas o /cancelar para descartarlas.`
            : 'Era la ultima de la cola.'),
      );
      return;
    }
  }
}
