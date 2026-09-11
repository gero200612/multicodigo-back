import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AgentId, ApprovalDecision } from '@multicodigo/shared';
import type { Encargo, Tarea } from './cola.js';
import { EJES, SE_PUEDE_REANUDAR } from './corrida.js';
import type { Corrida, Eje, MotivoDeCierre, Veredicto } from './corrida.js';

/**
 * La columna `veredictos` de una fila, como lista.
 *
 * En la base es un objeto con el eje de clave —pisar es un `||`— y en el codigo
 * es una lista, que es como la lee el informe. La traduccion vive aca y no en
 * los dos lugares que la usarian.
 *
 * Se recorre `EJES` y no `Object.keys` a proposito: asi una clave que no es un
 * eje —una columna vieja, algo escrito a mano— no llega al informe, y el orden
 * de salida es siempre el mismo sin depender de como Postgres ordena el jsonb.
 */
function veredictosDeFila(raw: unknown): Veredicto[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const obj = raw as Record<string, unknown>;
  const salida: Veredicto[] = [];
  for (const eje of EJES) {
    const v = obj[eje];
    if (typeof v !== 'object' || v === null) continue;
    const { cumple, resumen } = v as { cumple?: unknown; resumen?: unknown };
    if (typeof cumple !== 'boolean' || typeof resumen !== 'string') continue;
    salida.push({ eje, cumple, resumen });
  }
  return salida;
}

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
  /** 0 cuando el turno no vino de Telegram: el panel no tiene chat. */
  chatId: number;
  agent: AgentId;
  /** El NOMBRE, que es lo que viaja al gateway (va en la ruta del worktree). */
  project: string;
  /**
   * El id del proyecto. Opcional: un proyecto que todavia solo vive en
   * config/projects.json no tiene fila, y el turno tiene que correr igual.
   */
  proyectoId?: string;
  /** Quien lo pidio. Ausente en un chat de Telegram sin vincular. */
  usuarioId?: string;
  origen?: 'telegram' | 'panel';
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

/**
 * Los modos de permiso, espejados de `MODOS` en el agente
 * (`src/agent/src/policy.ts`) y del CHECK de la migracion 018.
 *
 * Los tres tienen que moverse juntos: un modo que la base acepta y el agente
 * no entiende cae en su default en silencio, y nadie sabria por que el bot
 * sigue preguntando.
 */
/**
 * Un repo vinculado a un proyecto.
 *
 * `solo_lectura` viaja hasta el gateway, que es quien lo hace cumplir: un repo
 * de REFERENCIA se monta en el worktree para que el agente lo lea, y no se
 * commitea ni se pushea. Ver la migracion 024 y `reposDelTurno.ts` del gateway.
 *
 * En snake_case y no camelCase: estas filas viajan tal cual en el cuerpo del
 * pedido al gateway, que las valida con el schema de `@multicodigo/shared`.
 */
/**
 * Cuanto vive un `/corrida` a medias: 15 minutos.
 *
 * Es el tope de cuanto puede quedar un chat sin poder hablarle al agente. No es
 * el tiempo que alguien tarda en contestar dos preguntas —con eso alcanzaba un
 * minuto— sino el precio de que algo salga mal: mientras el borrador vive, cada
 * mensaje se lee como la respuesta al paso.
 *
 * Paso en produccion: un chat quedo pidiendo el nombre del proyecto y contestaba
 * "ese nombre no sirve" a todo, incluido `/cancelar`, que tampoco lo borraba.
 */
export const MINUTOS_DE_BORRADOR = 15;

/** Un `/corrida` a medias: en que paso quedo la conversacion. */
export interface Borrador {
  chatId: number;
  paso: 'nombre' | 'org' | 'pliego';
  proyecto?: string;
  /**
   * La organizacion de GitHub, si ya la dijeron.
   *
   * Se recuerda porque con mas de una cuenta conectada el sistema la pide, y sin
   * guardarla el paso a paso volvia a no saberla — un circulo del que no se
   * salia. Ver la migracion 027.
   */
  org?: string;
}

export interface RepoDelProyecto {
  nombre: string;
  github_repo: string;
  solo_lectura?: boolean;
  /**
   * Si lo creo el bot al abrir una corrida.
   *
   * Es lo unico que autoriza el merge automatico a main, y por eso NUNCA se
   * omite como `solo_lectura`: una decision de seguridad apoyada en un campo
   * ausente es una decision apoyada en un bug. El default de la columna es
   * `false`, asi que un repo que conecto una persona nunca lo recibe.
   */
  creado_por_el_bot: boolean;
  /**
   * El servicio de Render ya creado, o null. Explicito por el mismo motivo
   * que `creado_por_el_bot`: da idempotencia (dos corridas sobre el mismo
   * proyecto no pueden dejar dos servicios facturando) y esa garantia no
   * puede depender de si el campo vino o no en la respuesta.
   */
  render_service_id: string | null;
}

export const MODOS_PERMISO = ['preguntar', 'ediciones', 'todo'] as const;
export type ModoPermiso = (typeof MODOS_PERMISO)[number];

/**
 * El modo de una corrida desatendida.
 *
 * Fuera de `MODOS_PERMISO` a proposito, y eso no es un olvido: esa lista es la
 * de los modos ELEGIBLES —los que `/permisos` ofrece y el CHECK de
 * `telegram_modo` acepta— y `desatendido` no es elegible. Lo fija el ciclo de
 * la corrida en cada turno y muere con ella.
 *
 * Si estuviera en `MODOS_PERMISO` existiria `/permisos desatendido`, o sea un
 * modo con commit y push libres que queda prendido despues de que la corrida
 * termino. Es la forma en que esto se vuelve un accidente en tres semanas.
 *
 * Espeja `MODOS` en `multicodigo-vm/src/agent/src/policy.ts`, que si lo tiene:
 * el agente tiene que ENTENDERLO cuando le llega, aunque nadie pueda elegirlo.
 */
export const MODO_DESATENDIDO = 'desatendido';
export type ModoDeTurno = ModoPermiso | typeof MODO_DESATENDIDO;

/**
 * Las claves de modelo, espejadas de `MODELOS` en el agente
 * (`src/agent/src/modelos.ts`) y del CHECK de la migracion 019.
 *
 * Claves y no ids: el id del modelo vive del lado del agente, que es quien
 * habla con el SDK. Guardar un id aca dejaria filas apuntando a modelos
 * retirados que nadie sabria traducir.
 */
/**
 * Un documento del proyecto, como viaja al gateway.
 *
 * Rutas y no URLs: el gateway monta el mismo directorio y copia el archivo al
 * worktree. `ruta_texto` es la conversion a Markdown —lo que el agente
 * realmente lee— y falta cuando el conversor no pudo con el original.
 */
export interface DocumentoDeProyecto {
  nombre: string;
  ruta: string;
  ruta_texto?: string | null;
  /**
   * Si este documento es EL instructivo del proyecto.
   *
   * Un indice unico parcial en la base impide que haya dos por proyecto. Ver
   * `multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md`.
   */
  es_instruccion?: boolean;
}

/** Todo lo que se guarda de un documento que llego por Telegram. */
export interface FilaDeDocumento {
  proyectoId: string;
  nombre: string;
  nombreOriginal: string;
  ruta: string;
  rutaTexto: string | null;
  tipo: string;
  bytes: number;
  /** Por que no se pudo convertir a texto, si fallo. */
  error?: string;
  /**
   * Quien lo mando: el usuario del panel atado a este chat.
   *
   * La columna es NOT NULL y referencia auth.users. Sin vinculo no hay
   * documento, y sin vinculo tampoco hay turno.
   */
  subidoPor: string;
  /**
   * De donde salio el documento.
   *
   * Sin este dato, un documento que ESCRIBIO el agente y uno que subio la
   * persona se ven identicos en la lista, y no hay forma de saber cual es cual.
   * Opcional: las filas que ya estan quedan en el default de la columna
   * (`panel`), que es de donde venia todo cuando no existia esta columna.
   */
  origen?: 'panel' | 'telegram' | 'drive' | 'agente';
}

/** Lo que consumio un turno, o la suma de varios. */
export interface Consumo {
  /** Entrada + salida, que es como los cuenta la cuota. */
  tokens: number;
  costoUsd: number;
}

export const CLAVES_DE_MODELO = ['opus', 'sonnet', 'haiku'] as const;
export type ClaveDeModelo = (typeof CLAVES_DE_MODELO)[number];

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

/**
 * Un codigo para meter en una URL, no para tipear.
 *
 * Es distinto de `codigoLegible` a proposito: aquel se lee de una pantalla y
 * cambia seguridad por legibilidad, y esto viaja en un link que se toca. Sin la
 * restriccion de leerlo a mano no hay razon para quedarse en 41 bits, y este
 * autoriza algo mas grande —un archivo de Drive— asi que van 192.
 */
function codigoDeUrl(): string {
  return randomBytes(24).toString('base64url');
}

/** Lo que se sabe de un slot sin tokens. */
export interface Agotamiento {
  /** La hora cruda del cartel ("1:30am (UTC)"), si el aviso la traia. */
  resets?: string;
  vistoEn: Date;
}

/**
 * Cuanto vale una marca de agotamiento.
 *
 * Cinco horas es la ventana de uso de Claude, asi que pasada esa la marca ya
 * no dice nada util. Caduca por tiempo y no por el `resets` del cartel porque
 * ese texto no trae el dia (ver la migracion 015).
 *
 * Equivocarse por exceso —seguir mostrando el aviso cuando la cuenta ya
 * volvio— es el lado barato: la persona igual puede elegir el slot y el turno
 * corre. Al reves, ofrecer como listo un slot vacio es el bug que esto arregla.
 */
export const HORAS_DE_AGOTAMIENTO = 5;

export interface Store {
  /**
   * El installation_id de la GitHub App del proyecto, o undefined.
   *
   * Lo lee el bridge para los turnos de Telegram, que no pasan por el panel. El
   * bridge NO firma el token —eso necesita la clave privada de la App, que vive
   * solo en el panel— sino que le pide al panel que lo firme con este id.
   */
  instalacionDeProyecto(proyectoId: string): Promise<number | undefined>;

  /**
   * Los repos vinculados al proyecto.
   *
   * Para los turnos de Telegram, que no pasan por el panel. Sin esto el gateway
   * cae a su catalogo local (`config/projects.json`), que solo conoce `demo` y
   * `sincroresto`: cualquier proyecto creado desde el panel se quedaba sin
   * repos por el camino del chat.
   */
  reposDeProyecto(proyectoId: string): Promise<RepoDelProyecto[]>;

