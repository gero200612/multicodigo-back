/**
 * El registro de errores del servidor: donde queda cada falla con su contexto.
 *
 * Vive en el bridge porque el bridge es la central (decision tomada con Gero):
 * es el unico servicio Node que ya tiene la base, y nadie nuevo recibe sus
 * credenciales. Los demas —panel, gateway, Homero, el script de deploy— le
 * reportan por `POST /interno/errores`; el bridge se reporta a si mismo en
 * proceso, sin HTTP.
 *
 * Modulo aparte y no metodos de `Store`: `store.ts` ya pasa las 3800 lineas, y
 * esto no comparte nada con jobs, sesiones ni corridas. Recibe la conexion por
 * parametro (la misma del store, ver `PgStore.consulta`).
 *
 * Ver `docs/superpowers/specs/2026-10-08-registro-de-errores-design.md`.
 */
import { huellaDe, pathsDeZod, type ReporteDeError } from '@multicodigo/shared';
import type { ZodError } from 'zod';
import type { Consulta } from './altas.js';

export const ESTADOS_DE_ERROR = ['nuevo', 'arreglando', 'en_rama', 'publicado', 'descartado'] as const;
export type EstadoDeError = (typeof ESTADOS_DE_ERROR)[number];
/**
 * Los que todavia piden algo de alguien. Es tambien el criterio del indice
 * unico parcial de la 047: mientras un error esta abierto, repetirse suma
 * `veces`; cerrado, abre una fila nueva.
 */
export const ESTADOS_ABIERTOS: readonly EstadoDeError[] = ['nuevo', 'arreglando', 'en_rama'];

/** Lo que pide la pantalla: un estado, los abiertos, o todos. */
export type FiltroDeErrores = EstadoDeError | 'abiertos' | 'todos';

/** Tope de la lista. La pantalla mira lo reciente; la tabla entera no viaja. */
export const MAX_ERRORES_LISTADOS = 200;

/** Una fila, tal como la ve el panel (camelCase, fechas ISO). */
export interface ErrorRegistrado {
  id: number;
  huella: string;
  servicio: string;
  codigo: string;
  mensaje: string;
  detalle: Record<string, unknown>;
  proyectoId: string | null;
  usuarioId: string | null;
  veces: number;
  primera: string;
  ultima: string;
  estado: EstadoDeError;
  arreglo: Record<string, unknown> | null;
}

/** Cambiar a un estado abierto choca con otra fila abierta de la misma huella. */
export const YA_ABIERTO = 'ya_abierto' as const;

export interface RegistroDeErrores {
  /** Upsert por huella abierta. `nuevo` dice si se abrio una fila. */
  registrar(reporte: ReporteDeError): Promise<{ id: number; nuevo: boolean }>;
  listar(filtro: FiltroDeErrores): Promise<ErrorRegistrado[]>;
  porId(id: number): Promise<ErrorRegistrado | undefined>;
  cambiarEstado(
    id: number,
    estado: EstadoDeError,
    arreglo?: Record<string, unknown> | null,
  ): Promise<ErrorRegistrado | undefined | typeof YA_ABIERTO>;
}

// --- saneado ---------------------------------------------------------------

/**
 * Claves que se borran enteras, sin mirar el valor (comparadas en minusculas).
 *
 * `prompt` y `pliego` no son credenciales pero si lo que escribio una persona:
 * el error lo va a leer un agente (el boton "Corregí este") y una persona en la
 * pantalla, y ninguno de los dos necesita el pedido para entender la falla.
 */
const CLAVES_OCULTAS = new Set([
  'token',
  'githubtoken',
  'authorization',
  'password',
  'prompt',
  'pliego',
  'apitoken',
  'secret',
]);

/**
 * Valores con forma de credencial, en cualquier clave. Un stack o un mensaje de
 * un tercero puede traer un header entero pegado, y la clave no avisa.
 *
 * `sk-[\w-]+` y no `sk-\w+`: las de Anthropic son `sk-ant-api03-…` y con `\w`
 * solo se taparia el `ant`.
 */
const PATRONES_SECRETOS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /Bearer\s+\S+/gi,
  // Lookbehind y no `\b`: con `\b` el `sk-` de `tarea-sk-1` tambien seria una
  // key, porque el guion cuenta como borde.
  /(?<![\w-])gh[pousr]_\w+/g,
  /(?<![\w-])sk-[\w-]+/g,
];

