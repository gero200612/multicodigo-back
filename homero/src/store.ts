import type { Contenido, Justificacion } from './patan.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export type TipoDeTarea =
  | 'resumir_respuesta'
  | 'enviar_mail'
  | 'prospectar'
  | 'investigar'
  | 'enviar_saliente'
  | 'recordatorio'
  | 'resumen_diario'
  | 'pliego_demo'
  | 'presupuestar'
  | 'agente_buscar'
  | 'agente_vender'
  | 'agente_atender';

export type EstadoDeLead =
  | 'nuevo'
  | 'descartado'
  | 'borrador'
  | 'aprobado'
  | 'contactado'
  | 'respondio'
  | 'reunion'
  | 'cerrado'
  | 'baja'
  | 'rebotado';

/** Lo que la IA saco de la web del negocio. */
export interface Investigacion {
  resumen_empresa: string;
  dolor: string;
  idea: string;
  factibilidad?: number;
  factibilidad_motivo?: string;
  /** Chats o bots que ya tiene su web (Tidio, Botmaker...). */
  chatbots?: string[];
  /** De donde salio la informacion: la ficha del lugar y las paginas leidas. */
  fuentes?: string[];
  /** Estimado de cuanta gente trabaja ahi (para Patán). */
  personas?: number;
  /** Quien usaria la app y cuantos (para Patán). */
  usuarios?: string;
  /** Por que lo eligio el agente buscador. */
  por_que?: string;
  /** Por que lo descarto el vendedor. */
  descarte?: string;
}

export interface Lead {
  id: number;
  nombre: string;
  rubro: string;
  ciudad: string;
  web?: string;
  email?: string;
  telefono?: string;
  fuente: string;
  investigacion?: Investigacion;
  estado: EstadoDeLead;
  casilla?: string;
  /** Id en la fuente: `osm:node/123` o `google:<place_id>`. */
  externo?: string;
}

export type NuevoLead = Omit<Lead, 'id' | 'estado' | 'investigacion' | 'casilla'>;

export type TipoDeSaliente = 'inicial' | 'seguimiento' | 'respuesta' | 'confirmacion' | 'recordatorio';
export type EstadoDeSaliente = 'borrador' | 'aprobado' | 'enviado' | 'cancelado';

export interface Saliente {
  id: number;
  leadId: number;
  tipo: TipoDeSaliente;
  paso: number;
  casilla?: string;
  asunto: string;
  cuerpo: string;
  enRespuestaA?: string;
  estado: EstadoDeSaliente;
  messageId?: string;
  telegramMsg?: number;
  reunionId?: number;
}

export type CambiosDeSaliente = Partial<
  Pick<Saliente, 'estado' | 'cuerpo' | 'asunto' | 'casilla' | 'messageId' | 'telegramMsg' | 'enRespuestaA'>
>;

export interface Reunion {
  id: number;
  leadId: number;
  inicio: Date;
  fin: Date;
  link: string;
}

export type EstadoDeDemo = 'redactando' | 'pliego' | 'enviada' | 'lista' | 'fallida';

/** Una demo que Punchi arma para una reunion. */
export interface Demo {
  id: number;
  reunionId: number;
  leadId: number;
  /** El nombre del proyecto en Punchi. */
  proyecto: string;
  pliego?: string;
  estado: EstadoDeDemo;
  corridaId?: string;
  url?: string;
  error?: string;
  telegramMsg?: number;
}

export type EstadoDePresupuesto = 'armando' | 'listo' | 'fallido';

/** El presupuesto de Patán para una demo. Uno por demo. */
export interface Presupuesto {
  id: number;
  demoId: number;
  leadId: number;
  notas: string;
  estado: EstadoDePresupuesto;
  contenido?: Contenido;
  justificacion?: Justificacion;
  error?: string;
  actualizado: Date;
}

export type CambiosDePresupuesto = Partial<Pick<Presupuesto, 'estado' | 'contenido' | 'justificacion' | 'error'>>;

export type CambiosDeDemo = Partial<Pick<Demo, 'pliego' | 'estado' | 'corridaId' | 'url' | 'error' | 'telegramMsg'>>;

export interface FiltroDeLeads {
  estado?: EstadoDeLead;
  rubro?: string;
  /** Busca en nombre, mail y web. */
  q?: string;
  limite: number;
  desde: number;
}

export type Agente = 'buscador' | 'vendedor' | 'atencion';

/** Un paso de una corrida: lo que penso o la herramienta que uso. */
export interface Paso {
  tipo: 'pensamiento' | 'herramienta';
  texto: string;
  herramienta?: string;
}

export interface Corrida {
  id: number;
  agente: Agente;
  objetivo: string;
  leadId?: number;
  estado: 'corriendo' | 'lista' | 'fallida';
  slot?: string;
  turnos?: number;
  pasos?: Paso[];
  informe?: string;
  /** Una linea de lo que hizo, armada por el codigo (ver `Registro.resumen`). */
  resumen?: string;
  error?: string;
  inicio: Date;
  fin?: Date;
}

export interface CierreDeCorrida {
  estado: 'lista' | 'fallida';
  slot?: string;
  turnos?: number;
  pasos?: Paso[];
  informe?: string;
  resumen?: string;
  error?: string;
}

/** Un mail inicial que tuvo respuesta: lo que el vendedor mira para aprender. */
export interface MailQueFunciono {
  rubro: string;
  asunto: string;
  cuerpo: string;
  resultado: 'respondio' | 'reunion' | 'cerrado';
}

