import { readFile } from 'node:fs/promises';
import pg from 'pg';

export type TipoDeTarea = 'resumir_respuesta' | 'enviar_mail';

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

  registrarCuenta(email: string): Promise<void>;
  primerEnvio(email: string): Promise<Date | undefined>;
  enviosDesde(email: string, desde: Date): Promise<number>;
  registrarEnvio(e: { cuenta: string; para: string; asunto: string; messageId?: string }): Promise<void>;

  /** `false` si ya estaba guardado. */
  guardarRecibido(r: Recibido): Promise<boolean>;
  esBaja(email: string): Promise<boolean>;
  agregarBaja(email: string, motivo: string): Promise<void>;
}

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  static async conectar(url: string, migraciones: string[]): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 3 });
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
}