export const OCULTO = '«oculto»';
/** Cuanto `detalle` se guarda. Un stack con un cuerpo pegado no tiene techo. */
export const MAX_DETALLE_BYTES = 16 * 1024;
/** Un objeto mas hondo que esto no es contexto de un error, es un volcado. */
const MAX_PROFUNDIDAD = 20;

export function sanearTexto(texto: string): string {
  return PATRONES_SECRETOS.reduce((t, re) => t.replace(re, OCULTO), texto);
}

function sanearValor(valor: unknown, profundidad: number): unknown {
  if (typeof valor === 'string') return sanearTexto(valor);
  if (valor === null || typeof valor !== 'object') return valor;
  if (profundidad >= MAX_PROFUNDIDAD) return '«demasiado hondo»';
  if (Array.isArray(valor)) return valor.map((v) => sanearValor(v, profundidad + 1));
  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (CLAVES_OCULTAS.has(clave.toLowerCase())) continue;
    salida[clave] = sanearValor(v, profundidad + 1);
  }
  return salida;
}

/**
 * Saca credenciales y texto de personas, y corta a 16 KB.
 *
 * Se hace aca, al guardar, y no en cada servicio que reporta: es un solo lugar
 * que mantener, y un servicio que se olvida de sanear no puede filtrar nada.
 * Si se pasa del tope, se guarda el comienzo COMO TEXTO: un JSON cortado a la
 * mitad no se puede guardar en una columna jsonb.
 */
export function sanearDetalle(detalle: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const limpio = sanearValor(detalle ?? {}, 0) as Record<string, unknown>;
  const json = JSON.stringify(limpio);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length <= MAX_DETALLE_BYTES) return limpio;
  return { truncado: true, inicio: bytes.subarray(0, MAX_DETALLE_BYTES).toString('utf8') };
}

/** El reporte entero, listo para guardar. Puro: lo prueba `errores.test.ts`. */
export function sanearReporte(reporte: ReporteDeError): ReporteDeError {
  return {
    ...reporte,
    mensaje: sanearTexto(reporte.mensaje),
    huella: sanearTexto(reporte.huella),
    detalle: sanearDetalle(reporte.detalle),
  };
}

// --- Postgres -----------------------------------------------------------------

interface FilaDeError {
  id: string | number;
  huella: string;
  servicio: string;
  codigo: string;
  mensaje: string;
  detalle: Record<string, unknown> | null;
  proyecto_id: string | null;
  usuario_id: string | null;
  veces: number;
  primera: Date | string;
  ultima: Date | string;
  estado: EstadoDeError;
  arreglo: Record<string, unknown> | null;
}

const COLUMNAS =
  'id, huella, servicio, codigo, mensaje, detalle, proyecto_id, usuario_id, veces, primera, ultima, estado, arreglo';

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

function aRegistrado(f: FilaDeError): ErrorRegistrado {
  return {
    // `bigserial` llega como string desde `pg`: el panel lo quiere numero, y
    // nadie va a pasar de 2^53 errores.
    id: Number(f.id),
    huella: f.huella,
    servicio: f.servicio,
    codigo: f.codigo,
    mensaje: f.mensaje,
    detalle: f.detalle ?? {},
    proyectoId: f.proyecto_id,
    usuarioId: f.usuario_id,
    veces: f.veces,
    primera: iso(f.primera),
    ultima: iso(f.ultima),
    estado: f.estado,
    arreglo: f.arreglo,
  };
}

function estadosDe(filtro: FiltroDeErrores): readonly EstadoDeError[] {
  if (filtro === 'todos') return ESTADOS_DE_ERROR;
  if (filtro === 'abiertos') return ESTADOS_ABIERTOS;
  return [filtro];
}

/** Violacion de un indice unico en Postgres. */
const esUnicoRepetido = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

export class PgRegistroDeErrores implements RegistroDeErrores {
  constructor(private readonly db: Consulta) {}