export interface Rendimiento {
  rubro: string;
  contactados: number;
  respuestas: number;
  reuniones: number;
}

export interface Tarea {
  id: number;
  tipo: TipoDeTarea;
  payload: unknown;
  requiereIa: boolean;
  intentos: number;
}

export interface NuevaTarea {
  tipo: TipoDeTarea;
  payload: unknown;
  requiereIa: boolean;
  /** Si ya existe una tarea con esta clave, no se encola de nuevo. */
  clave?: string;
  disponibleDesde?: Date;
}

export interface Recibido {
  cuenta: string;
  messageId: string;
  de: string;
  asunto: string;
  cuerpo: string;
  recibidoEn: Date;
  /** Message-ID al que contesta: encuentra al lead aunque responda otra persona. */
  enRespuestaA?: string;
}

export interface Store {
  leerEstado<T>(clave: string): Promise<T | undefined>;
  /** `null` borra la clave. */
  guardarEstado(clave: string, valor: unknown): Promise<void>;

  /** `false` si la clave ya estaba encolada. */
  encolar(t: NuevaTarea): Promise<boolean>;
  /**
   * La proxima tarea lista para correr, marcada `corriendo`. Con la IA en
   * pausa solo devuelve las que no la necesitan: mandar un mail ya escrito no
   * tiene por que esperar a Claude.
   */
  tomarSiguiente(ahora: Date, iaDisponible: boolean): Promise<Tarea | undefined>;
  terminar(id: number): Promise<void>;
  reprogramar(id: number, cuando: Date, o: { contarIntento: boolean; error?: string }): Promise<void>;
  fallar(id: number, error: string): Promise<void>;
  /** Las que quedaron `corriendo` por un reinicio vuelven a la cola. */
  rescatarColgadas(): Promise<number>;
  contarTareas(): Promise<{ pendientes: number; fallidas: number }>;
  /** Lo que hay en la cola por tipo: cuantas, cuando arranca la proxima y el ultimo error. */
  colaPorTipo(): Promise<{ tipo: TipoDeTarea; pendientes: number; proxima?: Date; ultimoError?: string }[]>;
  /** Las de esos tipos que todavia no terminaron (pendientes o corriendo). */
  tareasEnCurso(tipos: TipoDeTarea[]): Promise<number>;
  /** Cancela las pendientes de esos tipos (las da por fallidas). Devuelve cuantas. */
  cancelarTareas(tipos: TipoDeTarea[]): Promise<number>;

  registrarCuenta(email: string): Promise<void>;
  primerEnvio(email: string): Promise<Date | undefined>;
  enviosDesde(email: string, desde: Date): Promise<number>;
  registrarEnvio(e: { cuenta: string; para: string; asunto: string; messageId?: string }): Promise<void>;

  /** `false` si ya estaba guardado. */
  guardarRecibido(r: Recibido): Promise<boolean>;
  esBaja(email: string): Promise<boolean>;
  agregarBaja(email: string, motivo: string): Promise<void>;

  /** `undefined` si ya existia (mismo lugar o mismo mail). */
  crearLead(l: NuevoLead): Promise<number | undefined>;
  lead(id: number): Promise<Lead | undefined>;
  leadsEnBorrador(): Promise<number[]>;
  leadPorEmail(email: string): Promise<Lead | undefined>;
  /** Si algun lead anterior tiene una web en ese dominio (`megatlon.com`). */
  hayLeadConDominio(dominio: string): Promise<boolean>;
  actualizarLead(
    id: number,
    c: Partial<Pick<Lead, 'estado' | 'investigacion' | 'casilla' | 'email'>>,
  ): Promise<void>;

  crearSaliente(s: Omit<Saliente, 'id' | 'estado' | 'messageId' | 'telegramMsg'> & { estado?: EstadoDeSaliente }): Promise<number>;
  saliente(id: number): Promise<Saliente | undefined>;
  salientesDeLead(leadId: number): Promise<Saliente[]>;
  salientePorTelegram(msg: number): Promise<Saliente | undefined>;
  salientePorMessageId(messageId: string): Promise<Saliente | undefined>;
  actualizarSaliente(id: number, c: CambiosDeSaliente): Promise<void>;
  marcarEnviado(id: number, messageId?: string): Promise<void>;
  /** Cancela los seguimientos que no salieron todavia. */
  cancelarSeguimientos(leadId: number): Promise<number>;

  guardarOferta(leadId: number, horarios: Date[]): Promise<void>;
  oferta(leadId: number): Promise<Date[] | undefined>;
  /** `undefined` si el horario ya lo tomo otra reunion. */
  crearReunion(r: Omit<Reunion, 'id'>): Promise<number | undefined>;
  reunion(id: number): Promise<Reunion | undefined>;
  cancelarReunion(id: number): Promise<void>;
  reunionesDesde(desde: Date): Promise<Reunion[]>;
  diasOcupados(): Promise<string[]>;
  marcarOcupado(dia: string, ocupado: boolean): Promise<void>;