  /**
   * Los ultimos turnos de un agente en un proyecto, del mas viejo al mas nuevo.
   *
   * Para el relevo: cuando un slot se queda sin tokens, el que sigue arranca una
   * sesion NUEVA —el transcript vive en el HOME del slot viejo y no se puede
   * resumir desde otro— asi que el contexto hay que reinyectarlo como texto. Esto
   * es de donde sale.
   *
   * Solo los que terminaron bien: un turno fallido no aporta contexto y ademas
   * su `respuesta` es un codigo de error.
   */
  turnosRecientes(
    proyectoId: string,
    agente: string,
    limite: number,
  ): Promise<Array<{ prompt: string; respuesta: string }>>;

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
  /**
   * La sesion de Claude para un agente en un proyecto.
   *
   * Por proyecto y no por chat: es lo que hace que el panel y Telegram sigan la
   * misma conversacion. El agente ve un solo hilo, se le escriba desde donde se
   * le escriba.
   */
  getSession(proyectoId: string, agent: AgentId): Promise<string | undefined>;
  setSession(proyectoId: string, agent: AgentId, sessionId: string): Promise<void>;
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
  /**
   * Cierra el job. `respuesta` es lo que contesto el agente.
   *
   * Sin guardarla, la tabla tiene lo que pediste y no lo que te contestaron:
   * no hay historial que mostrar ni en el panel ni en el chat compartido.
   */
  finishJob(
    jobId: string,
    status: JobStatus,
    error?: string,
    respuesta?: string,
    consumo?: Consumo,
  ): Promise<void>;
  /**
   * Lo gastado por cada agente en las ultimas 5 horas, indexado por slot.
   *
   * Cinco horas es la ventana del limite de Anthropic (ver
   * HORAS_DE_AGOTAMIENTO): sumar sobre ella es lo que hace que el numero se
   * pueda comparar contra el momento en que el slot se agoto la vez pasada.
   *
   * NO es "cuanto queda": Anthropic no publica la cuota, asi que no hay total
   * contra el cual dividir y un porcentaje seria inventado.
   */
  consumoPorAgente(): Promise<Map<string, Consumo>>;
  /**
   * Los documentos del proyecto, con sus rutas en el disco del servidor.
   *
   * Sale de ACA y no de la API REST de Supabase, que es como se leia antes: eso
   * pedia la `service_role` y dejaba los documentos apagados enteros cuando esa
   * clave faltaba —ni los del panel ni los del bot llegaban al agente—. El
   * bridge ya se conecta a la misma base como `postgres`, sin RLS, asi que la
   * clave era un rodeo por HTTP para leer una tabla que ya tiene a mano.
   */
  documentosDeProyecto(proyectoId: string): Promise<DocumentoDeProyecto[]>;
  /**
   * Registra un documento que llego por Telegram.
   *
   * Por aca y no por la API REST con la `service_role`, que es lo que ataba el
   * guardado a esa clave: sin ella el bot aceptaba el archivo y despues no lo
   * podia registrar. El archivo ya va al disco; esto es la otra mitad.
   *
   * Es un upsert por (proyecto, nombre): mandar de nuevo el mismo archivo lo
   * reemplaza, que es lo que espera quien manda una version corregida.
   */
  guardarDocumento(fila: FilaDeDocumento): Promise<void>;
  /**
   * Mueve un job entre estados transitorios. No reabre uno ya cerrado: un
   * estado que llega tarde —el poller vio una aprobacion justo cuando el turno
   * terminaba— no puede revivir un job en done.
   */
  setJobStatus(jobId: string, status: JobStatus): Promise<void>;
  getJobStatus(jobId: string): Promise<JobStatus | undefined>;
  /**
   * De que proyecto y de quien es un turno.
   *
   * Lo necesita el documento que ESCRIBE el agente. Ese pedido llega por el
   * gateway, que conoce el slot, el NOMBRE del proyecto y el `jobId` — y la
   * fila de `documentos` pide los UUID del proyecto y del usuario. El job es el
   * unico lugar donde los dos ya estan juntos, asi que no hace falta hacerle
   * llevar la identidad del usuario a un agente que no la necesita para nada
   * mas.
   */
  contextoDeJob(
    jobId: string,
  ): Promise<{ proyectoId?: string; usuarioId?: string } | undefined>;
  getJobError(jobId: string): Promise<string | undefined>;
  /** Lo que contesto el agente, si el turno termino. */
  getJobRespuesta(jobId: string): Promise<string | undefined>;
  /** true si es la primera vez que se ve esta aprobacion (o sea: hay que anunciarla). */
  recordApproval(rec: ApprovalRecord): Promise<boolean>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /**
   * Corrige el mensaje al que apunta una aprobacion.
   *
   * Existe porque los dos ids son distintos y llegan en momentos distintos. La
   * aprobacion se registra ANTES de mandar el anuncio —ahi vive la
   * deduplicacion, y sin ella un reinicio a mitad de turno la anuncia dos
   * veces— asi que en ese momento el unico id que hay es el del placeholder de
   * "trabajando". El mensaje con los BOTONES nace despues.
   *
   * Sin esto, decidir editaba el placeholder y el pedido quedaba intacto en el
   * chat: se seguia leyendo "aprobas?" con los botones vivos despues de haber
   * aprobado.
   */
  setApprovalMessage(approvalId: string, messageId: number): Promise<void>;
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
  /**
   * La instalacion de GitHub que este usuario ya conecto para una cuenta.
   *
   * Existe para que un proyecto NUEVO pueda heredarla sin que la persona tenga
   * que volver a pasar por GitHub. La instalacion es de la cuenta —una org, en
   * la practica— y ya esta consentida: lo que se copia es a que proyecto
   * aplica, no un permiso nuevo.
   *
   * Se filtra por los proyectos DEL USUARIO y no por la tabla entera: sin ese
   * filtro, cualquiera podria heredar la instalacion de un desconocido
   * nombrando su org.
   */
  instalacionDeCuenta(
    usuarioId: string,
    cuenta: string,
  ): Promise<{ installationId: number; cuenta: string } | undefined>;
  /**
   * La instalacion de un proyecto CON su cuenta.
   *
   * Distinta de `instalacionDeProyecto`, que devuelve solo el id porque es lo
   * unico que hace falta para firmar un token. Aca hace falta la cuenta: es el
   * `owner` con el que se arma el `owner/nombre` de un repo de referencia.
   */
  instalacionConCuenta(
    proyectoId: string,
  ): Promise<{ installationId: number; cuenta: string } | undefined>;
  /** Ata una instalacion ya existente a otro proyecto del mismo usuario. */
  guardarInstalacion(proyectoId: string, installationId: number, cuenta: string): Promise<void>;
  /**
   * Suma un repo a un proyecto. El `github` es `owner/nombre`.
   *
   * `soloLectura` lo marca como REFERENCIA: se monta para leer y el gateway
   * rechaza commitear y pushear ahi.
   *
   * `creadoPorElBot` es lo unico que despues autoriza el merge automatico a
   * main. Un repo de referencia (`soloLectura`) NUNCA lo lleva: ya existia de
   * una persona, y marcarlo habilitaria un merge automatico sobre un repo que
   * el sistema no creo.
   */
  vincularRepo(
    proyectoId: string,
    nombre: string,
    github: string,
    soloLectura?: boolean,
    creadoPorElBot?: boolean,
  ): Promise<void>;
  /** El servicio de Render ya creado para ese repo. Da idempotencia. */
  guardarRenderServiceId(proyectoId: string, nombre: string, serviceId: string): Promise<void>;
  /** El id del proyecto por nombre, o null si no existe. */
  idDeProyecto(nombre: string): Promise<string | null>;
  /** Los agentes del proyecto, por slot. */
  agentesDeProyecto(proyectoId: string): Promise<AgenteResumen[]>;
  /**
   * Los slots de una PERSONA, cruzando todos sus proyectos.
   *
   * Es la respuesta a "a quien se le puede dar trabajo de esta persona", y
   * `agentesDeProyecto` no alcanza: `slot` es PRIMARY KEY, asi que un slot
   * pertenece a UN proyecto y un proyecto recien creado no tiene ninguno.
   *
   * Sin esto el reparto de una corrida usaba cualquier slot del host que
   * tuviera credencial cargada —los devuelve el gateway listando contenedores—
   * incluido uno con la cuenta de otra persona. Paso en `saludos5`: es plata de
   * un tercero y su sesion de Claude corriendo trabajo que no pidio.
   *
   * Un slot con credencial en el HOME pero SIN fila en `agentes` no es de
   * nadie, y no aparece aca. Eso es deliberado: el registro es lo unico que
   * dice de quien es un slot.
   */
  agentesDeUsuario(usuarioId: string): Promise<AgenteResumen[]>;
  /** Anota que el slot pertenece al proyecto. NO crea el contenedor. */
  registrarAgente(proyectoId: string, slot: AgentId, nombre?: string): Promise<void>;

  /**
   * Anota que un slot se quedo sin tokens.
   *
   * Lo llama el turno cuando el agente contesta `usage_limit`. Sin esto el
   * dato existe por un instante —el tiempo de armar el mensaje de error— y se
   * pierde, que es por lo que el menu seguia ofreciendo un slot agotado.
   */
  marcarAgotado(slot: AgentId, resets?: string): Promise<void>;

  /**
   * Borra la marca. Lo llama un turno que SALIO BIEN en ese slot.
   *
   * Es la señal mas confiable de que la cuenta volvio: mas que cualquier
   * cuenta de horas, porque lo unico que prueba que hay tokens es haberlos
   * usado recien.
   */
  limpiarAgotado(slot: AgentId): Promise<void>;

  /** Los slots agotados que todavia valen, por slot. */
  slotsAgotados(): Promise<Map<string, Agotamiento>>;
  /** El usuario del panel dueño de este chat, o undefined si no esta vinculado. */
  usuarioDeChat(chatId: number): Promise<string | undefined>;
  /**
   * Como llamar a un usuario delante de otra persona.
   *
   * Existe para el aviso de slot ocupado: "c1 lo esta usando Martin" en vez de
   * "c1 lo esta usando otra persona". Sale del email de Supabase —no hay una
   * tabla de perfiles— y se corta antes de la arroba: el dominio no aporta y
   * mostrar el email entero de alguien a un tercero es de mas.
   */
  nombreDeUsuario(usuarioId: string): Promise<string | undefined>;
  /**
   * El mensaje que quedo esperando porque el agente estaba ocupado.
   *
   * `null` lo borra. Se guarda uno solo por chat: si escribiste dos veces
   * mientras el slot estaba tomado, lo que quisiste mandar es lo ultimo.
   */
  setPendiente(chatId: number, prompt: string | null): Promise<void>;
  /** Lo saca y lo borra de una: un pendiente se manda una sola vez. */
  tomarPendiente(chatId: number): Promise<string | undefined>;
  /**
   * Los agentes de MAS con los que trabaja el chat, sin el primario.
   *
   * El primario es `getActiveAgent`: a el le habla el texto suelto. A estos se
   * les habla con `/c2 …`, y estan anotados para poder mostrarlos.
   */
  agentesDeCowork(chatId: number): Promise<AgentId[]>;
  /**
   * Suma el agente a la lista, o lo saca si ya estaba. Devuelve como quedo.
   *
   * Es un toggle y no un par de metodos: sumar y sacar son la misma decision
   * vista dos veces, y quien llama ya recibe el estado nuevo.
   */
  alternarCowork(chatId: number, slot: AgentId): Promise<AgentId[]>;
  /**
   * Cuanto se le pregunta a este chat antes de actuar.
   *
   * `undefined` = nunca lo eligio, y el turno corre con el default del agente,
   * que es el mas estricto. No se devuelve el default aca a proposito: quien
   * muestra el modo tiene que poder distinguir "elegi preguntar" de "no elegi
   * nada", aunque hagan lo mismo.
   */
  modoDeChat(chatId: number): Promise<ModoPermiso | undefined>;
  setModoDeChat(chatId: number, modo: ModoPermiso): Promise<void>;
  /**
   * Con que modelo corre este chat.
   *
   * `undefined` = nunca lo eligio, y el turno usa el default del CLI. No se
   * devuelve un default aca: el dia que el CLI cambie el suyo, un valor
   * nuestro lo estaria pisando sin que nadie lo haya pedido.
   */
  modeloDeChat(chatId: number): Promise<ClaveDeModelo | undefined>;
  setModeloDeChat(chatId: number, modelo: ClaveDeModelo): Promise<void>;
  /** Suma una tanda de tareas al final de la cola del chat. */
  encolar(chatId: number, encargo: Encargo): Promise<number>;
  /** Lo que hay en la cola, en orden. Para mostrarla. */
  tareasDeChat(chatId: number): Promise<Tarea[]>;
  /**
   * La proxima pendiente, sin tocarla. Para saber si hay trabajo.
   *
   * `corridaId` acota a las de ESA corrida. Sin el filtro, una corrida hereda
   * las tareas pendientes de una corrida ANTERIOR del mismo chat — que es lo
   * que paso en produccion: una corrida nueva ejecuto tres tareas de la vieja,
   * fallaron porque nombraban un agente que ya no estaba, y el techo de fallos
   * la cerro sin haber tocado ni una de las suyas.
   */
  proximaTarea(chatId: number, corridaId?: string): Promise<Tarea | undefined>;
  /**
   * Se lleva la proxima pendiente y la marca corriendo, en un solo paso.
   *
   * Atomico a proposito: si dos vueltas del bucle preguntan a la vez —o el
   * bridge arranca dos veces— con un SELECT y despues un UPDATE las dos se
   * llevarian la misma tarea y el agente la haria dos veces.
   */
  tomarProxima(chatId: number, corridaId?: string): Promise<Tarea | undefined>;
  /**
   * Cierra la tarea y, si hubo relevo, corrige de quien es el trabajo.
   *
   * `agenteReal` es el slot que CONTESTO, que despues de un relevo no es el que
   * se encolo. Antes no se guardaba en ningun lado y el informe mandaba a una
   * rama vacia; la feature de publicar heredaba el mismo error y salteaba el
   * repo en silencio. Ver `multicodigo-vm/docs/RETOMAR-relevo-agente.md`.
   *
   * Opcional: sin relevo no hay nada que corregir, y quien no lo pasa deja la
   * fila como estaba. Un `undefined` NUNCA borra el agente — el informe lo usa
   * para nombrar la rama.
   */
  cerrarTarea(
    id: string,
    estado: 'lista' | 'fallida',
    resultado?: string,
    agenteReal?: string,
  ): Promise<void>;
  /**
   * Cancela lo PENDIENTE. Devuelve cuantas saco.
   *
   * `corridaId` acota a las de ESA corrida, igual que en `tomarProxima`. Se usa
   * al cerrar una corrida: sin eso las suyas quedan pendientes para siempre y
   * ensucian la cola del chat.
   */
  cancelarCola(chatId: number, corridaId?: string): Promise<number>;

  // --- Corridas desatendidas ------------------------------------------------
  //
  // Ver `corrida.ts` y el spec
  // `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.

