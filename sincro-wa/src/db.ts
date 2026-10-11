import pg from 'pg';
import type { Capacidad } from './capacidades.js';
import { migrar } from './migraciones.js';

// `pg` devuelve numeric y bigint como texto (para no perder precision). Aca son
// montos en pesos con 2 a 6 decimales e ids: entran sobrados en un number, y
// como texto las sumas y comparaciones del tope salen mal ('5.00' + 1).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
import type {
  Alerta,
  Cambio,
  CambiosDeEvento,
  CambiosDeMensaje,
  CambiosDeNegocio,
  CambiosDeNumero,
  CambiosDePlantilla,
  CambiosDeTrabajo,
  Contacto,
  Evento,
  Media,
  Mensaje,
  Negocio,
  NuevaPlantilla,
  NuevoMensaje,
  NuevoNegocio,
  NuevoTrabajo,
  Numero,
  Plantilla,
  Precio,
  Saliente,
  Store,
  TipoDeEventoGuardado,
  TipoDeTrabajo,
  TrabajoIa,
  UsoIa,
} from './store.js';

// bigint (ids bigserial, count) y numeric llegan como string por defecto.
// Los montos de aca entran holgados en un double y los ids tambien.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

type Fila = Record<string, any>;

const negocio = (r: Fila): Negocio => ({
  id: r.id,
  nombre: r.nombre,
  app: r.app,
  capacidades: r.capacidades as Capacidad[],
  topeMensualArs: r.tope_mensual_ars,
  urlBase: r.url_base,
  activo: r.activo,
  claveHash: r.clave_hash,
  claveUltimoUso: r.clave_ultimo_uso,
  secretoEventos: r.secreto_eventos,
  contextoAtender: r.contexto_atender,
  creado: r.creado,
});

const numero = (r: Fila): Numero => ({
  id: r.id,
  negocioId: r.negocio_id,
  phoneNumberId: r.phone_number_id,
  wabaId: r.waba_id,
  tokenCifrado: r.token_cifrado,
  calidad: r.calidad,
  topeMeta: r.tope_meta,
  estado: r.estado,
  nombreVerificado: r.nombre_verificado,
  sinMensajesAlertado: r.sin_mensajes_alertado,
});

const contacto = (r: Fila): Contacto => ({
  numeroId: r.numero_id,
  negocioId: r.negocio_id,
  contacto: r.contacto,
  nombre: r.nombre,
  ultimaEntrada: r.ultima_entrada,
  baja: r.baja,
  bajaDesde: r.baja_desde,
  derivada: r.derivada,
});

const mensaje = (r: Fila): Mensaje => ({
  id: r.id,
  negocioId: r.negocio_id,
  numeroId: r.numero_id,
  contacto: r.contacto,
  direccion: r.direccion,
  tipo: r.tipo,
  texto: r.texto,
  mediaId: r.media_id,
  referral: r.referral,
  plantilla: r.plantilla,
  wamid: r.wamid,
  categoria: r.categoria,
  costoEstimado: r.costo_estimado,
  costoReal: r.costo_real,
  estado: r.estado,
  error: r.error,
  fecha: r.fecha,
});

const plantilla = (r: Fila): Plantilla => ({
  id: r.id,
  negocioId: r.negocio_id,
  wabaId: r.waba_id,
  metaId: r.meta_id,
  nombre: r.nombre,
  idioma: r.idioma,
  categoria: r.categoria,
  componentes: r.componentes,
  estado: r.estado,
  motivo: r.motivo,
  bloqueada: r.bloqueada,
});

const evento = (r: Fila): Evento => ({
  id: r.id,
  negocioId: r.negocio_id,
  tipo: r.tipo,
  datos: r.datos,
  fecha: r.fecha,
  entregado: r.entregado,
  intentos: r.intentos,
  proximoIntento: r.proximo_intento,
  alertado: r.alertado,
});

const trabajo = (r: Fila): TrabajoIa => ({
  id: r.id,
  negocioId: r.negocio_id,
  numeroId: r.numero_id,
  contacto: r.contacto,
  tipo: r.tipo,
  entrada: r.entrada,
  estado: r.estado,
  tomadaHasta: r.tomada_hasta,
  resultado: r.resultado,
  error: r.error,
  creado: r.creado,
});