  registrarBusqueda(b: { rubro: string; ciudad: string; fuente: string; hallados: number }): Promise<void>;
  rendimientoPorRubro(): Promise<Rendimiento[]>;
  /** Mails iniciales esperando aprobacion o esperando salir. */
  pipeline(): Promise<{ borradores: number; aprobados: number }>;
  registrarRebote(cuenta: string, email?: string): Promise<void>;
  rebotesDesde(cuenta: string, desde: Date): Promise<number>;
  metricasDesde(desde: Date): Promise<{ enviados: number; respuestas: number; reuniones: number; leads: number }>;

  // ---- Lo que usa la web
  /** Los borradores de esos tipos, del mas viejo al mas nuevo. */
  salientesEnBorrador(tipos: TipoDeSaliente[]): Promise<Saliente[]>;
  listarLeads(f: FiltroDeLeads): Promise<{ total: number; leads: (Lead & { creado: Date })[] }>;

  // ---- Demos
  /** `undefined` si esa reunion ya tiene demo. */
  crearDemo(d: { reunionId: number; leadId: number; proyecto: string }): Promise<number | undefined>;
  demo(id: number): Promise<Demo | undefined>;
  demoDeReunion(reunionId: number): Promise<Demo | undefined>;
  demoPorTelegram(msg: number): Promise<Demo | undefined>;
  actualizarDemo(id: number, c: CambiosDeDemo): Promise<void>;
  /** Las que Punchi esta construyendo: a estas se les pregunta el estado. */
  demosEnviadas(): Promise<Demo[]>;
  /** Las demos que ya se mandaron a Punchi (enviada o lista), las mas nuevas primero. */
  demosPresupuestables(): Promise<Demo[]>;

  // ---- Agentes
  crearCorrida(c: { agente: Agente; objetivo: string; leadId?: number }): Promise<number>;
  cerrarCorrida(id: number, c: CierreDeCorrida): Promise<void>;
  /** Para la que nunca llego a correr (sin cuenta libre). */
  borrarCorrida(id: number): Promise<void>;
  corrida(id: number): Promise<Corrida | undefined>;
  /** Las ultimas corridas, las mas nuevas primero. Sin `agente`, de todos. */
  corridas(f: { agente?: Agente; limite: number }): Promise<Corrida[]>;
  libreta(agente: Agente): Promise<string>;
  guardarLibreta(agente: Agente, contenido: string): Promise<void>;
  /** Las ultimas busquedas, para que el buscador no repita lo que no rindio. */
  busquedasRecientes(limite: number): Promise<{ rubro: string; ciudad: string; fuente: string; hallados: number; hecha: Date }[]>;
  /** Mails iniciales que tuvieron respuesta, los mas nuevos primero. */
  mailsQueFuncionaron(limite: number): Promise<MailQueFunciono[]>;