  /**
   * Abre una corrida, o `undefined` si el chat ya tiene una abierta.
   *
   * El "ya tiene una" lo decide la BASE, con el indice unico parcial de la
   * migracion 023, y no un SELECT previo: dos `/corrida` mandados juntos pasan
   * los dos por el chequeo y solo uno puede ganar el INSERT.
   */
  abrirCorrida(datos: {
    chatId: number;
    proyecto: string;
    md: string;
    techoRondas: number;
    techoHora: string;
  }): Promise<Corrida | undefined>;
  /** La corrida abierta del chat, si hay. Es lo que consulta el ciclo. */
  corridaAbierta(chatId: number): Promise<Corrida | undefined>;
  /**
   * Todas las corridas abiertas, de todos los chats.
   *
   * Para retomarlas al arrancar el bridge. La espera por tokens y el bucle de
   * la cola viven en MEMORIA: un deploy a mitad de la noche los mata, y la
   * corrida queda abierta con sus tareas pendientes sin que nadie la retome
   * —`correrCola` solo arranca cuando llega un mensaje—. Sin esto, un deploy a
   * las 3am cuesta la noche entera.
   */
  corridasAbiertas(): Promise<Corrida[]>;
  /**
   * La corrida abierta a la que pertenece un turno, por su job.
   *
   * Existe para el endpoint de `reportar_huecos`: lo que llega del gateway es
   * un jobId, y de ahi hay que llegar al chat y a su corrida. Sin este salto el
   * agente tendria que mandar el id de la corrida, o sea un dato que el modelo
   * podria cambiar.
   */
  corridaDeJob(jobId: string): Promise<Corrida | undefined>;
  /** Cierra la corrida con su motivo. Idempotente: cerrar dos veces no rompe. */
  cerrarCorrida(id: string, motivo: MotivoDeCierre): Promise<void>;
  /** Pasa a la ronda siguiente y devuelve el numero nuevo. */
  avanzarRonda(id: string): Promise<number>;
  /**
   * Suma o resetea el contador de fallos seguidos. Devuelve como quedo.
   *
   * `seguidos` y no "total": veinte tareas que fallan por causas distintas a lo
   * largo de la noche son ruido normal; tres seguidas son un problema que no se
   * va a arreglar solo. Cada tarea que sale bien lo vuelve a cero.
   */
  contarFallo(id: string, fallo: boolean): Promise<number>;
  /** Las tareas de una corrida, en orden. Para el informe. */
  tareasDeCorrida(corridaId: string): Promise<Tarea[]>;

  // --- El borrador: el paso a paso antes de abrir la corrida ----------------

  /**
   * En que paso quedo el `/corrida` de este chat, si hay uno a medias.
   *
   * Un borrador VIEJO se trata como si no existiera, y eso es una garantia y no
   * una optimizacion: mientras hay uno, TODO mensaje del chat se lee como la
   * respuesta al paso. Si algo lo deja colgado —la persona se distrae, el
   * nombre nunca valida, se va a dormir— el chat queda sin poder hablarle al
   * agente. Con el vencimiento, se destraba solo pase lo que pase.
   *
   * Ver `MINUTOS_DE_BORRADOR`.
   */
  borradorDeChat(chatId: number): Promise<Borrador | undefined>;
  /** Guarda el paso. Un borrador nuevo pisa al anterior. */
  guardarBorrador(
    chatId: number,
    paso: Borrador['paso'],
    proyecto?: string,
    org?: string,
  ): Promise<void>;
  /** Lo borra. Se llama al abrir la corrida y al cancelar. */
  borrarBorrador(chatId: number): Promise<void>;
  /**
   * Las organizaciones de GitHub que esta persona ya conecto.
   *
   * Para no tener que escribir `org=` cada vez: si hay una sola, es esa. Sale
   * de las instalaciones de SUS proyectos, asi que nombrar la org de un
   * desconocido no alcanza para nada.
   *
   * Devuelve las cuentas distintas, sin repetir: una instalacion puede estar
   * atada a varios proyectos.
   */
  cuentasConectadas(usuarioId: string): Promise<Array<{ installationId: number; cuenta: string }>>;
  /**
   * En que organizacion nacen los repos de las corridas de esta persona.
   *
   * Se pregunta UNA vez y queda. Antes era una opcion del comando, que es un
   * lugar mas donde equivocarse por un dato que no cambia entre corridas. Ver
   * la migracion 029.
   */
  orgDeCorridas(usuarioId: string): Promise<string | undefined>;
  setOrgDeCorridas(usuarioId: string, cuenta: string): Promise<void>;
  /**
   * Los repos de REFERENCIA que esta persona ya tiene en algun proyecto.
   *
   * Para no tener que escribir `referencia=` cada vez. Salen de las filas con
   * `solo_lectura`, o sea de lo que ya se monto asi alguna vez — no hay una
   * lista aparte que mantener.
   */
  referenciasConocidas(usuarioId: string): Promise<string[]>;
  /**
   * Suma un cable suelto a la corrida: algo que falta configurar A MANO.
   *
   * Idempotente por TEXTO: la misma frase no entra dos veces. Hace falta porque
   * el agente puede pedir lo mismo en dos tareas distintas —"pone las claves de
   * Supabase" es lo primero que se le ocurre a cualquiera que toca la base— y un
   * informe con la misma linea cuatro veces se lee como ruido.
   */
  anotarPendiente(corridaId: string, texto: string): Promise<void>;
  /**
   * Guarda lo que el planificador quiere preguntar, y cuando.
   *
   * La hora se guarda para poder medir el tope despues de un reinicio: si
   * viviera en memoria, un deploy dejaria la corrida esperando para siempre.
   */
  guardarPreguntas(corridaId: string, preguntas: readonly string[]): Promise<void>;
  /** Guarda lo que contesto la persona, en crudo. */
  guardarRespuestas(corridaId: string, respuestas: string): Promise<void>;
  /**
   * Anota que el analista de esta ronda SI llamo a `reportar_huecos`.
   *
   * Lo escribe el endpoint de la herramienta, no el ciclo: es la unica prueba
   * de que la llamada existio. El ciclo despues compara contra la ronda que
   * corrio, y si no coincide trata el analisis como fallido en vez de cerrar la
   * corrida como completa.
   */
  marcarHuecos(corridaId: string, ronda: number): Promise<void>;
  /**
   * Guarda el veredicto de UN analista sobre su eje.
   *
   * Pisa el anterior del mismo eje, y eso es lo que se quiere: los cuatro
   * revisan dos veces —en la ronda 1 y en el cierre— y lo que vale es lo ultimo
   * que dijeron. Guardar los dos obligaria al informe a elegir, que es la misma
   * decision tomada en peor lugar.
   */
  guardarVeredicto(corridaId: string, eje: Eje, cumple: boolean, resumen: string): Promise<void>;
  /**
   * Guarda el contrato front/back de la corrida. Pisa el anterior: el
   * planificador lo fija una vez, y si lo corrige, vale lo ultimo.
   */
  guardarContrato(corridaId: string, contrato: string): Promise<void>;
  /**
   * Reabre la ultima corrida cerrada del chat y devuelve a la cola lo que no
   * se hizo. `undefined` si no hay ninguna que se pueda reanudar.
   *
   * Lo que NO se hizo son las `fallida` y las `cancelada`: las primeras se
   * intentaron y salieron mal, las segundas nunca se intentaron porque el
   * cierre las corto. Las dos siguen siendo trabajo pendiente del mismo pliego.
   *
   * Mueve `creado_en` a ahora, y no es un detalle: `limiteDeHora` calcula el
   * techo de hora a partir de esa fecha. Sin moverla, una corrida que cerro a
   * las 07:00 y se reanuda a las 08:00 tendria su techo en el pasado y se
   * cerraria de nuevo en la primera vuelta del bucle.
   *
   * Y `fallos_seguidos` vuelve a cero: el contador es de una tanda, y reanudar
   * es empezar otra. Sin esto, una corrida que cerro por tres fallas se cerraria
   * con la primera del reintento.
   */
  reanudarCorrida(
    chatId: number,
  ): Promise<{ corrida: Corrida; reencoladas: number } | undefined>;
  /**
   * Desata un chat de una cuenta. Devuelve si habia algo que desatar.
   *
   * `usuarioId` no es opcional y se usa en el WHERE: es lo que impide que
   * alguien con sesion desate el chat de otro mandando su chat_id.
   */
  desvincularChat(chatId: number, usuarioId: string): Promise<boolean>;
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

  // --- Drive en vivo -------------------------------------------------------
  //
  // Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.

  /**
   * La cuenta de Google de un usuario, CON el refresh token.
   *
   * Es el unico lugar del sistema donde ese token sale de la base, y por eso
   * este metodo esta en el store del bridge y no en el panel: el panel es el
   * proceso expuesto a internet, y ademas tiene la columna negada por GRANT.
   */
  googleCuenta(usuarioId: string): Promise<{ email: string; refreshToken: string } | undefined>;
  /**
   * Guarda la cuenta conectada, pisando la anterior si habia.
   *
   * Pisa y no acumula: conectar de nuevo es lo que hace la persona cuando el
   * token viejo dejo de servir, y dejar los dos vivos significaria que el
   * proximo turno puede elegir el muerto.
   */
  guardarGoogleCuenta(usuarioId: string, email: string, refreshToken: string): Promise<void>;
  /** Desconecta la cuenta. Devuelve si habia algo que desconectar. */
  borrarGoogleCuenta(usuarioId: string): Promise<boolean>;
  /**
   * Un codigo de un solo uso para autorizar UN archivo con el Picker.
   *
   * Vence, igual que el de vinculacion y por lo mismo: es una autorizacion
   * sobre la cuenta de Google de alguien y viaja por un chat, donde queda en el
   * historial para siempre.
   */
  crearPedidoDeDrive(usuarioId: string, nombre: string, minutos: number): Promise<string>;
  /**
   * Canjea el pedido y devuelve de quien era y que archivo pedia.
   *
   * Distingue los modos de falla por lo mismo que `canjearCodigo`: "ese link ya
   * lo usaste" y "ese link vencio" se arreglan distinto.
   */
  canjearPedidoDeDrive(
    codigo: string,
    archivoId: string,
  ): Promise<
    | { estado: 'ok'; usuarioId: string; nombre: string }
    | { estado: 'vencido' | 'usado' | 'desconocido' }
  >;
  /**
   * Un archivo que esta persona autorizo recien, buscado por nombre.
   *
   * Existe por el indice eventualmente consistente de Drive: entre que alguien
   * elige un archivo en el Picker y que `files.list` lo encuentra por nombre
   * pasan hasta un par de minutos, y el turno siguiente llega mucho antes.
   * Sin esto, el agente contesta "no lo encuentro" justo despues de que la
   * persona hizo lo que le pidieron — que es el peor momento posible.
   *
   * Mira solo los pedidos RECIENTES: es un puente sobre la ventana de
   * propagacion, no un catalogo. Pasada esa ventana, la busqueda en vivo
   * encuentra el archivo sola y esta fila deja de importar.
   */
  archivoAutorizadoReciente(
    usuarioId: string,
    nombre: string,
    minutos: number,
  ): Promise<{ id: string; nombre: string } | undefined>;
}

export class InMemoryStore implements Store {
  private active = new Map<number, AgentId>();
  private activeProject = new Map<number, string>();
  private sessions = new Map<string, string>();
  private jobs = new Map<
    string,
    {
      status: JobStatus;
      error?: string;
      respuesta?: string;
      resumen?: JobResumen;
      consumo?: Consumo;
    }
  >();

