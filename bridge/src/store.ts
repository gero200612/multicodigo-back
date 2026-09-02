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
export const MODOS_PERMISO = ['preguntar', 'ediciones', 'todo'] as const;
export type ModoPermiso = (typeof MODOS_PERMISO)[number];

/**
 * Las claves de modelo, espejadas de `MODELOS` en el agente
 * (`src/agent/src/modelos.ts`) y del CHECK de la migracion 019.
 *
 * Claves y no ids: el id del modelo vive del lado del agente, que es quien
 * habla con el SDK. Guardar un id aca dejaria filas apuntando a modelos
 * retirados que nadie sabria traducir.
 */
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
  reposDeProyecto(proyectoId: string): Promise<Array<{ nombre: string; github_repo: string }>>;

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
  finishJob(jobId: string, status: JobStatus, error?: string, respuesta?: string): Promise<void>;
  /**
   * Mueve un job entre estados transitorios. No reabre uno ya cerrado: un
   * estado que llega tarde —el poller vio una aprobacion justo cuando el turno
   * terminaba— no puede revivir un job en done.
   */
  setJobStatus(jobId: string, status: JobStatus): Promise<void>;
  getJobStatus(jobId: string): Promise<JobStatus | undefined>;
  getJobError(jobId: string): Promise<string | undefined>;
  /** Lo que contesto el agente, si el turno termino. */
  getJobRespuesta(jobId: string): Promise<string | undefined>;
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
  private jobs = new Map<
    string,
    { status: JobStatus; error?: string; respuesta?: string; resumen?: JobResumen }
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
  async finishJob(jobId: string, status: JobStatus, error?: string, respuesta?: string) {
    const previo = this.jobs.get(jobId);
    this.jobs.set(jobId, { ...previo, status, error, respuesta });
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

  /** Ni repos: los tests que los necesitan los inyectan por otro lado. */
  async reposDeProyecto(): Promise<Array<{ nombre: string; github_repo: string }>> {
    return [];
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

  async finishJob(jobId: string, status: JobStatus, error?: string, respuesta?: string) {
    // COALESCE en la respuesta: un finishJob de error no puede borrar lo que ya
    // habia contestado el agente antes de que algo fallara despues.
    await this.pool.query(
      `UPDATE jobs SET status = $2, error = $3, respuesta = COALESCE($4, respuesta),
              ended_at = now()
        WHERE id = $1`,
      [jobId, status, error ?? null, respuesta ?? null],
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

  async reposDeProyecto(
    proyectoId: string,
  ): Promise<Array<{ nombre: string; github_repo: string }>> {
    // La tabla es del plan 2 y se crea a mano en Supabase; si no esta, el turno
    // sigue y el gateway usa su catalogo local. Por eso el catch.
    try {
      const r = await this.pool.query<{ nombre: string; github_repo: string }>(
        'SELECT nombre, github_repo FROM repos WHERE proyecto_id = $1 ORDER BY nombre',
        [proyectoId],
      );
      return r.rows;
    } catch {
      return [];
    }
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