const alerta = (r: Fila): Alerta => ({
  id: r.id,
  clave: r.clave,
  negocioId: r.negocio_id,
  tipo: r.tipo,
  texto: r.texto,
  fecha: r.fecha,
});

const cambio = (r: Fila): Cambio => ({
  id: r.id,
  negocioId: r.negocio_id,
  campo: r.campo,
  antes: r.antes,
  despues: r.despues,
  quien: r.quien,
  fecha: r.fecha,
});

/** Las columnas jsonb: se mandan como texto, si no pg convierte los arrays a arrays de Postgres. */
const JSONB = new Set(['referral', 'error', 'componentes', 'datos', 'entrada', 'resultado']);

const snake = (s: string) => s.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);

/** `SET a = $2, b = $3` a partir de un objeto de cambios en camelCase. */
function set(cambios: object, desde = 2): { sql: string; valores: unknown[] } {
  const pares = Object.entries(cambios).filter(([, v]) => v !== undefined);
  return {
    sql: pares.map(([k], i) => `${snake(k)} = $${i + desde}`).join(', '),
    valores: pares.map(([k, v]) => (JSONB.has(snake(k)) && v !== null ? JSON.stringify(v) : v)),
  };
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export class PgStore implements Store {
  private constructor(private readonly pool: pg.Pool) {}

  static async abrir(url: string, log?: (t: string) => void): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    // Un error de una conexion ociosa no tiene que tirar el proceso.
    pool.on('error', (e) => log?.(`postgres: ${e.message}`));
    await migrar(pool, log);
    return new PgStore(pool);
  }

  cerrar(): Promise<void> {
    return this.pool.end();
  }

  private async filas(sql: string, valores: unknown[] = []): Promise<Fila[]> {
    return (await this.pool.query(sql, valores)).rows;
  }

  private async actualizar(tabla: string, donde: string, claves: unknown[], cambios: object): Promise<void> {
    const s = set(cambios, claves.length + 1);
    if (!s.valores.length) return;
    await this.pool.query(`UPDATE ${tabla} SET ${s.sql} WHERE ${donde}`, [...claves, ...s.valores]);
  }

  // Negocios

  async crearNegocio(n: NuevoNegocio, fecha: Date): Promise<Negocio> {
    const [r] = await this.filas(
      `INSERT INTO negocios (nombre, app, capacidades, tope_mensual_ars, url_base, secreto_eventos, creado)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [n.nombre, n.app, n.capacidades, n.topeMensualArs, n.urlBase, n.secretoEventos, fecha],
    );
    return negocio(r!);
  }

  async negocio(id: number) {
    const [r] = await this.filas('SELECT * FROM negocios WHERE id = $1', [id]);
    return r ? negocio(r) : undefined;
  }

  async negocios() {
    return (await this.filas('SELECT * FROM negocios ORDER BY id')).map(negocio);
  }

  async cambiarNegocio(id: number, c: CambiosDeNegocio) {
    await this.actualizar('negocios', 'id = $1', [id], c);
    return this.negocio(id);
  }

  async usoDeClave(id: number, fecha: Date) {
    await this.pool.query('UPDATE negocios SET clave_ultimo_uso = $2 WHERE id = $1', [id, fecha]);
  }

  async registrarCambios(cs: Cambio[]) {
    for (const c of cs) {
      await this.pool.query(
        'INSERT INTO cambios (negocio_id, campo, antes, despues, quien, fecha) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.negocioId, c.campo, c.antes, c.despues, c.quien, c.fecha],
      );
    }
  }

  async cambios(negocioId?: number) {
    return (
      await this.filas(
        `SELECT * FROM cambios WHERE ($1::int IS NULL OR negocio_id = $1) ORDER BY fecha DESC, id DESC LIMIT 500`,
        [negocioId ?? null],
      )
    ).map(cambio);
  }

  // Numeros

  async crearNumero(n: Pick<Numero, 'negocioId' | 'phoneNumberId' | 'wabaId' | 'tokenCifrado'>) {
    const [r] = await this.filas(
      `INSERT INTO numeros (negocio_id, phone_number_id, waba_id, token_cifrado) VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone_number_id) DO NOTHING RETURNING *`,
      [n.negocioId, n.phoneNumberId, n.wabaId, n.tokenCifrado],
    );
    return r ? numero(r) : undefined;
  }

  async numero(id: number) {
    const [r] = await this.filas('SELECT * FROM numeros WHERE id = $1', [id]);
    return r ? numero(r) : undefined;
  }

  async numeroPorPhoneId(phoneNumberId: string) {
    const [r] = await this.filas('SELECT * FROM numeros WHERE phone_number_id = $1', [phoneNumberId]);
    return r ? numero(r) : undefined;
  }

  async numerosDe(negocioId: number) {
    return (await this.filas('SELECT * FROM numeros WHERE negocio_id = $1 ORDER BY id', [negocioId])).map(numero);
  }

  async numerosDeWaba(wabaId: string) {
    return (await this.filas('SELECT * FROM numeros WHERE waba_id = $1 ORDER BY id', [wabaId])).map(numero);
  }

  async todosLosNumeros() {
    return (await this.filas('SELECT * FROM numeros ORDER BY id')).map(numero);
  }

  async cambiarNumero(id: number, c: CambiosDeNumero) {
    await this.actualizar('numeros', 'id = $1', [id], c);
  }

  // Contactos

  async contacto(numeroId: number, c: string) {
    const [r] = await this.filas('SELECT * FROM contactos WHERE numero_id = $1 AND contacto = $2', [numeroId, c]);
    return r ? contacto(r) : undefined;
  }

  async contactosDe(negocioId: number, c: string) {
    return (await this.filas('SELECT * FROM contactos WHERE negocio_id = $1 AND contacto = $2', [negocioId, c])).map(contacto);
  }

  async registrarEntrada(numeroId: number, negocioId: number, c: string, nombre: string | null, fecha: Date) {
    const [r] = await this.filas(
      `INSERT INTO contactos (numero_id, contacto, negocio_id, nombre, ultima_entrada) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (numero_id, contacto) DO UPDATE
         SET ultima_entrada = GREATEST(contactos.ultima_entrada, EXCLUDED.ultima_entrada),
             nombre = COALESCE(EXCLUDED.nombre, contactos.nombre)
       RETURNING *`,
      [numeroId, c, negocioId, nombre, fecha],
    );
    return contacto(r!);
  }

  async cambiarContacto(numeroId: number, c: string, cambios: Partial<Pick<Contacto, 'baja' | 'bajaDesde' | 'derivada'>>) {
    await this.actualizar('contactos', 'numero_id = $1 AND contacto = $2', [numeroId, c], cambios);
  }

  async bajas(negocioId?: number) {
    return (
      await this.filas('SELECT * FROM contactos WHERE baja AND ($1::int IS NULL OR negocio_id = $1) ORDER BY baja_desde DESC', [
        negocioId ?? null,
      ])
    ).map(contacto);
  }

  async ventanasAbiertas(desde: Date, negocioId?: number) {
    const [r] = await this.filas(
      'SELECT count(*) AS n FROM contactos WHERE ultima_entrada > $1 AND ($2::int IS NULL OR negocio_id = $2)',
      [desde, negocioId ?? null],
    );
    return r!.n as number;
  }

  // Mensajes

  async guardarMensaje(m: NuevoMensaje) {
    const [r] = await this.filas(
      `INSERT INTO mensajes (negocio_id, numero_id, contacto, direccion, tipo, texto, media_id, referral, plantilla, wamid,
                             categoria, costo_estimado, costo_real, estado, error, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (wamid) DO NOTHING RETURNING *`,
      [
        m.negocioId,
        m.numeroId,
        m.contacto,
        m.direccion,
        m.tipo,
        m.texto,
        m.mediaId,
        json(m.referral),
        m.plantilla,
        m.wamid,
        m.categoria,
        m.costoEstimado,
        m.costoReal,
        m.estado,
        json(m.error),
        m.fecha,
      ],
    );
    return r ? mensaje(r) : undefined;
  }

  async mensajePorWamid(wamid: string) {
    const [r] = await this.filas('SELECT * FROM mensajes WHERE wamid = $1', [wamid]);
    return r ? mensaje(r) : undefined;
  }

  async cambiarMensaje(id: number, c: CambiosDeMensaje) {
    await this.actualizar('mensajes', 'id = $1', [id], c);
  }

  async charla(negocioId: number, c: string, limite: number) {
    return (
      await this.filas(
        `SELECT * FROM (SELECT * FROM mensajes WHERE negocio_id = $1 AND contacto = $2 ORDER BY fecha DESC, id DESC LIMIT $3) m
         ORDER BY fecha, id`,
        [negocioId, c, limite],
      )
    ).map(mensaje);
  }

  async contactosConPlantilla(numeroId: number, desde: Date) {
    return (
      await this.filas(
        `SELECT DISTINCT contacto FROM mensajes
         WHERE numero_id = $1 AND direccion = 'sale' AND plantilla IS NOT NULL AND wamid IS NOT NULL AND fecha > $2`,
        [numeroId, desde],
      )
    ).map((r) => r.contacto as string);
  }

  async costosDelPeriodo(negocioId: number, desde: Date, hasta: Date) {
    const [r] = await this.filas(
      `SELECT
         (SELECT COALESCE(sum(COALESCE(costo_real, costo_estimado)), 0) FROM mensajes
           WHERE negocio_id = $1 AND fecha >= $2 AND fecha < $3) AS meta,
         (SELECT COALESCE(sum(costo_usd), 0) FROM uso_ia WHERE negocio_id = $1 AND fecha >= $2 AND fecha < $3) AS ia`,
      [negocioId, desde, hasta],
    );
    return { metaArs: r!.meta as number, iaUsd: r!.ia as number };
  }

  async salientes(desde: Date, hasta: Date, negocioId?: number): Promise<Saliente[]> {
    return (
      await this.filas(
        `SELECT negocio_id, fecha, categoria, COALESCE(costo_real, costo_estimado) AS costo FROM mensajes
         WHERE direccion = 'sale' AND wamid IS NOT NULL AND fecha >= $1 AND fecha < $2 AND ($3::int IS NULL OR negocio_id = $3)`,
        [desde, hasta, negocioId ?? null],
      )
    ).map((r) => ({ negocioId: r.negocio_id, fecha: r.fecha, categoria: r.categoria, costo: r.costo }));
  }

  // Media

  async guardarMedia(negocioId: number, mime: string, datos: Buffer, fecha: Date) {
    const [r] = await this.filas('INSERT INTO media (negocio_id, mime, datos, creado) VALUES ($1, $2, $3, $4) RETURNING id', [
      negocioId,
      mime,
      datos,
      fecha,
    ]);
    return r!.id as number;
  }

  async media(id: number): Promise<Media | undefined> {
    const [r] = await this.filas('SELECT * FROM media WHERE id = $1', [id]);
    return r ? { id: r.id, negocioId: r.negocio_id, mime: r.mime, datos: r.datos, creado: r.creado } : undefined;
  }

  async borrarMediaVieja(antes: Date) {
    return (await this.pool.query('DELETE FROM media WHERE creado < $1', [antes])).rowCount ?? 0;
  }

  // Plantillas

  async crearPlantilla(p: NuevaPlantilla) {
    const [r] = await this.filas(
      `INSERT INTO plantillas (negocio_id, waba_id, meta_id, nombre, idioma, categoria, componentes, estado, motivo, bloqueada)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (negocio_id, nombre, idioma) DO NOTHING RETURNING *`,
      [p.negocioId, p.wabaId, p.metaId, p.nombre, p.idioma, p.categoria, JSON.stringify(p.componentes), p.estado, p.motivo, p.bloqueada],
    );
    return r ? plantilla(r) : undefined;
  }

  async plantilla(negocioId: number, nombre: string, idioma: string) {
    const [r] = await this.filas('SELECT * FROM plantillas WHERE negocio_id = $1 AND nombre = $2 AND idioma = $3', [
      negocioId,
      nombre,
      idioma,
    ]);
    return r ? plantilla(r) : undefined;
  }

  async plantillas(negocioId?: number) {
    return (
      await this.filas('SELECT * FROM plantillas WHERE ($1::int IS NULL OR negocio_id = $1) ORDER BY negocio_id, nombre, idioma', [
        negocioId ?? null,
      ])
    ).map(plantilla);
  }

  async plantillaPorMetaId(metaId: string) {
    const [r] = await this.filas('SELECT * FROM plantillas WHERE meta_id = $1', [metaId]);
    return r ? plantilla(r) : undefined;
  }

  async plantillasDeWaba(wabaId: string, nombre: string, idioma: string) {
    return (
      await this.filas('SELECT * FROM plantillas WHERE waba_id = $1 AND nombre = $2 AND idioma = $3', [wabaId, nombre, idioma])
    ).map(plantilla);
  }

  async cambiarPlantilla(id: number, c: CambiosDePlantilla) {
    await this.actualizar('plantillas', 'id = $1', [id], c);
  }

  // Costos

  async precios(): Promise<Precio[]> {
    return (await this.filas('SELECT * FROM precios_meta ORDER BY categoria')).map((r) => ({
      categoria: r.categoria,
      precioArs: r.precio_ars,
      desde: r.desde,
    }));
  }

  async ponerPrecio(categoria: string, precioArs: number, fecha: Date) {
    await this.pool.query(
      `INSERT INTO precios_meta (categoria, precio_ars, desde) VALUES ($1, $2, $3)
       ON CONFLICT (categoria) DO UPDATE SET precio_ars = EXCLUDED.precio_ars, desde = EXCLUDED.desde`,
      [categoria, precioArs, fecha],
    );
  }

  async dolar() {
    const [r] = await this.filas('SELECT ars_por_usd FROM dolar ORDER BY desde DESC, id DESC LIMIT 1');
    return r ? (r.ars_por_usd as number) : undefined;
  }

  async ponerDolar(arsPorUsd: number, quien: string, fecha: Date) {
    await this.pool.query('INSERT INTO dolar (ars_por_usd, quien, desde) VALUES ($1, $2, $3)', [arsPorUsd, quien, fecha]);
  }

  async registrarUsoIa(u: UsoIa) {
    await this.pool.query(
      `INSERT INTO uso_ia (negocio_id, capacidad, modelo, tokens_entrada, tokens_salida, costo_usd, fecha)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [u.negocioId, u.capacidad, u.modelo, u.tokensEntrada, u.tokensSalida, u.costoUsd, u.fecha],
    );
  }

  // Eventos

  async crearEvento(negocioId: number | null, tipo: TipoDeEventoGuardado, datos: Record<string, unknown>, fecha: Date) {
    const [r] = await this.filas('INSERT INTO eventos (negocio_id, tipo, datos, fecha) VALUES ($1, $2, $3, $4) RETURNING *', [
      negocioId,
      tipo,
      JSON.stringify(datos),
      fecha,
    ]);
    return evento(r!);
  }

  async eventosPendientes(negocioId: number | null, limite: number) {
    return (
      await this.filas(
        `SELECT * FROM eventos WHERE NOT entregado AND negocio_id IS NOT DISTINCT FROM $1::int ORDER BY id LIMIT $2`,
        [negocioId, limite],
      )
    ).map(evento);
  }

  async ackEventos(negocioId: number | null, ids: number[]) {
    if (!ids.length) return 0;
    const r = await this.pool.query(
      `UPDATE eventos SET entregado = true
       WHERE id = ANY($2::bigint[]) AND NOT entregado AND negocio_id IS NOT DISTINCT FROM $1::int`,
      [negocioId, ids],
    );
    return r.rowCount ?? 0;
  }

  async eventosParaPush(ahora: Date) {
    return (
      await this.filas(
        `SELECT e.* FROM eventos e JOIN negocios n ON n.id = e.negocio_id
         WHERE NOT e.entregado AND NOT e.alertado AND n.url_base IS NOT NULL AND e.proximo_intento <= $1
         ORDER BY e.id LIMIT 200`,
        [ahora],
      )
    ).map(evento);
  }

  async cambiarEvento(id: number, c: CambiosDeEvento) {
    await this.actualizar('eventos', 'id = $1', [id], c);
  }

  // IA

  async crearTrabajo(t: NuevoTrabajo) {
    const [r] = await this.filas(
      `INSERT INTO ia_trabajos (negocio_id, numero_id, contacto, tipo, entrada, creado) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [t.negocioId, t.numeroId, t.contacto, t.tipo, JSON.stringify(t.entrada), t.creado],
    );
    return trabajo(r!);
  }

  async trabajo(id: number) {
    const [r] = await this.filas('SELECT * FROM ia_trabajos WHERE id = $1', [id]);
    return r ? trabajo(r) : undefined;
  }

  async trabajoPendiente(numeroId: number, c: string, tipo: TipoDeTrabajo) {
    const [r] = await this.filas(
      `SELECT * FROM ia_trabajos WHERE numero_id = $1 AND contacto = $2 AND tipo = $3 AND estado = 'pendiente' ORDER BY id LIMIT 1`,
      [numeroId, c, tipo],
    );
    return r ? trabajo(r) : undefined;
  }

  async tomarTrabajos(ahora: Date, hasta: Date, limite: number) {
    // SKIP LOCKED: si dos pedidos de Homero se cruzan, no toman el mismo trabajo.
    return (
      await this.filas(
        `UPDATE ia_trabajos SET estado = 'tomada', tomada_hasta = $2
         WHERE id IN (
           SELECT id FROM ia_trabajos
           WHERE estado = 'pendiente' OR (estado = 'tomada' AND tomada_hasta < $1)
           ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [ahora, hasta, limite],
      )
    )
      .map(trabajo)
      .sort((a, b) => a.id - b.id);
  }

  async cambiarTrabajo(id: number, c: CambiosDeTrabajo) {
    await this.actualizar('ia_trabajos', 'id = $1', [id], c);
  }

  async liberarTrabajosVencidos(ahora: Date) {
    const r = await this.pool.query(
      `UPDATE ia_trabajos SET estado = 'pendiente', tomada_hasta = NULL WHERE estado = 'tomada' AND tomada_hasta < $1`,
      [ahora],
    );
    return r.rowCount ?? 0;
  }

  // Alertas y registro

  async crearAlerta(a: Omit<Alerta, 'id'>) {
    const [r] = await this.filas(
      `INSERT INTO alertas (clave, negocio_id, tipo, texto, fecha) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (clave) DO NOTHING RETURNING *`,
      [a.clave, a.negocioId, a.tipo, a.texto, a.fecha],
    );
    return r ? alerta(r) : undefined;
  }

  async alertas(limite: number) {
    return (await this.filas('SELECT * FROM alertas ORDER BY fecha DESC, id DESC LIMIT $1', [limite])).map(alerta);
  }

  async registrarIntentoNegado(negocioId: number, metodo: string, ruta: string, fecha: Date) {
    await this.pool.query('INSERT INTO intentos_negados (negocio_id, metodo, ruta, fecha) VALUES ($1, $2, $3, $4)', [
      negocioId,
      metodo,
      ruta.slice(0, 300),
      fecha,
    ]);
  }

  async registrarWebhook(numeroId: number, fecha: Date) {
    await this.pool.query('INSERT INTO webhook_eventos (numero_id, fecha) VALUES ($1, $2)', [numeroId, fecha]);
  }

  async contarWebhooks(numeroId: number, desde: Date) {
    const [r] = await this.filas('SELECT count(*) AS n FROM webhook_eventos WHERE numero_id = $1 AND fecha > $2', [numeroId, desde]);
    return r!.n as number;
  }

  async borrarWebhooksViejos(antes: Date) {
    return (await this.pool.query('DELETE FROM webhook_eventos WHERE fecha < $1', [antes])).rowCount ?? 0;
  }
}