  async registrar(reporte: ReporteDeError): Promise<{ id: number; nuevo: boolean }> {
    const r = sanearReporte(reporte);
    // Un solo INSERT … ON CONFLICT contra el indice PARCIAL: dos reportes del
    // mismo bug al mismo tiempo (el panel y el gateway ven el mismo rechazo)
    // no pueden abrir dos filas, y un SELECT-y-despues-INSERT si podria.
    // `xmax = 0` es como Postgres dice "esta fila la inserte yo".
    const { rows } = await this.db.query<{ id: string | number; nuevo: boolean }>(
      `INSERT INTO public.errores (huella, servicio, codigo, mensaje, detalle, proyecto_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (huella) WHERE estado IN ('nuevo', 'arreglando', 'en_rama')
       DO UPDATE SET veces = errores.veces + 1,
                     ultima = now(),
                     detalle = EXCLUDED.detalle,
                     proyecto_id = COALESCE(EXCLUDED.proyecto_id, errores.proyecto_id),
                     usuario_id = COALESCE(EXCLUDED.usuario_id, errores.usuario_id)
       RETURNING id, (xmax = 0) AS nuevo`,
      [
        r.huella,
        r.servicio,
        r.codigo,
        r.mensaje,
        JSON.stringify(r.detalle ?? {}),
        r.proyectoId ?? null,
        r.usuarioId ?? null,
      ],
    );
    const fila = rows[0]!;
    return { id: Number(fila.id), nuevo: fila.nuevo };
  }

  async listar(filtro: FiltroDeErrores): Promise<ErrorRegistrado[]> {
    const { rows } = await this.db.query<FilaDeError>(
      `SELECT ${COLUMNAS} FROM public.errores
        WHERE estado = ANY($1::text[])
        ORDER BY ultima DESC, id DESC
        LIMIT ${MAX_ERRORES_LISTADOS}`,
      [estadosDe(filtro)],
    );
    return rows.map(aRegistrado);
  }

  async porId(id: number): Promise<ErrorRegistrado | undefined> {
    const { rows } = await this.db.query<FilaDeError>(`SELECT ${COLUMNAS} FROM public.errores WHERE id = $1`, [id]);
    return rows[0] ? aRegistrado(rows[0]) : undefined;
  }

  async cambiarEstado(
    id: number,
    estado: EstadoDeError,
    arreglo?: Record<string, unknown> | null,
  ): Promise<ErrorRegistrado | undefined | typeof YA_ABIERTO> {
    try {
      // Sin `arreglo` se deja el que habia: descartar no borra lo que hizo el
      // agente, y es justo lo que se quiere mirar si el error vuelve.
      const { rows } = await this.db.query<FilaDeError>(
        `UPDATE public.errores
            SET estado = $2,
                arreglo = CASE WHEN $3::boolean THEN $4::jsonb ELSE arreglo END
          WHERE id = $1
          RETURNING ${COLUMNAS}`,
        [id, estado, arreglo !== undefined, arreglo == null ? null : JSON.stringify(sanearDetalle(arreglo))],
      );
      return rows[0] ? aRegistrado(rows[0]) : undefined;
    } catch (err) {
      // Reabrir un descartado cuando el mismo bug ya volvio a abrir otra fila.
      if (esUnicoRepetido(err)) return YA_ABIERTO;
      throw err;
    }
  }
}

// --- en memoria ---------------------------------------------------------------

/**
 * El mismo contrato sin base, para los tests del webhook. Repite el criterio
 * del indice parcial a mano; `errores.test.ts` corre los mismos casos contra
 * las dos implementaciones para que no se separen.
 */
export class RegistroEnMemoria implements RegistroDeErrores {
  readonly filas: ErrorRegistrado[] = [];
  private siguiente = 1;
  /** Un reloj inyectable: con `Date.now()` dos reportes seguidos empatan. */
  constructor(private readonly ahora: () => Date = () => new Date()) {}

  async registrar(reporte: ReporteDeError): Promise<{ id: number; nuevo: boolean }> {
    const r = sanearReporte(reporte);
    const ahora = this.ahora().toISOString();
    const abierta = this.filas.find((f) => f.huella === r.huella && ESTADOS_ABIERTOS.includes(f.estado));
    if (abierta) {
      abierta.veces += 1;
      abierta.ultima = ahora;
      abierta.detalle = r.detalle ?? {};
      abierta.proyectoId = r.proyectoId ?? abierta.proyectoId;
      abierta.usuarioId = r.usuarioId ?? abierta.usuarioId;
      return { id: abierta.id, nuevo: false };
    }
    const fila: ErrorRegistrado = {
      id: this.siguiente++,
      huella: r.huella,
      servicio: r.servicio,
      codigo: r.codigo,
      mensaje: r.mensaje,
      detalle: r.detalle ?? {},
      proyectoId: r.proyectoId ?? null,
      usuarioId: r.usuarioId ?? null,
      veces: 1,
      primera: ahora,
      ultima: ahora,
      estado: 'nuevo',
      arreglo: null,
    };
    this.filas.push(fila);
    return { id: fila.id, nuevo: true };
  }