  private key(proyectoId: string, agent: AgentId) {
    return `${proyectoId}:${agent}`;
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
  async getSession(proyectoId: string, agent: AgentId) {
    return this.sessions.get(this.key(proyectoId, agent));
  }
  async setSession(proyectoId: string, agent: AgentId, sessionId: string) {
    this.sessions.set(this.key(proyectoId, agent), sessionId);
  }
  async deleteSessions(agent: AgentId) {
    let borradas = 0;
    for (const clave of [...this.sessions.keys()]) {
      // La clave es proyectoId:agente. Se compara el ultimo campo y no un
      // `includes(agent)`, que daria falsos positivos.
      if (clave.slice(clave.lastIndexOf(':') + 1) !== agent) continue;
      this.sessions.delete(clave);
      borradas += 1;
    }
    return borradas;
  }
  async createJob(job: NewJob) {
    const id = randomUUID();
    this.contextos.set(id, { proyectoId: job.proyectoId, usuarioId: job.usuarioId });
    // De que chat es el turno. En Postgres es la columna `jobs.chat_id`; aca
    // hacia falta un mapa porque `contextos` guarda proyecto y usuario y no el
    // chat. Lo usa `corridaDeJob`, que es como `reportar_huecos` llega desde un
    // jobId hasta la corrida abierta.
    this.chatsDeJob.set(id, job.chatId);
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
  async finishJob(
    jobId: string,
    status: JobStatus,
    error?: string,
    respuesta?: string,
    consumo?: Consumo,
  ) {
    const previo = this.jobs.get(jobId);
    this.jobs.set(jobId, { ...previo, status, error, respuesta, consumo });
  }

  private documentos = new Map<string, DocumentoDeProyecto[]>();
  /** De que proyecto y de quien es cada job. Ver `contextoDeJob`. */
  private contextos = new Map<string, { proyectoId?: string; usuarioId?: string }>();

  /** De que chat es cada job. Ver `corridaDeJob`. */
  private chatsDeJob = new Map<string, number>();

  async contextoDeJob(jobId: string) {
    return this.contextos.get(jobId);
  }

  /** Solo para los tests: agrega un documento a un proyecto. */
  ponerDocumento(proyectoId: string, doc: DocumentoDeProyecto): void {
    this.documentos.set(proyectoId, [...(this.documentos.get(proyectoId) ?? []), doc]);
  }

  async documentosDeProyecto(proyectoId: string): Promise<DocumentoDeProyecto[]> {
    return this.documentos.get(proyectoId) ?? [];
  }

  async guardarDocumento(fila: FilaDeDocumento): Promise<void> {
    const previos = (this.documentos.get(fila.proyectoId) ?? []).filter(
      (d) => d.nombre !== fila.nombre,
    );
    this.documentos.set(fila.proyectoId, [
      ...previos,
      { nombre: fila.nombre, ruta: fila.ruta, ruta_texto: fila.rutaTexto },
    ]);
  }

  async consumoPorAgente(): Promise<Map<string, Consumo>> {
    const total = new Map<string, Consumo>();
    for (const j of this.jobs.values()) {
      const agente = j.resumen?.agent;
      if (!agente || !j.consumo) continue;
      const previo = total.get(agente) ?? { tokens: 0, costoUsd: 0 };
      total.set(agente, {
        tokens: previo.tokens + j.consumo.tokens,
        // Se redondea a seis decimales, los mismos que la columna NUMERIC:
        // sumar floats acumula error y 0.02 + 0.01 da 0.030000000000000002.
        costoUsd: Number((previo.costoUsd + j.consumo.costoUsd).toFixed(6)),
      });
    }
    return total;
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
  async getJobRespuesta(jobId: string) {
    return this.jobs.get(jobId)?.respuesta;
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

  async setApprovalMessage(approvalId: string, messageId: number) {
    const guardada = this.approvals.get(approvalId);
    // Una aprobacion que no esta no es un error: la decision ya se pudo haber
    // tomado y limpiado. Corregir el mensaje de algo que no existe no tiene
    // nada que arreglar.
    if (guardada) guardada.rec = { ...guardada.rec, messageId };
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

  /** El doble no tiene instalaciones: los turnos de sus tests van por SSH. */
  async instalacionDeProyecto(): Promise<number | undefined> {
    return undefined;
  }

  /** Las instalaciones, por proyecto. Ver `instalacionDeCuenta`. */
  private instalaciones = new Map<string, { installationId: number; cuenta: string }>();

  async instalacionDeCuenta(usuarioId: string, cuenta: string) {
    const mios = await this.proyectosDeUsuario(usuarioId);
    for (const p of mios) {
      const i = this.instalaciones.get(p.id);
      if (i && i.cuenta.toLowerCase() === cuenta.toLowerCase()) return i;
    }
    return undefined;
  }

  async instalacionConCuenta(proyectoId: string) {
    return this.instalaciones.get(proyectoId);
  }

  async guardarInstalacion(proyectoId: string, installationId: number, cuenta: string) {
    this.instalaciones.set(proyectoId, { installationId, cuenta });
  }

  /** Los repos, por proyecto. `reposDeProyecto` los devuelve. */
  private reposPorProyecto = new Map<string, RepoDelProyecto[]>();

  async vincularRepo(
    proyectoId: string,
    nombre: string,
    github: string,
    soloLectura = false,
    creadoPorElBot = false,
  ) {
    const anteriores = this.reposPorProyecto.get(proyectoId) ?? [];
    const existente = anteriores.find((r) => r.nombre === nombre);
    const otros = anteriores.filter((r) => r.nombre !== nombre);
    this.reposPorProyecto.set(proyectoId, [
      ...otros,
      {
        nombre,
        github_repo: github,
        ...(soloLectura ? { solo_lectura: true } : {}),
        // Espeja PgStore.vincularRepo: un reintento no pisa lo que ya habia.
        // `creado_por_el_bot` no puede convertirse en true por un reintento
        // ajeno, y `render_service_id` no se puede perder porque alguien
        // volvio a vincular el mismo repo.
        creado_por_el_bot: existente?.creado_por_el_bot ?? creadoPorElBot,
        render_service_id: existente?.render_service_id ?? null,
      },
    ]);
  }

  async reposDeProyecto(proyectoId: string): Promise<RepoDelProyecto[]> {
    return this.reposPorProyecto.get(proyectoId) ?? [];
  }

  async guardarRenderServiceId(proyectoId: string, nombre: string, serviceId: string): Promise<void> {
    const repos = this.reposPorProyecto.get(proyectoId) ?? [];
    const i = repos.findIndex((r) => r.nombre === nombre);
    if (i >= 0) repos[i] = { ...repos[i]!, render_service_id: serviceId };
  }

  async idDeProyecto(nombre: string): Promise<string | null> {
    for (const [id, p] of this.proyectos) {
      if (p.nombre === nombre) return id;
    }
    return null;
  }

  async turnosRecientes(): Promise<Array<{ prompt: string; respuesta: string }>> {
    return [];
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

  async agentesDeUsuario(usuarioId: string): Promise<AgenteResumen[]> {
    const mios = new Set((await this.proyectosDeUsuario(usuarioId)).map((p) => p.id));
    return [...this.agentes.entries()]
      .filter(([, a]) => mios.has(a.proyectoId))
      .map(([slot, a]) => ({
        slot: slot as AgentId,
        ...(a.nombre !== undefined ? { nombre: a.nombre } : {}),
        ...(a.cuenta !== undefined ? { cuenta: a.cuenta } : {}),
      }))
      .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }));
  }

  private agotados = new Map<string, Agotamiento>();

  async marcarAgotado(slot: AgentId, resets?: string): Promise<void> {
    this.agotados.set(slot, { resets, vistoEn: new Date() });
  }

  async limpiarAgotado(slot: AgentId): Promise<void> {
    this.agotados.delete(slot);
  }

  async slotsAgotados(): Promise<Map<string, Agotamiento>> {
    // El filtro por antiguedad va ACA y no en el que escribe: una marca no
    // caduca porque alguien la mire, caduca por su cuenta.
    const corte = Date.now() - HORAS_DE_AGOTAMIENTO * 3600_000;
    return new Map(
      [...this.agotados.entries()].filter(([, a]) => a.vistoEn.getTime() > corte),
    );
  }

  private vinculos = new Map<number, string>();
  private codigos = new Map<string, { chatId: number; expira: number; usado: boolean }>();

  async usuarioDeChat(chatId: number): Promise<string | undefined> {
    return this.vinculos.get(chatId);
  }

  async desvincularChat(chatId: number, usuarioId: string): Promise<boolean> {
    if (this.vinculos.get(chatId) !== usuarioId) return false;
    this.vinculos.delete(chatId);
    return true;
  }

  private nombres = new Map<string, string>();

  /** Solo para los tests: define como se llama un usuario. */
  ponerNombre(usuarioId: string, nombre: string): void {
    this.nombres.set(usuarioId, nombre);
  }

  async nombreDeUsuario(usuarioId: string): Promise<string | undefined> {
    return this.nombres.get(usuarioId);
  }

  private pendientes = new Map<number, string>();

  async setPendiente(chatId: number, prompt: string | null): Promise<void> {
    if (prompt === null) this.pendientes.delete(chatId);
    else this.pendientes.set(chatId, prompt);
  }

  async tomarPendiente(chatId: number): Promise<string | undefined> {
    const p = this.pendientes.get(chatId);
    this.pendientes.delete(chatId);
    return p;
  }

  private cowork = new Map<number, Set<AgentId>>();

  async agentesDeCowork(chatId: number): Promise<AgentId[]> {
    return [...(this.cowork.get(chatId) ?? [])].sort((a, b) =>
      a.localeCompare(b, 'en', { numeric: true }),
    );
  }

  async alternarCowork(chatId: number, slot: AgentId): Promise<AgentId[]> {
    const actual = this.cowork.get(chatId) ?? new Set<AgentId>();
    if (actual.has(slot)) actual.delete(slot);
    else actual.add(slot);
    this.cowork.set(chatId, actual);
    return this.agentesDeCowork(chatId);
  }

  private modos = new Map<number, ModoPermiso>();

  async modoDeChat(chatId: number): Promise<ModoPermiso | undefined> {
    return this.modos.get(chatId);
  }

  async setModoDeChat(chatId: number, modo: ModoPermiso): Promise<void> {
    this.modos.set(chatId, modo);
  }

  private modelos = new Map<number, ClaveDeModelo>();

  async modeloDeChat(chatId: number): Promise<ClaveDeModelo | undefined> {
    return this.modelos.get(chatId);
  }

  async setModeloDeChat(chatId: number, modelo: ClaveDeModelo): Promise<void> {
    this.modelos.set(chatId, modelo);
  }

  private cola: Tarea[] = [];

  async encolar(chatId: number, e: Encargo): Promise<number> {
    const base = this.cola.filter((t) => t.chatId === chatId).length;
    e.textos.forEach((texto, i) => {
      this.cola.push({
        id: randomUUID(),
        chatId,
        agente: e.agente,
        proyecto: e.proyecto,
        texto,
        posicion: base + i,
        estado: 'pendiente',
        ...(e.corridaId ? { corridaId: e.corridaId } : {}),
        ...(e.ronda !== undefined ? { ronda: e.ronda } : {}),
      });
    });
    return e.textos.length;
  }

  async tareasDeChat(chatId: number): Promise<Tarea[]> {
    return this.cola.filter((t) => t.chatId === chatId).sort((a, b) => a.posicion - b.posicion);
  }

  async proximaTarea(chatId: number, corridaId?: string): Promise<Tarea | undefined> {
    return (await this.tareasDeChat(chatId)).find(
      (t) => t.estado === 'pendiente' && (corridaId === undefined || t.corridaId === corridaId),
    );
  }

  async tomarProxima(chatId: number, corridaId?: string): Promise<Tarea | undefined> {
    const t = await this.proximaTarea(chatId, corridaId);
    if (t) t.estado = 'corriendo';
    return t;
  }

  async cerrarTarea(
    id: string,
    estado: 'lista' | 'fallida',
    resultado?: string,
    agenteReal?: string,
  ): Promise<void> {
    const t = this.cola.find((x) => x.id === id);
    if (!t) return;
    t.estado = estado;
    t.resultado = resultado;
    if (agenteReal) t.agente = agenteReal;
  }

  async cancelarCola(chatId: number, corridaId?: string): Promise<number> {
    const pend = this.cola.filter(
      (t) =>
        t.chatId === chatId &&
        t.estado === 'pendiente' &&
        (corridaId === undefined || t.corridaId === corridaId),
    );
    for (const t of pend) t.estado = 'cancelada';
    return pend.length;
  }

  /** Las corridas, por id. Ver `corrida.ts`. */
  private corridas = new Map<string, Corrida>();

  async abrirCorrida(datos: {
    chatId: number;
    proyecto: string;
    md: string;
    techoRondas: number;
    techoHora: string;
  }): Promise<Corrida | undefined> {
    // El equivalente en memoria del indice unico parcial de la migracion 023.
    if (await this.corridaAbierta(datos.chatId)) return undefined;
    const c: Corrida = {
      id: randomUUID(),
      chatId: datos.chatId,
      proyecto: datos.proyecto,
      md: datos.md,
      ronda: 1,
      techoRondas: datos.techoRondas,
      techoHora: datos.techoHora,
      fallosSeguidos: 0,
      estado: 'abierta',
      creadoEn: new Date(),
    };
    this.corridas.set(c.id, c);
    return c;
  }

  async corridaAbierta(chatId: number): Promise<Corrida | undefined> {
    return [...this.corridas.values()].find(
      (c) => c.chatId === chatId && c.estado === 'abierta',
    );
  }

  async corridasAbiertas(): Promise<Corrida[]> {
    return [...this.corridas.values()].filter((c) => c.estado === 'abierta');
  }

  async corridaDeJob(jobId: string): Promise<Corrida | undefined> {
    const chatId = this.chatsDeJob.get(jobId);
    if (chatId === undefined) return undefined;
    return this.corridaAbierta(chatId);
  }

  async cerrarCorrida(id: string, motivo: MotivoDeCierre): Promise<void> {
    const c = this.corridas.get(id);
    if (!c || c.estado === 'cerrada') return;
    c.estado = 'cerrada';
    c.motivoDeCierre = motivo;
  }

  async avanzarRonda(id: string): Promise<number> {
    const c = this.corridas.get(id);
    if (!c) return 0;
    c.ronda += 1;
    return c.ronda;
  }

  async contarFallo(id: string, fallo: boolean): Promise<number> {
    const c = this.corridas.get(id);
    if (!c) return 0;
    c.fallosSeguidos = fallo ? c.fallosSeguidos + 1 : 0;
    return c.fallosSeguidos;
  }

  async tareasDeCorrida(corridaId: string): Promise<Tarea[]> {
    return this.cola
      .filter((t) => t.corridaId === corridaId)
      .sort((a, b) => a.posicion - b.posicion);
  }

  async marcarHuecos(corridaId: string, ronda: number): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (c) c.huecosDeRonda = ronda;
  }

  async anotarPendiente(corridaId: string, texto: string): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (!c) return;
    const ya = c.pendientes ?? [];
    if (!ya.includes(texto)) c.pendientes = [...ya, texto];
  }

  async guardarVeredicto(
    corridaId: string,
    eje: Eje,
    cumple: boolean,
    resumen: string,
  ): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (!c) return;
    const otros = (c.veredictos ?? []).filter((v) => v.eje !== eje);
    c.veredictos = [...otros, { eje, cumple, resumen }];
  }