  presupuesto(id: number): Promise<Presupuesto | undefined>;
  presupuestoDeDemo(demoId: number): Promise<Presupuesto | undefined>;
  /** Crea el presupuesto o, si ya habia, lo vuelve a `armando` con las notas nuevas. */
  guardarPedidoDePresupuesto(p: { demoId: number; leadId: number; notas: string }): Promise<number>;
  actualizarPresupuesto(id: number, c: CambiosDePresupuesto): Promise<void>;
}

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  static async conectar(url: string, migraciones: string[]): Promise<PgStore> {
    // 5 para que /estado corra sus consultas en paralelo. Y las conexiones
    // viven un minuto ociosas: el panel pregunta cada 20 s, y con el default
    // de 10 s cada vuelta negociaba TLS de nuevo con la base.
    const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 60_000 });
    // Cada archivo es idempotente, igual que en el bridge.
    for (const path of migraciones) await pool.query(await readFile(path, 'utf8'));
    return new PgStore(pool);
  }

  async cerrar() {
    await this.pool.end();
  }

  async leerEstado<T>(clave: string) {
    const r = await this.pool.query('SELECT valor FROM homero.estado WHERE clave = $1', [clave]);
    return r.rows[0]?.valor as T | undefined;
  }

  async guardarEstado(clave: string, valor: unknown) {
    if (valor === null) {
      await this.pool.query('DELETE FROM homero.estado WHERE clave = $1', [clave]);
      return;
    }
    await this.pool.query(
      `INSERT INTO homero.estado (clave, valor) VALUES ($1, $2)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now()`,
      [clave, JSON.stringify(valor)],
    );
  }

  async encolar(t: NuevaTarea) {
    const r = await this.pool.query(
      `INSERT INTO homero.tareas (tipo, payload, requiere_ia, clave, disponible_desde)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()))
       ON CONFLICT (clave) DO NOTHING`,
      [t.tipo, JSON.stringify(t.payload), t.requiereIa, t.clave ?? null, t.disponibleDesde ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async tomarSiguiente(ahora: Date, iaDisponible: boolean) {
    // SKIP LOCKED por si algun dia corren dos procesos; hoy es uno solo.
    const r = await this.pool.query(
      `UPDATE homero.tareas SET estado = 'corriendo', actualizada = now()
       WHERE id = (
         SELECT id FROM homero.tareas
         WHERE estado = 'pendiente' AND disponible_desde <= $1 AND ($2 OR NOT requiere_ia)
         ORDER BY disponible_desde, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tipo, payload, requiere_ia, intentos`,
      [ahora, iaDisponible],
    );
    const f = r.rows[0];
    if (!f) return undefined;
    return {
      id: Number(f.id),
      tipo: f.tipo,
      payload: f.payload,
      requiereIa: f.requiere_ia,
      intentos: f.intentos,
    };
  }

  async terminar(id: number) {
    await this.pool.query(
      `UPDATE homero.tareas SET estado = 'lista', actualizada = now() WHERE id = $1`,
      [id],
    );
  }

  async reprogramar(id: number, cuando: Date, o: { contarIntento: boolean; error?: string }) {
    await this.pool.query(
      `UPDATE homero.tareas
       SET estado = 'pendiente', disponible_desde = $2,
           intentos = intentos + $3, ultimo_error = COALESCE($4, ultimo_error), actualizada = now()
       WHERE id = $1`,
      [id, cuando, o.contarIntento ? 1 : 0, o.error ?? null],
    );
  }

  async fallar(id: number, error: string) {
    await this.pool.query(
      `UPDATE homero.tareas
       SET estado = 'fallida', intentos = intentos + 1, ultimo_error = $2, actualizada = now()
       WHERE id = $1`,
      [id, error],
    );
  }

  async rescatarColgadas() {
    const r = await this.pool.query(
      `UPDATE homero.tareas SET estado = 'pendiente', actualizada = now() WHERE estado = 'corriendo'`,
    );
    return r.rowCount ?? 0;
  }

  async colaPorTipo() {
    const r = await this.pool.query(
      `SELECT tipo, count(*)::int AS n, min(disponible_desde) AS proxima,
              (array_agg(ultimo_error ORDER BY actualizada DESC) FILTER (WHERE ultimo_error IS NOT NULL))[1] AS error
       FROM homero.tareas WHERE estado = 'pendiente' GROUP BY tipo`,
    );
    return r.rows.map((f) => ({
      tipo: f.tipo as TipoDeTarea,
      pendientes: Number(f.n),
      proxima: f.proxima ? new Date(f.proxima) : undefined,
      ultimoError: (f.error as string | null) ?? undefined,
    }));
  }

  async tareasEnCurso(tipos: TipoDeTarea[]) {
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM homero.tareas WHERE estado IN ('pendiente', 'corriendo') AND tipo = ANY($1)`,
      [tipos],
    );
    return r.rows[0].n as number;
  }

  async cancelarTareas(tipos: TipoDeTarea[]) {
    const r = await this.pool.query(
      `UPDATE homero.tareas SET estado = 'fallida', ultimo_error = 'cortada por Gero', actualizada = now()
       WHERE estado = 'pendiente' AND tipo = ANY($1)`,
      [tipos],
    );
    return r.rowCount ?? 0;
  }

  async contarTareas() {
    const r = await this.pool.query(
      `SELECT count(*) FILTER (WHERE estado = 'pendiente') AS p,
              count(*) FILTER (WHERE estado = 'fallida') AS f
       FROM homero.tareas`,
    );
    return { pendientes: Number(r.rows[0].p), fallidas: Number(r.rows[0].f) };
  }

  async registrarCuenta(email: string) {
    await this.pool.query(
      'INSERT INTO homero.cuentas (email) VALUES ($1) ON CONFLICT DO NOTHING',
      [email],
    );
  }

  async primerEnvio(email: string) {
    const r = await this.pool.query('SELECT primer_envio FROM homero.cuentas WHERE email = $1', [
      email,
    ]);
    return (r.rows[0]?.primer_envio as Date | null) ?? undefined;
  }

  async enviosDesde(email: string, desde: Date) {
    const r = await this.pool.query(
      'SELECT count(*) AS n FROM homero.envios WHERE cuenta = $1 AND enviado_en >= $2',
      [email, desde],
    );
    return Number(r.rows[0].n);
  }

  async registrarEnvio(e: { cuenta: string; para: string; asunto: string; messageId?: string }) {
    await this.pool.query(
      'INSERT INTO homero.envios (cuenta, para, asunto, message_id) VALUES ($1, $2, $3, $4)',
      [e.cuenta, e.para, e.asunto, e.messageId ?? null],
    );
    await this.pool.query(
      'UPDATE homero.cuentas SET primer_envio = now() WHERE email = $1 AND primer_envio IS NULL',
      [e.cuenta],
    );
  }

  async guardarRecibido(r: Recibido) {
    const q = await this.pool.query(
      `INSERT INTO homero.recibidos (cuenta, message_id, de, asunto, cuerpo, recibido_en)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [r.cuenta, r.messageId, r.de, r.asunto, r.cuerpo, r.recibidoEn],
    );
    return (q.rowCount ?? 0) > 0;
  }

  async esBaja(email: string) {
    const r = await this.pool.query('SELECT 1 FROM homero.bajas WHERE email = $1', [
      email.toLowerCase(),
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async agregarBaja(email: string, motivo: string) {
    await this.pool.query(
      'INSERT INTO homero.bajas (email, motivo) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [email.toLowerCase(), motivo],
    );
  }

  // ---- Ventas: leads, salientes, agenda, metricas ----

  async crearLead(l: NuevoLead) {
    const r = await this.pool.query(
      `INSERT INTO homero.leads (nombre, rubro, ciudad, web, email, telefono, fuente, externo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        l.nombre,
        l.rubro,
        l.ciudad,
        l.web ?? null,
        l.email?.toLowerCase() ?? null,
        l.telefono ?? null,
        l.fuente,
        l.externo ?? null,
      ],
    );
    return r.rows[0] ? Number(r.rows[0].id) : undefined;
  }

  async lead(id: number) {
    const r = await this.pool.query('SELECT * FROM homero.leads WHERE id = $1', [id]);
    return r.rows[0] ? aLead(r.rows[0]) : undefined;
  }

  async leadsEnBorrador() {
    const r = await this.pool.query(`SELECT id FROM homero.leads WHERE estado = 'borrador' ORDER BY id`);
    return r.rows.map((f) => Number(f.id));
  }

  async hayLeadConDominio(dominio: string) {
    // La web se guarda como vino de la fuente (con o sin https, con o sin www,
    // con o sin ruta): se compara el host con una regex anclada.
    const escapado = dominio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const r = await this.pool.query(`SELECT 1 FROM homero.leads WHERE web ~* $1 LIMIT 1`, [
      `^(https?://)?(www[0-9]*\\.)?${escapado}([/:?#]|$)`,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async leadPorEmail(email: string) {
    const r = await this.pool.query('SELECT * FROM homero.leads WHERE email = $1', [email.toLowerCase()]);
    return r.rows[0] ? aLead(r.rows[0]) : undefined;
  }

  async actualizarLead(id: number, c: Partial<Pick<Lead, 'estado' | 'investigacion' | 'casilla' | 'email'>>) {
    await this.pool.query(
      `UPDATE homero.leads SET
         estado = COALESCE($2, estado),
         investigacion = COALESCE($3, investigacion),
         casilla = COALESCE($4, casilla),
         email = COALESCE($5, email),
         actualizado = now()
       WHERE id = $1`,
      [
        id,
        c.estado ?? null,
        c.investigacion ? JSON.stringify(c.investigacion) : null,
        c.casilla ?? null,
        c.email?.toLowerCase() ?? null,
      ],
    );
  }

  async crearSaliente(
    s: Omit<Saliente, 'id' | 'estado' | 'messageId' | 'telegramMsg'> & { estado?: EstadoDeSaliente },
  ) {
    const r = await this.pool.query(
      `INSERT INTO homero.salientes (lead_id, tipo, paso, casilla, asunto, cuerpo, en_respuesta_a, estado, reunion_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        s.leadId,
        s.tipo,
        s.paso,
        s.casilla ?? null,
        s.asunto,
        s.cuerpo,
        s.enRespuestaA ?? null,
        s.estado ?? 'borrador',
        s.reunionId ?? null,
      ],
    );
    return Number(r.rows[0].id);
  }

  async saliente(id: number) {
    const r = await this.pool.query('SELECT * FROM homero.salientes WHERE id = $1', [id]);
    return r.rows[0] ? aSaliente(r.rows[0]) : undefined;
  }

  async salientesDeLead(leadId: number) {
    const r = await this.pool.query('SELECT * FROM homero.salientes WHERE lead_id = $1 ORDER BY paso, id', [
      leadId,
    ]);
    return r.rows.map(aSaliente);
  }

  async salientePorTelegram(msg: number) {
    const r = await this.pool.query(
      'SELECT * FROM homero.salientes WHERE telegram_msg = $1 ORDER BY id LIMIT 1',
      [msg],
    );
    return r.rows[0] ? aSaliente(r.rows[0]) : undefined;
  }

  async salientePorMessageId(messageId: string) {
    const r = await this.pool.query('SELECT * FROM homero.salientes WHERE message_id = $1 LIMIT 1', [messageId]);
    return r.rows[0] ? aSaliente(r.rows[0]) : undefined;
  }

  async actualizarSaliente(id: number, c: CambiosDeSaliente) {
    await this.pool.query(
      `UPDATE homero.salientes SET
         estado = COALESCE($2, estado), cuerpo = COALESCE($3, cuerpo), asunto = COALESCE($4, asunto),
         casilla = COALESCE($5, casilla), message_id = COALESCE($6, message_id),
         telegram_msg = COALESCE($7, telegram_msg), en_respuesta_a = COALESCE($8, en_respuesta_a)
       WHERE id = $1`,
      [
        id,
        c.estado ?? null,
        c.cuerpo ?? null,
        c.asunto ?? null,
        c.casilla ?? null,
        c.messageId ?? null,
        c.telegramMsg ?? null,
        c.enRespuestaA ?? null,
      ],
    );
  }

  async marcarEnviado(id: number, messageId?: string) {
    await this.pool.query(
      `UPDATE homero.salientes SET estado = 'enviado', message_id = $2, enviado_en = now() WHERE id = $1`,
      [id, messageId ?? null],
    );
  }

  async cancelarSeguimientos(leadId: number) {
    const r = await this.pool.query(
      `UPDATE homero.salientes SET estado = 'cancelado'
       WHERE lead_id = $1 AND tipo = 'seguimiento' AND estado IN ('borrador', 'aprobado')`,
      [leadId],
    );
    return r.rowCount ?? 0;
  }

  async guardarOferta(leadId: number, horarios: Date[]) {
    await this.pool.query(
      `INSERT INTO homero.ofertas (lead_id, horarios) VALUES ($1, $2)
       ON CONFLICT (lead_id) DO UPDATE SET horarios = EXCLUDED.horarios, creada = now()`,
      [leadId, JSON.stringify(horarios.map((h) => h.toISOString()))],
    );
  }

  async oferta(leadId: number) {
    const r = await this.pool.query('SELECT horarios FROM homero.ofertas WHERE lead_id = $1', [leadId]);
    const h = r.rows[0]?.horarios as string[] | undefined;
    return h?.map((x) => new Date(x));
  }

  async crearReunion(r: Omit<Reunion, 'id'>) {
    try {
      const q = await this.pool.query(
        'INSERT INTO homero.reuniones (lead_id, inicio, fin, link) VALUES ($1, $2, $3, $4) RETURNING id',
        [r.leadId, r.inicio, r.fin, r.link],
      );
      return Number(q.rows[0].id);
    } catch (err) {
      // El indice unico de reuniones confirmadas: otro ya tomo ese horario.
      if ((err as { code?: string }).code === '23505') return undefined;
      throw err;
    }
  }

  async reunion(id: number) {
    const r = await this.pool.query(
      `SELECT * FROM homero.reuniones WHERE id = $1 AND estado = 'confirmada'`,
      [id],
    );
    return r.rows[0] ? aReunion(r.rows[0]) : undefined;
  }

  async cancelarReunion(id: number) {
    await this.pool.query(`UPDATE homero.reuniones SET estado = 'cancelada' WHERE id = $1`, [id]);
  }

  async reunionesDesde(desde: Date) {
    const r = await this.pool.query(
      `SELECT * FROM homero.reuniones WHERE estado = 'confirmada' AND inicio >= $1 ORDER BY inicio`,
      [desde],
    );
    return r.rows.map(aReunion);
  }

  async diasOcupados() {
    const r = await this.pool.query(`SELECT to_char(dia, 'YYYY-MM-DD') AS d FROM homero.ocupados`);
    return r.rows.map((f) => f.d as string);
  }

  async marcarOcupado(dia: string, ocupado: boolean) {
    await this.pool.query(
      ocupado
        ? 'INSERT INTO homero.ocupados (dia) VALUES ($1) ON CONFLICT DO NOTHING'
        : 'DELETE FROM homero.ocupados WHERE dia = $1',
      [dia],
    );
  }

  async registrarBusqueda(b: { rubro: string; ciudad: string; fuente: string; hallados: number }) {
    await this.pool.query(
      'INSERT INTO homero.busquedas (rubro, ciudad, fuente, hallados) VALUES ($1, $2, $3, $4)',
      [b.rubro, b.ciudad, b.fuente, b.hallados],
    );
  }

  async rendimientoPorRubro() {
    const r = await this.pool.query(
      `SELECT rubro,
              count(*) FILTER (WHERE estado IN ('contactado', 'respondio', 'reunion', 'cerrado', 'baja')) AS c,
              count(*) FILTER (WHERE estado IN ('respondio', 'reunion', 'cerrado')) AS r,
              count(*) FILTER (WHERE estado = 'reunion') AS m
       FROM homero.leads GROUP BY rubro`,
    );
    return r.rows.map((f) => ({
      rubro: f.rubro as string,
      contactados: Number(f.c),
      respuestas: Number(f.r),
      reuniones: Number(f.m),
    }));
  }

  async pipeline() {
    const r = await this.pool.query(
      `SELECT count(*) FILTER (WHERE estado = 'borrador') AS b,
              count(*) FILTER (WHERE estado = 'aprobado') AS a
       FROM homero.salientes WHERE tipo = 'inicial'`,
    );
    return { borradores: Number(r.rows[0].b), aprobados: Number(r.rows[0].a) };
  }

  async registrarRebote(cuenta: string, email?: string) {
    await this.pool.query('INSERT INTO homero.rebotes (cuenta, email) VALUES ($1, $2)', [
      cuenta,
      email ?? null,
    ]);
  }

  async rebotesDesde(cuenta: string, desde: Date) {
    const r = await this.pool.query(
      'SELECT count(*) AS n FROM homero.rebotes WHERE cuenta = $1 AND llegado >= $2',
      [cuenta, desde],
    );
    return Number(r.rows[0].n);
  }

  async metricasDesde(desde: Date) {
    const r = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM homero.envios WHERE enviado_en >= $1) AS enviados,
         (SELECT count(*) FROM homero.recibidos WHERE guardado >= $1) AS respuestas,
         (SELECT count(*) FROM homero.reuniones WHERE creada >= $1 AND estado = 'confirmada') AS reuniones,
         (SELECT count(*) FROM homero.leads WHERE creado >= $1) AS leads`,
      [desde],
    );
    const f = r.rows[0];
    return {
      enviados: Number(f.enviados),
      respuestas: Number(f.respuestas),
      reuniones: Number(f.reuniones),
      leads: Number(f.leads),
    };
  }

  async salientesEnBorrador(tipos: TipoDeSaliente[]) {
    const r = await this.pool.query(
      `SELECT * FROM homero.salientes WHERE estado = 'borrador' AND tipo = ANY($1) ORDER BY id`,
      [tipos],
    );
    return r.rows.map(aSaliente);
  }

  async listarLeads(f: FiltroDeLeads) {
    const params: unknown[] = [];
    const cond: string[] = [];
    if (f.estado) cond.push(`estado = $${params.push(f.estado)}`);
    if (f.rubro) cond.push(`rubro = $${params.push(f.rubro)}`);
    if (f.q) {
      const i = params.push(`%${f.q}%`);
      cond.push(`(nombre ILIKE $${i} OR email ILIKE $${i} OR web ILIKE $${i})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const total = await this.pool.query(`SELECT count(*) AS n FROM homero.leads ${where}`, params);
    const r = await this.pool.query(
      `SELECT * FROM homero.leads ${where} ORDER BY actualizado DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limite, f.desde],
    );
    return {
      total: Number(total.rows[0].n),
      leads: r.rows.map((x) => ({ ...aLead(x), creado: x.creado as Date })),
    };
  }

  async crearDemo(d: { reunionId: number; leadId: number; proyecto: string }) {
    const r = await this.pool.query(
      `INSERT INTO homero.demos (reunion_id, lead_id, proyecto) VALUES ($1, $2, $3)
       ON CONFLICT (reunion_id) DO NOTHING RETURNING id`,
      [d.reunionId, d.leadId, d.proyecto],
    );
    return r.rows[0] ? Number(r.rows[0].id) : undefined;
  }

  async demo(id: number) {
    const r = await this.pool.query('SELECT * FROM homero.demos WHERE id = $1', [id]);
    return r.rows[0] ? aDemo(r.rows[0]) : undefined;
  }

  async demoDeReunion(reunionId: number) {
    const r = await this.pool.query('SELECT * FROM homero.demos WHERE reunion_id = $1', [reunionId]);
    return r.rows[0] ? aDemo(r.rows[0]) : undefined;
  }

  async demoPorTelegram(msg: number) {
    const r = await this.pool.query('SELECT * FROM homero.demos WHERE telegram_msg = $1 LIMIT 1', [msg]);
    return r.rows[0] ? aDemo(r.rows[0]) : undefined;
  }

  async actualizarDemo(id: number, c: CambiosDeDemo) {
    await this.pool.query(
      `UPDATE homero.demos SET
         pliego = COALESCE($2, pliego), estado = COALESCE($3, estado),
         corrida_id = COALESCE($4, corrida_id), url = COALESCE($5, url),
         error = CASE WHEN $6::text = '' THEN NULL ELSE COALESCE($6, error) END,
         telegram_msg = COALESCE($7, telegram_msg), actualizada = now()
       WHERE id = $1`,
      [
        id,
        c.pliego ?? null,
        c.estado ?? null,
        c.corridaId ?? null,
        c.url ?? null,
        c.error ?? null,
        c.telegramMsg ?? null,
      ],
    );
  }

  async demosEnviadas() {
    const r = await this.pool.query(`SELECT * FROM homero.demos WHERE estado = 'enviada' ORDER BY id`);
    return r.rows.map(aDemo);
  }

  async demosPresupuestables() {
    const r = await this.pool.query(
      `SELECT * FROM homero.demos WHERE estado IN ('enviada', 'lista') ORDER BY id DESC LIMIT 100`,
    );
    return r.rows.map(aDemo);
  }

  // ---- Agentes ----

  async crearCorrida(c: { agente: Agente; objetivo: string; leadId?: number }) {
    const r = await this.pool.query(
      'INSERT INTO homero.corridas (agente, objetivo, lead_id) VALUES ($1, $2, $3) RETURNING id',
      [c.agente, c.objetivo, c.leadId ?? null],
    );
    return Number(r.rows[0].id);
  }

  async cerrarCorrida(id: number, c: CierreDeCorrida) {
    await this.pool.query(
      `UPDATE homero.corridas SET estado = $2, slot = $3, turnos = $4, pasos = $5, informe = $6,
         error = $7, resumen = $8, fin = now() WHERE id = $1`,
      [
        id,
        c.estado,
        c.slot ?? null,
        c.turnos ?? null,
        c.pasos ? JSON.stringify(c.pasos) : null,
        c.informe ?? null,
        c.error ?? null,
        c.resumen ?? null,
      ],
    );
  }

  async borrarCorrida(id: number) {
    await this.pool.query('DELETE FROM homero.corridas WHERE id = $1', [id]);
  }

  async corrida(id: number) {
    const r = await this.pool.query('SELECT * FROM homero.corridas WHERE id = $1', [id]);
    return r.rows[0] ? aCorrida(r.rows[0]) : undefined;
  }

  async corridas(f: { agente?: Agente; limite: number }) {
    const r = await this.pool.query(
      `SELECT * FROM homero.corridas WHERE ($1::text IS NULL OR agente = $1) ORDER BY id DESC LIMIT $2`,
      [f.agente ?? null, f.limite],
    );
    return r.rows.map(aCorrida);
  }

  async libreta(agente: Agente) {
    const r = await this.pool.query('SELECT contenido FROM homero.libretas WHERE agente = $1', [agente]);
    return (r.rows[0]?.contenido as string | undefined) ?? '';
  }

  async guardarLibreta(agente: Agente, contenido: string) {
    await this.pool.query(
      `INSERT INTO homero.libretas (agente, contenido) VALUES ($1, $2)
       ON CONFLICT (agente) DO UPDATE SET contenido = EXCLUDED.contenido, actualizada = now()`,
      [agente, contenido],
    );
  }

  async busquedasRecientes(limite: number) {
    const r = await this.pool.query(
      'SELECT rubro, ciudad, fuente, hallados, hecha FROM homero.busquedas ORDER BY id DESC LIMIT $1',
      [limite],
    );
    return r.rows.map((f) => ({
      rubro: f.rubro as string,
      ciudad: f.ciudad as string,
      fuente: f.fuente as string,
      hallados: Number(f.hallados),
      hecha: new Date(f.hecha),
    }));
  }

  async mailsQueFuncionaron(limite: number) {
    const r = await this.pool.query(
      `SELECT l.rubro, s.asunto, s.cuerpo, l.estado
       FROM homero.salientes s JOIN homero.leads l ON l.id = s.lead_id
       WHERE s.tipo = 'inicial' AND s.estado = 'enviado' AND l.estado IN ('respondio', 'reunion', 'cerrado')
       ORDER BY s.enviado_en DESC LIMIT $1`,
      [limite],
    );
    return r.rows.map((f) => ({
      rubro: f.rubro as string,
      asunto: f.asunto as string,
      cuerpo: f.cuerpo as string,
      resultado: f.estado as MailQueFunciono['resultado'],
    }));
  }

  async presupuesto(id: number) {
    const r = await this.pool.query('SELECT * FROM homero.presupuestos WHERE id = $1', [id]);
    return r.rows[0] ? aPresupuesto(r.rows[0]) : undefined;
  }

  async presupuestoDeDemo(demoId: number) {
    const r = await this.pool.query('SELECT * FROM homero.presupuestos WHERE demo_id = $1', [demoId]);
    return r.rows[0] ? aPresupuesto(r.rows[0]) : undefined;
  }

  async guardarPedidoDePresupuesto(p: { demoId: number; leadId: number; notas: string }) {
    const r = await this.pool.query(
      `INSERT INTO homero.presupuestos (demo_id, lead_id, notas) VALUES ($1, $2, $3)
       ON CONFLICT (demo_id) DO UPDATE
         SET notas = EXCLUDED.notas, estado = 'armando', error = NULL, actualizado = now()
       RETURNING id`,
      [p.demoId, p.leadId, p.notas],
    );
    return Number(r.rows[0].id);
  }

  async actualizarPresupuesto(id: number, c: CambiosDePresupuesto) {
    await this.pool.query(
      `UPDATE homero.presupuestos SET
         estado = COALESCE($2, estado),
         contenido = COALESCE($3::jsonb, contenido),
         justificacion = COALESCE($4::jsonb, justificacion),
         error = CASE WHEN $5::text = '' THEN NULL ELSE COALESCE($5, error) END,
         actualizado = now()
       WHERE id = $1`,
      [
        id,
        c.estado ?? null,
        c.contenido ? JSON.stringify(c.contenido) : null,
        c.justificacion ? JSON.stringify(c.justificacion) : null,
        c.error ?? null,
      ],
    );
  }
}

type Fila = Record<string, unknown>;
const opc = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

function aLead(f: Fila): Lead {
  return {
    id: Number(f.id),
    nombre: f.nombre as string,
    rubro: f.rubro as string,
    ciudad: f.ciudad as string,
    web: opc(f.web),
    email: opc(f.email),
    telefono: opc(f.telefono),
    fuente: f.fuente as string,
    investigacion: opc(f.investigacion),
    estado: f.estado as EstadoDeLead,
    casilla: opc(f.casilla),
    externo: opc(f.externo),
  };
}

function aSaliente(f: Fila): Saliente {
  return {
    id: Number(f.id),
    leadId: Number(f.lead_id),
    tipo: f.tipo as TipoDeSaliente,
    paso: Number(f.paso),
    casilla: opc(f.casilla),
    asunto: f.asunto as string,
    cuerpo: f.cuerpo as string,
    enRespuestaA: opc(f.en_respuesta_a),
    estado: f.estado as EstadoDeSaliente,
    messageId: opc(f.message_id),
    telegramMsg: num(f.telegram_msg),
    reunionId: num(f.reunion_id),
  };
}

function aReunion(f: Fila): Reunion {
  return {
    id: Number(f.id),
    leadId: Number(f.lead_id),
    inicio: f.inicio as Date,
    fin: f.fin as Date,
    link: f.link as string,
  };
}

function aPresupuesto(f: Fila): Presupuesto {
  return {
    id: Number(f.id),
    demoId: Number(f.demo_id),
    leadId: Number(f.lead_id),
    notas: (f.notas as string) ?? '',
    estado: f.estado as EstadoDePresupuesto,
    contenido: opc(f.contenido),
    justificacion: opc(f.justificacion),
    error: opc(f.error),
    actualizado: f.actualizado as Date,
  };
}

function aDemo(f: Fila): Demo {
  return {
    id: Number(f.id),
    reunionId: Number(f.reunion_id),
    leadId: Number(f.lead_id),
    proyecto: f.proyecto as string,
    pliego: opc(f.pliego),
    estado: f.estado as EstadoDeDemo,
    corridaId: opc(f.corrida_id),
    url: opc(f.url),
    error: opc(f.error),
    telegramMsg: num(f.telegram_msg),
  };
}

function aCorrida(f: Record<string, unknown>): Corrida {
  return {
    id: Number(f.id),
    agente: f.agente as Agente,
    objetivo: f.objetivo as string,
    leadId: f.lead_id == null ? undefined : Number(f.lead_id),
    estado: f.estado as Corrida['estado'],
    slot: (f.slot as string | null) ?? undefined,
    turnos: f.turnos == null ? undefined : Number(f.turnos),
    pasos: (f.pasos as Paso[] | null) ?? undefined,
    informe: (f.informe as string | null) ?? undefined,
    resumen: (f.resumen as string | null) ?? undefined,
    error: (f.error as string | null) ?? undefined,
    inicio: new Date(f.inicio as string),
    fin: f.fin ? new Date(f.fin as string) : undefined,
  };
}