  async listar(filtro: FiltroDeErrores): Promise<ErrorRegistrado[]> {
    const estados = estadosDe(filtro);
    return this.filas
      .filter((f) => estados.includes(f.estado))
      .sort((a, b) => b.ultima.localeCompare(a.ultima) || b.id - a.id)
      .slice(0, MAX_ERRORES_LISTADOS)
      .map((f) => ({ ...f }));
  }

  async porId(id: number): Promise<ErrorRegistrado | undefined> {
    const f = this.filas.find((x) => x.id === id);
    return f ? { ...f } : undefined;
  }

  async cambiarEstado(
    id: number,
    estado: EstadoDeError,
    arreglo?: Record<string, unknown> | null,
  ): Promise<ErrorRegistrado | undefined | typeof YA_ABIERTO> {
    const f = this.filas.find((x) => x.id === id);
    if (!f) return undefined;
    if (
      ESTADOS_ABIERTOS.includes(estado) &&
      this.filas.some((x) => x.id !== id && x.huella === f.huella && ESTADOS_ABIERTOS.includes(x.estado))
    ) {
      return YA_ABIERTO;
    }
    f.estado = estado;
    if (arreglo !== undefined) f.arreglo = arreglo === null ? null : sanearDetalle(arreglo);
    return { ...f };
  }
}

// --- lo que reporta el propio bridge ---------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un id del cuerpo, solo si tiene forma de uuid: el cuerpo es justo lo que no valido. */
function uuidDe(cuerpo: unknown, clave: string): string | undefined {
  if (!cuerpo || typeof cuerpo !== 'object') return undefined;
  const v = (cuerpo as Record<string, unknown>)[clave];
  return typeof v === 'string' && UUID.test(v) ? v : undefined;
}

/**
 * Un rechazo de schema como reporte.
 *
 * La huella es la ruta mas los paths de zod (`documentos:too_big`): el mismo
 * campo mal en el mismo endpoint es el mismo bug, venga de quien venga. El
 * detalle lleva los issues SIN los valores del cuerpo —el prompt, el token y el
 * pliego no pueden terminar en una tabla que lee un agente— y el saneado de
 * `registrar` es la segunda red, no la primera.
 */
export function reporteDeCuerpoInvalido(ruta: string, error: ZodError, cuerpo: unknown): ReporteDeError {
  const paths = pathsDeZod(error);
  return {
    servicio: 'bridge',
    codigo: 'cuerpo_invalido',
    mensaje: `${ruta} rechazó el cuerpo: ${paths.slice(0, 5).join(', ')}`.slice(0, 500),
    huella: huellaDe('bridge', 'cuerpo_invalido', `${ruta} ${paths.join(',')}`),
    detalle: {
      ruta,
      issues: error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    },
    proyectoId: uuidDe(cuerpo, 'proyectoId'),
    usuarioId: uuidDe(cuerpo, 'usuarioId'),
  };
}

// --- reportar sin romper ---------------------------------------------------------

/**
 * Cuanto se espera al registro cuando la respuesta quiere llevar el `errorId`.
 * Es mas corto que los 3 s de `reportarError` de shared porque aca no hay red:
 * si la base tarda mas que esto, esta peor que el error que se quiere anotar.
 */
const ESPERA_DEL_REGISTRO_MS = 1_500;

/**
 * Anota un error del propio bridge. NUNCA tira y nunca tarda mas de 1,5 s: un
 * registro que falla no puede romper ni demorar lo que estaba fallando. Si no
 * se pudo, queda en el log como antes y devuelve `undefined`.
 */
export async function registrarSinRomper(
  registro: RegistroDeErrores | undefined,
  reporte: ReporteDeError,
  esperaMs = ESPERA_DEL_REGISTRO_MS,
): Promise<number | undefined> {
  if (!registro) return undefined;
  let reloj: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      registro.registrar(reporte),
      new Promise<never>((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error('el registro tardo demasiado')), esperaMs);
      }),
    ]);
    return r.id;
  } catch (err) {
    console.error('[errores] no se pudo registrar:', err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(reloj);
  }
}