  async guardarContrato(corridaId: string, contrato: string): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (c) c.contrato = contrato;
  }

  async reanudarCorrida(
    chatId: number,
  ): Promise<{ corrida: Corrida; reencoladas: number } | undefined> {
    if ([...this.corridas.values()].some((c) => c.chatId === chatId && c.estado === 'abierta')) {
      return undefined;
    }
    const cerradas = [...this.corridas.values()]
      .filter((c) => c.chatId === chatId && c.estado === 'cerrada')
      .sort((a, b) => b.creadoEn.getTime() - a.creadoEn.getTime());
    const c = cerradas[0];
    if (!c || !SE_PUEDE_REANUDAR.includes(c.motivoDeCierre as MotivoDeCierre)) return undefined;

    c.estado = 'abierta';
    delete c.motivoDeCierre;
    c.fallosSeguidos = 0;
    c.creadoEn = new Date();

    let reencoladas = 0;
    for (const t of this.cola) {
      if (t.corridaId !== c.id) continue;
      if (t.estado !== 'fallida' && t.estado !== 'cancelada') continue;
      t.estado = 'pendiente';
      reencoladas += 1;
    }
    return { corrida: c, reencoladas };
  }

  async guardarPreguntas(corridaId: string, preguntas: readonly string[]): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (!c) return;
    c.preguntas = [...preguntas];
    c.preguntadoEn = new Date();
  }

  async guardarRespuestas(corridaId: string, respuestas: string): Promise<void> {
    const c = this.corridas.get(corridaId);
    if (c) c.respuestas = respuestas;
  }

  /** Solo para los tests: mueve el momento en que se pregunto. */
  ponerPreguntadoEn(corridaId: string, cuando: Date): void {
    const c = this.corridas.get(corridaId);
    if (c) c.preguntadoEn = cuando;
  }

  private borradores = new Map<number, Borrador>();

  async borradorDeChat(chatId: number) {
    const b = this.borradores.get(chatId);
    if (!b) return undefined;
    if (Date.now() - (this.borradoresDesde.get(chatId) ?? 0) > MINUTOS_DE_BORRADOR * 60_000) {
      this.borradores.delete(chatId);
      return undefined;
    }
    return b;
  }

  /** Cuando nacio cada borrador. En Postgres es la columna `creado_en`. */
  private borradoresDesde = new Map<number, number>();

  /** Solo para los tests: envejece un borrador. */
  envejecerBorrador(chatId: number, minutos: number): void {
    this.borradoresDesde.set(chatId, Date.now() - minutos * 60_000);
  }

  async guardarBorrador(
    chatId: number,
    paso: Borrador['paso'],
    proyecto?: string,
    org?: string,
  ) {
    // Lo que no se pasa NO se borra, igual que el COALESCE del INSERT de
    // Postgres. Este doble estaba pisando la org y por eso se comportaba
    // distinto de produccion: un test verde aca con un bug alla es peor que no
    // tener el doble.
    const previo = this.borradores.get(chatId);
    this.borradores.set(chatId, {
      chatId,
      paso,
      ...(proyecto ?? previo?.proyecto ? { proyecto: proyecto ?? previo!.proyecto! } : {}),
      ...(org ?? previo?.org ? { org: org ?? previo!.org! } : {}),
    });
    if (!previo) this.borradoresDesde.set(chatId, Date.now());
  }

  async borrarBorrador(chatId: number) {
    this.borradores.delete(chatId);
  }

  async cuentasConectadas(usuarioId: string) {
    const mios = await this.proyectosDeUsuario(usuarioId);
    const vistas = new Map<string, { installationId: number; cuenta: string }>();
    for (const p of mios) {
      const i = this.instalaciones.get(p.id);
      if (i) vistas.set(i.cuenta.toLowerCase(), i);
    }
    // Ordenadas por cuenta, igual que el `ORDER BY gi.cuenta` de Postgres.
    //
    // Sin esto el doble devolvia en orden de proyecto, y de ahi sale el ORDEN DE
    // LOS BOTONES: un test verde con otro orden en produccion es un boton que
    // aparece en otro lugar del que se probo. Es la segunda vez que este doble
    // se separa de la base y por eso vale la linea.
    return [...vistas.values()].sort((a, b) =>
      a.cuenta.localeCompare(b.cuenta, 'en', { sensitivity: 'base' }),
    );
  }

  private orgs = new Map<string, string>();

  async orgDeCorridas(usuarioId: string) {
    return this.orgs.get(usuarioId);
  }

  async setOrgDeCorridas(usuarioId: string, cuenta: string) {
    this.orgs.set(usuarioId, cuenta);
  }

  async referenciasConocidas(usuarioId: string) {
    const mios = await this.proyectosDeUsuario(usuarioId);
    const nombres = new Set<string>();
    for (const p of mios) {
      for (const r of this.reposPorProyecto.get(p.id) ?? []) {
        if (r.solo_lectura) nombres.add(r.nombre);
      }
    }
    return [...nombres].sort();
  }

  /** Solo para los tests: mueve el arranque de una corrida en el tiempo. */
  ponerCreadoEnDeCorrida(id: string, cuando: Date): void {
    const c = this.corridas.get(id);
    if (c) c.creadoEn = cuando;
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

  // --- Drive en vivo -------------------------------------------------------

  private googleCuentas = new Map<string, { email: string; refreshToken: string }>();
  private pedidosDeDrive = new Map<
    string,
    {
      usuarioId: string;
      nombre: string;
      expira: number;
      usado: boolean;
      archivoId?: string;
      usadoEn?: number;
    }
  >();

  async googleCuenta(usuarioId: string) {
    return this.googleCuentas.get(usuarioId);
  }

  async guardarGoogleCuenta(usuarioId: string, email: string, refreshToken: string): Promise<void> {
    this.googleCuentas.set(usuarioId, { email, refreshToken });
  }

  async borrarGoogleCuenta(usuarioId: string): Promise<boolean> {
    return this.googleCuentas.delete(usuarioId);
  }

  async crearPedidoDeDrive(usuarioId: string, nombre: string, minutos: number): Promise<string> {
    const codigo = codigoDeUrl();
    this.pedidosDeDrive.set(codigo, {
      usuarioId,
      nombre,
      expira: Date.now() + minutos * 60_000,
      usado: false,
    });
    return codigo;
  }

  async canjearPedidoDeDrive(codigo: string, archivoId: string) {
    const p = this.pedidosDeDrive.get(codigo);
    if (!p) return { estado: 'desconocido' as const };
    if (p.usado) return { estado: 'usado' as const };
    if (p.expira <= Date.now()) return { estado: 'vencido' as const };
    p.usado = true;
    p.archivoId = archivoId;
    p.usadoEn = Date.now();
    return { estado: 'ok' as const, usuarioId: p.usuarioId, nombre: p.nombre };
  }

  async archivoAutorizadoReciente(usuarioId: string, nombre: string, minutos: number) {
    const desde = Date.now() - minutos * 60_000;
    for (const p of this.pedidosDeDrive.values()) {
      if (p.usuarioId !== usuarioId || !p.archivoId) continue;
      if ((p.usadoEn ?? 0) < desde) continue;
      // Se compara sin distinguir mayusculas y en las dos direcciones: el
      // agente puede buscar "Balance" habiendo pedido "Balance 2026", o al
      // reves.
      const a = p.nombre.toLowerCase();
      const b = nombre.toLowerCase();
      if (a.includes(b) || b.includes(a)) return { id: p.archivoId, nombre: p.nombre };
    }
    return undefined;
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

  async getSession(proyectoId: string, agent: AgentId) {
    const r = await this.pool.query<{ session_id: string }>(
      'SELECT session_id FROM agent_session WHERE proyecto_id = $1 AND agente = $2',
      [proyectoId, agent],
    );
    return r.rows[0]?.session_id;
  }

  async setSession(proyectoId: string, agent: AgentId, sessionId: string) {
    await this.pool.query(
      `INSERT INTO agent_session (proyecto_id, agente, session_id) VALUES ($1, $2, $3)
       ON CONFLICT (proyecto_id, agente)
       DO UPDATE SET session_id = $3, updated_at = now()`,
      [proyectoId, agent, sessionId],
    );
  }

  async deleteSessions(agent: AgentId) {
    const r = await this.pool.query('DELETE FROM agent_session WHERE agente = $1', [agent]);
    return r.rowCount ?? 0;
  }

  async createJob(job: NewJob) {
    const id = randomUUID();
    // `proyecto_id` sale del NOMBRE, con un subselect y no con una consulta
    // aparte: es una sola ida a la base y no hay ventana entre las dos.
    //
    // Sin esto la columna queda NULL, y con ella queda afuera todo lo que
    // filtra por proyecto: la policy de RLS de jobs, el filtro de Realtime del
    // panel en vivo y la aprobacion, que hereda el proyecto de su job. El panel
    // no mostraria nada y no habria ningun error que lo explique.
    //
    // Queda NULL igual si el proyecto no esta en la tabla —los que vienen de
    // config/projects.json y todavia no se crearon desde el panel—: el turno
    // tiene que correr igual, que es lo que el sistema hacia antes de que
    // existieran los proyectos.
    await this.pool.query(
      `INSERT INTO jobs (id, chat_id, agent, project, prompt, status, message_id,
                         proyecto_id, usuario_id, origen)
       VALUES ($1, $2, $3, $4, $5, 'running', $6,
               COALESCE($7::uuid, (SELECT id FROM proyectos WHERE nombre = $4)),
               $8, $9)`,
      [
        id,
        job.chatId,
        job.agent,
        job.project,
        job.prompt,
        job.messageId,
        job.proyectoId ?? null,
        job.usuarioId ?? null,
        job.origen ?? null,
      ],
    );
    return id;
  }

  async finishJob(
    jobId: string,
    status: JobStatus,
    error?: string,
    respuesta?: string,
    consumo?: Consumo,
  ) {
    // COALESCE en la respuesta: un finishJob de error no puede borrar lo que ya
    // habia contestado el agente antes de que algo fallara despues. Lo mismo
    // con el consumo: el turno gasto lo que gasto, aunque despues fallara.
    await this.pool.query(
      `UPDATE jobs SET status = $2, error = $3, respuesta = COALESCE($4, respuesta),
              tokens = COALESCE($5, tokens), costo_usd = COALESCE($6, costo_usd),
              ended_at = now()
        WHERE id = $1`,
      [jobId, status, error ?? null, respuesta ?? null, consumo?.tokens ?? null, consumo?.costoUsd ?? null],
    );
  }

  async documentosDeProyecto(proyectoId: string): Promise<DocumentoDeProyecto[]> {
    const r = await this.pool.query<DocumentoDeProyecto>(
      `SELECT nombre, ruta, ruta_texto, es_instruccion FROM documentos
        WHERE proyecto_id = $1 ORDER BY nombre`,
      [proyectoId],
    );
    return r.rows;
  }

  async guardarDocumento(fila: FilaDeDocumento): Promise<void> {
    await this.pool.query(
      `INSERT INTO documentos
         (proyecto_id, nombre, nombre_original, ruta, ruta_texto, tipo, bytes, error, subido_por, origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'panel'))
       ON CONFLICT (proyecto_id, nombre) DO UPDATE SET
         nombre_original = EXCLUDED.nombre_original,
         ruta = EXCLUDED.ruta,
         ruta_texto = EXCLUDED.ruta_texto,
         tipo = EXCLUDED.tipo,
         bytes = EXCLUDED.bytes,
         error = EXCLUDED.error,
         subido_por = EXCLUDED.subido_por,
         origen = EXCLUDED.origen`,
      [
        fila.proyectoId,
        fila.nombre,
        fila.nombreOriginal,
        fila.ruta,
        fila.rutaTexto,
        fila.tipo,
        fila.bytes,
        fila.error ?? null,
        fila.subidoPor,
        fila.origen ?? null,
      ],
    );
  }

  async consumoPorAgente(): Promise<Map<string, Consumo>> {
    // La ventana de 5 horas, la misma del limite de Anthropic. El indice de la
    // migracion 021 cubre exactamente este WHERE.
    const r = await this.pool.query<{ agent: string; tokens: string; costo: string }>(
      `SELECT agent,
              COALESCE(SUM(tokens), 0)::text tokens,
              COALESCE(SUM(costo_usd), 0)::text costo
         FROM jobs
        WHERE tokens IS NOT NULL
          AND created_at > now() - interval '${HORAS_DE_AGOTAMIENTO} hours'
        GROUP BY agent`,
    );
    // Los dos vienen como texto: un BIGINT de SUM no entra siempre en un number
    // de JS, y un NUMERIC pasado a float pierde los centavos.
    return new Map(
      r.rows.map((f) => [f.agent, { tokens: Number(f.tokens), costoUsd: Number(f.costo) }]),
    );
  }

  async getJobRespuesta(jobId: string) {
    const r = await this.pool.query<{ respuesta: string | null }>(
      'SELECT respuesta FROM jobs WHERE id = $1',
      [jobId],
    );
    return r.rows[0]?.respuesta ?? undefined;
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

  async contextoDeJob(jobId: string) {
    const r = await this.pool.query<{ proyecto_id: string | null; usuario_id: string | null }>(
      'SELECT proyecto_id, usuario_id FROM jobs WHERE id = $1',
      [jobId],
    );
    const fila = r.rows[0];
    if (!fila) return undefined;
    // Los NULL se omiten en vez de viajar como null: las dos columnas pueden
    // estar vacias —un proyecto que solo vive en config/projects.json, un chat
    // sin vincular— y quien llama tiene que decidir que hacer con la falta, no
    // recibir un null que parece un id.
    return {
      ...(fila.proyecto_id ? { proyectoId: fila.proyecto_id } : {}),
      ...(fila.usuario_id ? { usuarioId: fila.usuario_id } : {}),
    };
  }

  async getJobError(jobId: string) {
    const r = await this.pool.query<{ error: string | null }>(
      'SELECT error FROM jobs WHERE id = $1',
      [jobId],
    );
    return r.rows[0]?.error ?? undefined;
  }

  async recordApproval(rec: ApprovalRecord) {
    // El proyecto se hereda del job. Duplicarlo aca es a proposito: la policy
    // de RLS lo consulta en cada fila, y llegar al proyecto por el join con
    // jobs haria que cada lectura de aprobaciones arrastre esa tabla.
    const r = await this.pool.query(
      `INSERT INTO approvals (approval_id, job_id, chat_id, message_id, agent, tool, summary, proyecto_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT proyecto_id FROM jobs WHERE id = $2))
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

  async setApprovalMessage(approvalId: string, messageId: number): Promise<void> {
    await this.pool.query(
      'UPDATE approvals SET message_id = $2 WHERE approval_id = $1',
      [approvalId, messageId],
    );
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

  async turnosRecientes(
    proyectoId: string,
    agente: string,
    limite: number,
  ): Promise<Array<{ prompt: string; respuesta: string }>> {
    // DESC en la consulta y reverse despues: el LIMIT tiene que quedarse con los
    // mas NUEVOS, y el prompt los necesita en orden cronologico.
    const r = await this.pool.query<{ prompt: string; respuesta: string }>(
      `SELECT prompt, respuesta
         FROM jobs
        WHERE proyecto_id = $1 AND agent = $2 AND status = 'done' AND respuesta IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $3`,
      [proyectoId, agente, limite],
    );
    return r.rows.reverse();
  }

  async reposDeProyecto(proyectoId: string): Promise<RepoDelProyecto[]> {
    // La tabla es del plan 2 y se crea a mano en Supabase; si no esta, el turno
    // sigue y el gateway usa su catalogo local. Por eso el catch.
    try {
      const r = await this.pool.query<{
        nombre: string;
        github_repo: string;
        solo_lectura: boolean;
        creado_por_el_bot: boolean;
        render_service_id: string | null;
      }>(
        // `COALESCE` en `solo_lectura` porque la columna es de la migracion
        // 024: contra una base que todavia no la corrio, el SELECT fallaria
        // entero y el proyecto se quedaria sin repos — un fallo mucho mas
        // grande que el que agrega. `creado_por_el_bot` y `render_service_id`
        // son de la migracion 031 y no llevan COALESCE: si faltan, es porque
        // esa migracion no corrio, y ahi SI conviene que el SELECT completo
        // falle e informe [] en vez de mentir que ningun repo es del bot.
        `SELECT nombre, github_repo, COALESCE(solo_lectura, false) solo_lectura,
                creado_por_el_bot, render_service_id
           FROM repos WHERE proyecto_id = $1 ORDER BY nombre`,
        [proyectoId],
      );
      return r.rows.map((f) => ({
        nombre: f.nombre,
        github_repo: f.github_repo,
        // `solo_lectura` se omite cuando es false en vez de viajar como
        // `false`: el gateway lo lee como opcional, y asi el cuerpo del
        // pedido de un proyecto sin referencias queda igual que antes de esta
        // feature.
        ...(f.solo_lectura ? { solo_lectura: true } : {}),
        // `creado_por_el_bot` y `render_service_id`, al reves, NUNCA se
        // omiten: son la base del merge automatico y de la idempotencia del
        // deploy, y un campo ausente ahi seria un bug disfrazado de dato.
        creado_por_el_bot: f.creado_por_el_bot,
        render_service_id: f.render_service_id,
      }));
    } catch {
      return [];
    }
  }

  async guardarRenderServiceId(
    proyectoId: string,
    nombre: string,
    serviceId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE repos SET render_service_id = $3 WHERE proyecto_id = $1 AND nombre = $2`,
      [proyectoId, nombre, serviceId],
    );
  }

  async idDeProyecto(nombre: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      'SELECT id FROM proyectos WHERE nombre = $1',
      [nombre],
    );
    return r.rows[0]?.id ?? null;
  }

  async instalacionDeProyecto(proyectoId: string): Promise<number | undefined> {
    // La tabla puede no existir todavia: es del plan 3 y se crea a mano en
    // Supabase (docs/supabase-github-instalaciones.sql). Si no esta, el turno
    // tiene que seguir por SSH y no volverse un error — por eso el catch.
    try {
      const r = await this.pool.query<{ installation_id: string }>(
        'SELECT installation_id FROM github_instalaciones WHERE proyecto_id = $1',
        [proyectoId],
      );
      // bigint viene como string en node-postgres: un id de instalacion entra
      // holgado en un number, pero el parseo tiene que ser explicito.
      const id = r.rows[0]?.installation_id;
      return id === undefined ? undefined : Number(id);
    } catch {
      return undefined;
    }
  }

  async instalacionDeCuenta(
    usuarioId: string,
    cuenta: string,
  ): Promise<{ installationId: number; cuenta: string } | undefined> {
    // El JOIN contra `miembros` es la autorizacion, no un detalle de la
    // consulta: sin el, nombrar la org de un desconocido alcanzaria para
    // heredar su instalacion y crear repos ahi.
    //
    // ILIKE y no `=`: la cuenta la escribe una persona en Telegram, y
    // "sincro-arg" es el mismo lugar que "Sincro-arg" para GitHub.
    try {
      const r = await this.pool.query<{ installation_id: string; cuenta: string }>(
        `SELECT gi.installation_id, gi.cuenta
           FROM github_instalaciones gi
           JOIN miembros m ON m.proyecto_id = gi.proyecto_id
          WHERE m.usuario_id = $1 AND gi.cuenta ILIKE $2
          LIMIT 1`,
        [usuarioId, cuenta],
      );
      const fila = r.rows[0];
      // bigint viene como string en node-postgres. Mismo cuidado que en
      // `instalacionDeProyecto`.
      return fila ? { installationId: Number(fila.installation_id), cuenta: fila.cuenta } : undefined;
    } catch {
      // La tabla puede no existir todavia: se crea a mano en Supabase. Sin
      // ella no hay herencia posible, que es distinto de un error.
      return undefined;
    }
  }

  async instalacionConCuenta(
    proyectoId: string,
  ): Promise<{ installationId: number; cuenta: string } | undefined> {
    try {
      const r = await this.pool.query<{ installation_id: string; cuenta: string }>(
        'SELECT installation_id, cuenta FROM github_instalaciones WHERE proyecto_id = $1',
        [proyectoId],
      );
      const f = r.rows[0];
      return f ? { installationId: Number(f.installation_id), cuenta: f.cuenta } : undefined;
    } catch {
      return undefined;
    }
  }

  async guardarInstalacion(proyectoId: string, installationId: number, cuenta: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO github_instalaciones (proyecto_id, installation_id, cuenta)
       VALUES ($1, $2, $3)
       ON CONFLICT (proyecto_id) DO UPDATE SET installation_id = $2, cuenta = $3`,
      [proyectoId, installationId, cuenta],
    );
  }

  async vincularRepo(
    proyectoId: string,
    nombre: string,
    github: string,
    soloLectura = false,
    creadoPorElBot = false,
  ): Promise<void> {
    // ON CONFLICT porque el nombre es unico por proyecto y reintentar una
    // corrida que fallo a la mitad no puede chocar contra lo que ya entro.
    //
    // `creado_por_el_bot` NO se pisa en el UPDATE: si el repo ya existia como
    // de una persona, un reintento no puede convertirlo en uno del bot y
    // habilitarle el merge automatico.
    await this.pool.query(
      `INSERT INTO repos (proyecto_id, nombre, github_repo, solo_lectura, creado_por_el_bot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (proyecto_id, nombre)
       DO UPDATE SET github_repo = $3, solo_lectura = $4`,
      [proyectoId, nombre, github, soloLectura, creadoPorElBot],
    );
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

  /**
   * Del slot a su proyecto, y del proyecto a su dueño.
   *
   * Un JOIN y no dos queries: esto corre por cada tarea de una corrida, y la
   * alternativa —traer los proyectos y despues los agentes— hace dos viajes
   * para contestar una sola pregunta.
   */
  async agentesDeUsuario(usuarioId: string): Promise<AgenteResumen[]> {
    const r = await this.pool.query<{ slot: AgentId; nombre: string | null; cuenta: string | null }>(
      `SELECT a.slot, a.nombre, a.cuenta
         FROM agentes a
         JOIN miembros m ON m.proyecto_id = a.proyecto_id
        WHERE m.usuario_id = $1
        ORDER BY a.slot`,
      [usuarioId],
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

  async marcarAgotado(slot: AgentId, resets?: string): Promise<void> {
    // `visto_en = now()` tambien en el UPDATE: si el slot ya estaba marcado y
    // se vuelve a agotar, lo que importa es la ultima vez. Sin esto la marca
    // caducaria contando desde la primera y volveria a mostrarse como listo.
    await this.pool.query(
      `INSERT INTO slots_agotados (slot, resets) VALUES ($1, $2)
       ON CONFLICT (slot) DO UPDATE SET resets = $2, visto_en = now()`,
      [slot, resets ?? null],
    );
  }

  async limpiarAgotado(slot: AgentId): Promise<void> {
    await this.pool.query('DELETE FROM slots_agotados WHERE slot = $1', [slot]);
  }

  async slotsAgotados(): Promise<Map<string, Agotamiento>> {
    // El corte por antiguedad va en el SELECT y no hay barrido que borre las
    // viejas: son una fila por slot como mucho, asi que la basura que puede
    // acumular tiene el tamaño del pool. Un job de limpieza para eso seria mas
    // codigo del que ahorra.
    const r = await this.pool.query<{ slot: string; resets: string | null; visto_en: Date }>(
      `SELECT slot, resets, visto_en FROM slots_agotados
       WHERE visto_en > now() - ($1 || ' hours')::interval`,
      [String(HORAS_DE_AGOTAMIENTO)],
    );
    return new Map(
      r.rows.map((f) => [f.slot, { resets: f.resets ?? undefined, vistoEn: f.visto_en }]),
    );
  }

  async usuarioDeChat(chatId: number): Promise<string | undefined> {
    const r = await this.pool.query<{ usuario_id: string }>(
      'SELECT usuario_id FROM telegram_vinculos WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.usuario_id;
  }

  /**
   * El `usuario_id` va en el WHERE y no se chequea antes en otra consulta.
   *
   * Con un SELECT y despues un DELETE hay una ventana entre los dos; y ademas
   * el WHERE es lo que hace imposible —no improbable— borrar el chat de otro.
   */
  async desvincularChat(chatId: number, usuarioId: string): Promise<boolean> {
    const r = await this.pool.query(
      'DELETE FROM telegram_vinculos WHERE chat_id = $1 AND usuario_id = $2',
      [chatId, usuarioId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * El nombre sale de `auth.users`, que es de Supabase y no de este esquema.
   *
   * El bridge se conecta como `postgres`, asi que la puede leer. Es la unica
   * fuente que hay: no existe una tabla de perfiles propia.
   */
  async nombreDeUsuario(usuarioId: string): Promise<string | undefined> {
    const r = await this.pool.query<{ email: string | null }>(
      'SELECT email FROM auth.users WHERE id = $1',
      [usuarioId],
    );
    const email = r.rows[0]?.email;
    if (!email) return undefined;
    const arroba = email.indexOf('@');
    return arroba > 0 ? email.slice(0, arroba) : email;
  }

  async setPendiente(chatId: number, prompt: string | null): Promise<void> {
    if (prompt === null) {
      await this.pool.query('DELETE FROM telegram_pendiente WHERE chat_id = $1', [chatId]);
      return;
    }
    await this.pool.query(
      `INSERT INTO telegram_pendiente (chat_id, prompt) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET prompt = $2, creado_en = now()`,
      [chatId, prompt],
    );
  }

  /**
   * Sacarlo y borrarlo en una sola sentencia, y no en dos.
   *
   * Con un SELECT y despues un DELETE, dos toques seguidos al boton mandan el
   * mismo mensaje dos veces: los dos leen antes de que ninguno borre. El
   * DELETE ... RETURNING lo resuelve en el unico lugar donde la carrera no
   * existe, que es adentro de Postgres.
   */
  async tomarPendiente(chatId: number): Promise<string | undefined> {
    const r = await this.pool.query<{ prompt: string }>(
      'DELETE FROM telegram_pendiente WHERE chat_id = $1 RETURNING prompt',
      [chatId],
    );
    return r.rows[0]?.prompt;
  }

  async agentesDeCowork(chatId: number): Promise<AgentId[]> {
    const r = await this.pool.query<{ slot: AgentId }>(
      // Numerico y no alfabetico: sin esto c10 sale antes que c2.
      `SELECT slot FROM telegram_cowork WHERE chat_id = $1
       ORDER BY length(slot), slot`,
      [chatId],
    );
    return r.rows.map((f) => f.slot);
  }

  /**
   * El toggle en UNA sentencia, y no en un SELECT seguido de un INSERT.
   *
   * Con dos, tocar dos veces seguido —o dos mensajes que llegan juntos— puede
   * leer los dos el mismo estado y dejar la lista al reves de lo que se pidio.
   * El DELETE ... RETURNING dice si habia algo, y solo si no habia se inserta.
   */
  async alternarCowork(chatId: number, slot: AgentId): Promise<AgentId[]> {
    const borrado = await this.pool.query(
      'DELETE FROM telegram_cowork WHERE chat_id = $1 AND slot = $2 RETURNING slot',
      [chatId, slot],
    );
    if (borrado.rowCount === 0) {
      await this.pool.query(
        `INSERT INTO telegram_cowork (chat_id, slot) VALUES ($1, $2)
         ON CONFLICT (chat_id, slot) DO NOTHING`,
        [chatId, slot],
      );
    }
    return this.agentesDeCowork(chatId);
  }

  async modoDeChat(chatId: number): Promise<ModoPermiso | undefined> {
    const r = await this.pool.query<{ modo: ModoPermiso }>(
      'SELECT modo FROM telegram_modo WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.modo;
  }

  async setModoDeChat(chatId: number, modo: ModoPermiso): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_modo (chat_id, modo) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET modo = $2, cambiado_en = now()`,
      [chatId, modo],
    );
  }

  async modeloDeChat(chatId: number): Promise<ClaveDeModelo | undefined> {
    const r = await this.pool.query<{ modelo: ClaveDeModelo }>(
      'SELECT modelo FROM telegram_modelo WHERE chat_id = $1',
      [chatId],
    );
    return r.rows[0]?.modelo;
  }

  async setModeloDeChat(chatId: number, modelo: ClaveDeModelo): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_modelo (chat_id, modelo) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET modelo = $2, cambiado_en = now()`,
      [chatId, modelo],
    );
  }

  async encolar(chatId: number, e: Encargo): Promise<number> {
    if (e.textos.length === 0) return 0;
    // La posicion arranca donde termino la cola anterior, asi que una tanda
    // nueva va al FINAL y no se mezcla con lo que ya estaba esperando.
    const r = await this.pool.query<{ n: number }>(
      'SELECT COALESCE(MAX(posicion) + 1, 0)::int n FROM cola_tareas WHERE chat_id = $1',
      [chatId],
    );
    const base = r.rows[0]?.n ?? 0;
    // UNNEST y no un INSERT por tarea: una tanda entra en una sola ida a la
    // base, y o entran todas o no entra ninguna.
    await this.pool.query(
      `INSERT INTO cola_tareas (chat_id, agente, proyecto, texto, posicion, corrida_id, ronda)
       SELECT $1, $2, $3, t.texto, $4 + (t.i - 1), $6::uuid, $7::int
       FROM unnest($5::text[]) WITH ORDINALITY AS t(texto, i)`,
      [chatId, e.agente, e.proyecto, base, e.textos, e.corridaId ?? null, e.ronda ?? null],
    );
    return e.textos.length;
  }

  private static readonly CAMPOS_TAREA =
    'id, chat_id, agente, proyecto, texto, posicion, estado, resultado, corrida_id, ronda';

  private aTarea(f: Record<string, unknown>): Tarea {
    return {
      id: f.id as string,
      chatId: Number(f.chat_id),
      agente: f.agente as string,
      proyecto: f.proyecto as string,
      texto: f.texto as string,
      posicion: f.posicion as number,
      estado: f.estado as Tarea['estado'],
      resultado: (f.resultado as string | null) ?? undefined,
      // Los NULL se omiten en vez de viajar como null, igual que en
      // `contextoDeJob`: una tarea dictada a mano no tiene corrida, y quien la
      // lee tiene que ver la falta, no un null que parece un id.
      ...(f.corrida_id ? { corridaId: f.corrida_id as string } : {}),
      ...(f.ronda !== null && f.ronda !== undefined ? { ronda: Number(f.ronda) } : {}),
    };
  }

  async tareasDeChat(chatId: number): Promise<Tarea[]> {
    const r = await this.pool.query(
      `SELECT ${PgStore.CAMPOS_TAREA} FROM cola_tareas WHERE chat_id = $1 ORDER BY posicion`,
      [chatId],
    );
    return r.rows.map((f) => this.aTarea(f));
  }

  async proximaTarea(chatId: number, corridaId?: string): Promise<Tarea | undefined> {
    // El `($2::uuid IS NULL OR ...)` es lo que hace que un solo SQL sirva para
    // los dos casos: dentro de una corrida se acota a las suyas, y una cola
    // dictada a mano —sin corrida— sigue viendo todo lo del chat.
    const r = await this.pool.query(
      `SELECT ${PgStore.CAMPOS_TAREA} FROM cola_tareas
       WHERE chat_id = $1 AND estado = 'pendiente'
         AND ($2::uuid IS NULL OR corrida_id = $2::uuid)
       ORDER BY posicion LIMIT 1`,
      [chatId, corridaId ?? null],
    );
    return r.rows[0] ? this.aTarea(r.rows[0]) : undefined;
  }

  /**
   * Tomarla y marcarla corriendo en UNA sentencia.
   *
   * El `FOR UPDATE SKIP LOCKED` del subselect es lo que hace que dos lectores
   * simultaneos no se lleven la misma: el segundo saltea la fila bloqueada y
   * agarra la siguiente, en vez de esperarla y despues pisarla.
   */
  async tomarProxima(chatId: number, corridaId?: string): Promise<Tarea | undefined> {
    const r = await this.pool.query(
      `UPDATE cola_tareas SET estado = 'corriendo', empezado_en = now()
       WHERE id = (
         SELECT id FROM cola_tareas
         WHERE chat_id = $1 AND estado = 'pendiente'
           AND ($2::uuid IS NULL OR corrida_id = $2::uuid)
         ORDER BY posicion LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${PgStore.CAMPOS_TAREA}`,
      [chatId, corridaId ?? null],
    );
    return r.rows[0] ? this.aTarea(r.rows[0]) : undefined;
  }

  async cerrarTarea(
    id: string,
    estado: 'lista' | 'fallida',
    resultado?: string,
    agenteReal?: string,
  ): Promise<void> {
    // `COALESCE` y no dos queries ni un `if`: sin relevo llega `null` y la
    // columna se sobreescribe con lo que ya tenia. Un `UPDATE ... = null`
    // pelado dejaria la tarea sin agente y el informe sin rama que nombrar.
    await this.pool.query(
      `UPDATE cola_tareas
          SET estado = $2, resultado = $3, cerrado_en = now(),
              agente = COALESCE($4, agente)
        WHERE id = $1`,
      [id, estado, resultado ?? null, agenteReal ?? null],
    );
  }

  /**
   * Cancela lo PENDIENTE, no lo que ya corre.
   *
   * Un turno en vuelo no se puede abortar —el agente ya esta trabajando— asi
   * que prometer que se detiene seria mentir. Lo que se corta es todo lo que
   * viene despues.
   */
  async cancelarCola(chatId: number, corridaId?: string): Promise<number> {
    // Mismo `($2::uuid IS NULL OR ...)` que `proximaTarea`: con corrida se
    // cancela solo lo suyo, y el `/cola cancelar` a mano —sin corrida— sigue
    // barriendo todo el chat.
    const r = await this.pool.query(
      `UPDATE cola_tareas SET estado = 'cancelada', cerrado_en = now()
       WHERE chat_id = $1 AND estado = 'pendiente'
         AND ($2::uuid IS NULL OR corrida_id = $2::uuid)`,
      [chatId, corridaId ?? null],
    );
    return r.rowCount ?? 0;
  }

  // --- Corridas desatendidas ------------------------------------------------

  private static readonly CAMPOS_CORRIDA =
    'id, chat_id, proyecto, md, ronda, techo_rondas, techo_hora, ' +
    'fallos_seguidos, huecos_de_ronda, pendientes, preguntas, respuestas, ' +
    'preguntado_en, estado, motivo_de_cierre, creado_en, veredictos, contrato';

  private aCorrida(f: Record<string, unknown>): Corrida {
    return {
      id: f.id as string,
      chatId: Number(f.chat_id),
      proyecto: f.proyecto as string,
      md: f.md as string,
      ronda: Number(f.ronda),
      techoRondas: Number(f.techo_rondas),
      techoHora: f.techo_hora as string,
      fallosSeguidos: Number(f.fallos_seguidos),
      ...(f.huecos_de_ronda !== null && f.huecos_de_ronda !== undefined
        ? { huecosDeRonda: Number(f.huecos_de_ronda) }
        : {}),
      ...(Array.isArray(f.pendientes) && f.pendientes.length > 0
        ? { pendientes: f.pendientes as string[] }
        : {}),
      ...(Array.isArray(f.preguntas) && f.preguntas.length > 0
        ? { preguntas: f.preguntas as string[] }
        : {}),
      ...(f.respuestas ? { respuestas: f.respuestas as string } : {}),
      ...(f.preguntado_en ? { preguntadoEn: new Date(f.preguntado_en as string) } : {}),
      estado: f.estado as Corrida['estado'],
      ...(f.motivo_de_cierre
        ? { motivoDeCierre: f.motivo_de_cierre as MotivoDeCierre }
        : {}),
      creadoEn: new Date(f.creado_en as string),
      ...(typeof f.contrato === 'string' && f.contrato !== ''
        ? { contrato: f.contrato }
        : {}),
      ...(veredictosDeFila(f.veredictos).length > 0
        ? { veredictos: veredictosDeFila(f.veredictos) }
        : {}),
    };
  }

  /**
   * Abre una corrida, o `undefined` si el chat ya tiene una.
   *
   * `ON CONFLICT DO NOTHING` contra el indice unico parcial de la migracion
   * 023, y no un SELECT previo: dos `/corrida` mandados juntos pasarian los dos
   * por el chequeo, y la unica forma de que solo uno gane es que lo decida la
   * base. El `undefined` que vuelve es lo que el comando traduce a "ya tenes
   * una corriendo".
   */
  async abrirCorrida(datos: {
    chatId: number;
    proyecto: string;
    md: string;
    techoRondas: number;
    techoHora: string;
  }): Promise<Corrida | undefined> {
    const r = await this.pool.query(
      `INSERT INTO corridas (chat_id, proyecto, md, techo_rondas, techo_hora)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING ${PgStore.CAMPOS_CORRIDA}`,
      [datos.chatId, datos.proyecto, datos.md, datos.techoRondas, datos.techoHora],
    );
    return r.rows[0] ? this.aCorrida(r.rows[0]) : undefined;
  }

  async corridaAbierta(chatId: number): Promise<Corrida | undefined> {
    const r = await this.pool.query(
      `SELECT ${PgStore.CAMPOS_CORRIDA} FROM corridas
       WHERE chat_id = $1 AND estado = 'abierta'`,
      [chatId],
    );
    return r.rows[0] ? this.aCorrida(r.rows[0]) : undefined;
  }

  async corridasAbiertas(): Promise<Corrida[]> {
    const r = await this.pool.query(
      `SELECT ${PgStore.CAMPOS_CORRIDA} FROM corridas WHERE estado = 'abierta'`,
    );
    return r.rows.map((f) => this.aCorrida(f));
  }

  async corridaDeJob(jobId: string): Promise<Corrida | undefined> {
    const r = await this.pool.query(
      // Un subselect y no un JOIN: asi la lista de columnas es la MISMA
      // constante que usan las otras dos consultas. Con un JOIN habria que
      // prefijarla, o sea mantener dos versiones del mismo listado.
      `SELECT ${PgStore.CAMPOS_CORRIDA} FROM corridas
       WHERE estado = 'abierta'
         AND chat_id = (SELECT chat_id FROM jobs WHERE id = $1)`,
      [jobId],
    );
    return r.rows[0] ? this.aCorrida(r.rows[0]) : undefined;
  }

  /**
   * Cierra la corrida, una sola vez.
   *
   * El `AND estado = 'abierta'` la hace idempotente, y hace falta: el ciclo
   * puede llegar al cierre por dos caminos —un techo y un analisis sin
   * huecos— y el CHECK `corridas_cierre_completo` rechazaria el segundo
   * intento por tener `cerrado_en` ya puesto. Con esto el segundo no toca nada
   * en vez de tirar.
   */
  async cerrarCorrida(id: string, motivo: MotivoDeCierre): Promise<void> {
    await this.pool.query(
      `UPDATE corridas SET estado = 'cerrada', motivo_de_cierre = $2, cerrado_en = now()
       WHERE id = $1 AND estado = 'abierta'`,
      [id, motivo],
    );
  }

  async avanzarRonda(id: string): Promise<number> {
    const r = await this.pool.query<{ ronda: number }>(
      'UPDATE corridas SET ronda = ronda + 1 WHERE id = $1 RETURNING ronda',
      [id],
    );
    return Number(r.rows[0]?.ronda ?? 0);
  }

  /**
   * Suma o resetea los fallos seguidos, en una sentencia.
   *
   * La suma se hace en SQL —`fallos_seguidos + 1`— y no leyendo el valor para
   * despues escribirlo: el bucle de la cola es uno solo, pero un reinicio a
   * mitad de camino con dos procesos vivos perderia una cuenta, y esa cuenta es
   * justo el techo que evita quemar la noche.
   */
  async contarFallo(id: string, fallo: boolean): Promise<number> {
    const r = await this.pool.query<{ fallos_seguidos: number }>(
      `UPDATE corridas SET fallos_seguidos = ${fallo ? 'fallos_seguidos + 1' : '0'}
       WHERE id = $1 RETURNING fallos_seguidos`,
      [id],
    );
    return Number(r.rows[0]?.fallos_seguidos ?? 0);
  }

  async tareasDeCorrida(corridaId: string): Promise<Tarea[]> {
    const r = await this.pool.query(
      `SELECT ${PgStore.CAMPOS_TAREA} FROM cola_tareas
       WHERE corrida_id = $1 ORDER BY posicion`,
      [corridaId],
    );
    return r.rows.map((f) => this.aTarea(f));
  }

  async guardarPreguntas(corridaId: string, preguntas: readonly string[]): Promise<void> {
    await this.pool
      .query(
        `UPDATE corridas SET preguntas = $2::text[], preguntado_en = now(), respuestas = NULL
          WHERE id = $1`,
        [corridaId, preguntas],
      )
      .catch(() => undefined);
  }

  async guardarRespuestas(corridaId: string, respuestas: string): Promise<void> {
    await this.pool
      .query('UPDATE corridas SET respuestas = $2 WHERE id = $1', [corridaId, respuestas])
      .catch(() => undefined);
  }

  async marcarHuecos(corridaId: string, ronda: number): Promise<void> {
    await this.pool.query('UPDATE corridas SET huecos_de_ronda = $2 WHERE id = $1', [
      corridaId,
      ronda,
    ]);
  }

  async guardarVeredicto(
    corridaId: string,
    eje: Eje,
    cumple: boolean,
    resumen: string,
  ): Promise<void> {
    // El `||` de jsonb pisa la clave si ya estaba, que es justo lo que se
    // quiere: el veredicto del cierre reemplaza al de la ronda 1. Y se arma con
    // `jsonb_build_object` y no interpolando: el resumen lo escribe un modelo.
    await this.pool
      .query(
        `UPDATE corridas
            SET veredictos = veredictos || jsonb_build_object(
                  $2::text, jsonb_build_object('cumple', $3::boolean, 'resumen', $4::text))
          WHERE id = $1`,
        [corridaId, eje, cumple, resumen],
      )
      // La columna es de la migracion 032. Contra una base que no la corrio,
      // perder una firma es menos grave que voltear el turno del analista.
      .catch(() => undefined);
  }

  async guardarContrato(corridaId: string, contrato: string): Promise<void> {
    // SIN el `.catch` que tienen los veredictos, a proposito: un veredicto
    // perdido es una linea menos en el informe, pero un contrato perdido es la
    // noche entera construyendo dos mitades que no encajan. Si esto falla, el
    // endpoint tiene que contestar error y el planificador enterarse.
    await this.pool.query('UPDATE corridas SET contrato = $2 WHERE id = $1', [corridaId, contrato]);
  }

  async reanudarCorrida(
    chatId: number,
  ): Promise<{ corrida: Corrida; reencoladas: number } | undefined> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');

      // Reabrir y reencolar en UNA transaccion: una corrida abierta cuyas
      // tareas quedaron fallidas es peor que no haber reanudado — el ciclo la
      // ve sin cola pendiente y arranca un analisis sobre trabajo a medias.
      //
      // El `WHERE` hace todo el trabajo:
      //  · `estado = 'cerrada'` y el motivo entre los reanudables: una corrida
      //    completa no se reanuda, y una cancelada la corto una persona.
      //  · `cerrado_en IS NOT NULL` lo pide el CHECK de la migracion 023, que
      //    exige que estado, motivo y fecha sean coherentes entre si. Por eso
      //    se limpian los DOS y no solo el motivo.
      //  · el indice unico `corridas_una_abierta_por_chat` es lo que impide
      //    reabrir una si el chat ya tiene otra abierta: no hace falta
      //    chequearlo antes, y chequearlo no serviria contra dos /reanudar
      //    mandados juntos.
      const r = await cliente.query(
        `UPDATE corridas SET estado = 'abierta', motivo_de_cierre = NULL, cerrado_en = NULL,
                fallos_seguidos = 0, creado_en = now()
           WHERE id = (
             SELECT id FROM corridas
              WHERE chat_id = $1 AND estado = 'cerrada'
                AND motivo_de_cierre = ANY($2::text[])
              ORDER BY creado_en DESC LIMIT 1
           )
         RETURNING ${PgStore.CAMPOS_CORRIDA}`,
        [chatId, [...SE_PUEDE_REANUDAR]],
      );
      if (!r.rows[0]) {
        await cliente.query('ROLLBACK');
        return undefined;
      }
      const corrida = this.aCorrida(r.rows[0]);

      // Lo que no se hizo vuelve a la cola. Las `fallida` se intentaron y
      // salieron mal; las `cancelada` nunca se intentaron porque el cierre las
      // corto. Las dos son trabajo pendiente del mismo pliego.
      //
      // `cerrado_en` y `resultado` se limpian: si quedaran, una tarea que
      // vuelve a fallar mostraria el error de la vez anterior.
      const t = await cliente.query(
        `UPDATE cola_tareas SET estado = 'pendiente', cerrado_en = NULL, resultado = NULL,
                empezado_en = NULL
           WHERE corrida_id = $1 AND estado IN ('fallida', 'cancelada')`,
        [corrida.id],
      );
      await cliente.query('COMMIT');
      return { corrida, reencoladas: t.rowCount ?? 0 };
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      cliente.release();
    }
  }

  async anotarPendiente(corridaId: string, texto: string): Promise<void> {
    // El `NOT (pendientes @> ARRAY[$2])` es la idempotencia, y va en el WHERE y
    // no en el codigo: dos turnos en paralelo que anoten lo mismo pasarian los
    // dos por un `if (!incluye)` de JavaScript.
    await this.pool
      .query(
        `UPDATE corridas SET pendientes = array_append(pendientes, $2)
          WHERE id = $1 AND NOT (pendientes @> ARRAY[$2]::text[])`,
        [corridaId, texto],
      )
      // La columna es de la migracion 026: contra una base que no la corrio,
      // perder un pendiente es mucho menos grave que voltear el turno.
      .catch(() => undefined);
  }

  async borradorDeChat(chatId: number): Promise<Borrador | undefined> {
    // El vencimiento va en el DELETE y no en un SELECT con filtro: asi el
    // borrador viejo se va de la tabla en vez de quedar para siempre esperando
    // que alguien lo limpie. Y el chat se destraba en el mismo pedido.
    await this.pool
      .query(
        `DELETE FROM corrida_borrador
          WHERE chat_id = $1 AND creado_en < now() - ($2 || ' minutes')::interval`,
        [chatId, String(MINUTOS_DE_BORRADOR)],
      )
      .catch(() => undefined);

    const r = await this.pool.query<{
      paso: string;
      proyecto: string | null;
      org: string | null;
    }>(
      // `COALESCE` no hace falta pero el SELECT nombra la columna, que es de la
      // migracion 027: contra una base que no la corrio, esto falla y el paso a
      // paso queda inservible. El catch de arriba no cubre este SELECT, asi que
      // el orden de las migraciones importa.
      'SELECT paso, proyecto, org FROM corrida_borrador WHERE chat_id = $1',
      [chatId],
    );
    const f = r.rows[0];
    return f
      ? {
          chatId,
          paso: f.paso as Borrador['paso'],
          ...(f.proyecto ? { proyecto: f.proyecto } : {}),
          ...(f.org ? { org: f.org } : {}),
        }
      : undefined;
  }

  async guardarBorrador(
    chatId: number,
    paso: Borrador['paso'],
    proyecto?: string,
    org?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO corrida_borrador (chat_id, paso, proyecto, org) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id)
       DO UPDATE SET paso = $2,
                     -- COALESCE para no PERDER lo que ya estaba: el paso del
                     -- pliego se guarda sin repetir la org, y sin esto la
                     -- borraria justo antes de usarla.
                     proyecto = COALESCE($3, corrida_borrador.proyecto),
                     org = COALESCE($4, corrida_borrador.org),
                     creado_en = now()`,
      [chatId, paso, proyecto ?? null, org ?? null],
    );
  }

  async borrarBorrador(chatId: number): Promise<void> {
    await this.pool.query('DELETE FROM corrida_borrador WHERE chat_id = $1', [chatId]);
  }

  async cuentasConectadas(
    usuarioId: string,
  ): Promise<Array<{ installationId: number; cuenta: string }>> {
    // El JOIN contra `miembros` es la autorizacion, igual que en
    // `instalacionDeCuenta`: solo las instalaciones de SUS proyectos.
    try {
      const r = await this.pool.query<{ installation_id: string; cuenta: string }>(
        `SELECT DISTINCT gi.installation_id, gi.cuenta
           FROM github_instalaciones gi
           JOIN miembros m ON m.proyecto_id = gi.proyecto_id
          WHERE m.usuario_id = $1
          ORDER BY gi.cuenta`,
        [usuarioId],
      );
      return r.rows.map((f) => ({ installationId: Number(f.installation_id), cuenta: f.cuenta }));
    } catch {
      return [];
    }
  }

  async orgDeCorridas(usuarioId: string): Promise<string | undefined> {
    try {
      const r = await this.pool.query<{ cuenta: string }>(
        'SELECT cuenta FROM org_de_corridas WHERE usuario_id = $1',
        [usuarioId],
      );
      return r.rows[0]?.cuenta;
    } catch {
      // La tabla es de la migracion 029: sin ella no hay preferencia, que es
      // distinto de un error. El flujo vuelve a preguntar.
      return undefined;
    }
  }

  async setOrgDeCorridas(usuarioId: string, cuenta: string): Promise<void> {
    await this.pool
      .query(
        `INSERT INTO org_de_corridas (usuario_id, cuenta) VALUES ($1, $2)
         ON CONFLICT (usuario_id) DO UPDATE SET cuenta = $2, cambiado_en = now()`,
        [usuarioId, cuenta],
      )
      .catch(() => undefined);
  }

  async referenciasConocidas(usuarioId: string): Promise<string[]> {
    try {
      const r = await this.pool.query<{ nombre: string }>(
        `SELECT DISTINCT r.nombre
           FROM repos r
           JOIN miembros m ON m.proyecto_id = r.proyecto_id
          WHERE m.usuario_id = $1 AND r.solo_lectura
          ORDER BY r.nombre`,
        [usuarioId],
      );
      return r.rows.map((f) => f.nombre);
    } catch {
      // La columna es de la migracion 024: contra una base que no la corrio,
      // no hay referencias y eso no es un error.
      return [];
    }
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

  // --- Drive en vivo -------------------------------------------------------

  async googleCuenta(usuarioId: string) {
    const r = await this.pool.query<{ email: string; refresh_token: string }>(
      'SELECT email, refresh_token FROM google_cuentas WHERE usuario_id = $1',
      [usuarioId],
    );
    const fila = r.rows[0];
    return fila ? { email: fila.email, refreshToken: fila.refresh_token } : undefined;
  }

  async guardarGoogleCuenta(usuarioId: string, email: string, refreshToken: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO google_cuentas (usuario_id, email, refresh_token) VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id)
         DO UPDATE SET email = $2, refresh_token = $3, creado_en = now()`,
      [usuarioId, email, refreshToken],
    );
  }

  async borrarGoogleCuenta(usuarioId: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM google_cuentas WHERE usuario_id = $1', [
      usuarioId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async crearPedidoDeDrive(usuarioId: string, nombre: string, minutos: number): Promise<string> {
    const codigo = codigoDeUrl();
    await this.pool.query(
      `INSERT INTO google_pedidos (codigo, usuario_id, nombre, expira_en)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [codigo, usuarioId, nombre, String(minutos)],
    );
    return codigo;
  }

  async canjearPedidoDeDrive(codigo: string, archivoId: string) {
    // Marcar usado y leer de quien era en UNA sentencia, igual que
    // `canjearCodigo`: si fueran dos, dos canjes simultaneos del mismo link
    // pasarian los dos y autorizarian dos archivos con una sola autorizacion.
    const r = await this.pool.query<{ usuario_id: string; nombre: string }>(
      `UPDATE google_pedidos SET usado_en = now(), archivo_id = $2
        WHERE codigo = $1 AND usado_en IS NULL AND expira_en > now()
        RETURNING usuario_id, nombre`,
      [codigo, archivoId],
    );

    if (r.rowCount === 0) {
      const existe = await this.pool.query<{ usado_en: Date | null }>(
        'SELECT usado_en FROM google_pedidos WHERE codigo = $1',
        [codigo],
      );
      const fila = existe.rows[0];
      if (!fila) return { estado: 'desconocido' as const };
      return { estado: fila.usado_en ? ('usado' as const) : ('vencido' as const) };
    }

    return {
      estado: 'ok' as const,
      usuarioId: r.rows[0]!.usuario_id,
      nombre: r.rows[0]!.nombre,
    };
  }

  async archivoAutorizadoReciente(usuarioId: string, nombre: string, minutos: number) {
    // `ILIKE` en las dos direcciones: el agente puede buscar "Balance" habiendo
    // pedido "Balance 2026", o al reves. El `%` se escapa para que un nombre
    // con uno adentro no matchee de mas.
    const patron = nombre.replace(/[%_\\]/g, (c) => `\\${c}`);
    const r = await this.pool.query<{ archivo_id: string; nombre: string }>(
      `SELECT archivo_id, nombre FROM google_pedidos
        WHERE usuario_id = $1
          AND archivo_id IS NOT NULL
          AND usado_en > now() - ($3 || ' minutes')::interval
          AND (nombre ILIKE '%' || $2 || '%' OR $2 ILIKE '%' || nombre || '%')
        ORDER BY usado_en DESC
        LIMIT 1`,
      [usuarioId, patron, String(minutos)],
    );
    const fila = r.rows[0];
    return fila ? { id: fila.archivo_id, nombre: fila.nombre } : undefined;
  }
}
