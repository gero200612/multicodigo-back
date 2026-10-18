import { z } from 'zod';

/**
 * El cliente del Estudio de Sincro Agents (sincro-agents/estudio): el servicio
 * que renderiza reels con Remotion a partir de un guion en JSON. Homero no
 * copia nada del estudio: le habla por HTTP, por la red interna, con la clave
 * de la empresa "sincro".
 *
 * Aca no hay decisiones de contenido: solo el protocolo (validar, encolar,
 * esperar, bajar). Lo que el agente escribe lo valida el estudio, que contesta
 * en castellano y con la ruta del campo que esta mal.
 */

type Pedir = typeof fetch;

export interface ConfigDeEstudio {
  url: string;
  empresa: string;
  clave: string;
}

export interface ErrorDeGuionDeEstudio {
  ruta: string;
  mensaje: string;
}

/** Algo fallo hablando con el estudio (o el estudio no esta). */
export class ErrorDeEstudio extends Error {
  constructor(
    mensaje: string,
    readonly estado?: number,
  ) {
    super(mensaje);
  }
}

/** El guion no pasa la validacion del estudio: el agente lo tiene que corregir. */
export class GuionInvalido extends Error {
  constructor(readonly errores: ErrorDeGuionDeEstudio[]) {
    super(errores.map((e) => `${e.ruta}: ${e.mensaje}`).join('; '));
  }
}

const Trabajo = z.object({
  id: z.string(),
  estado: z.enum(['en_cola', 'renderizando', 'listo', 'fallo']),
  progreso: z.number().optional(),
  error: z.string().optional(),
  archivos: z.array(z.object({ nombre: z.string(), tipo: z.string().optional(), bytes: z.number().optional(), duracion_s: z.number().optional() }).passthrough()).optional(),
  metadatos: z.record(z.unknown()).optional(),
});
export type TrabajoDeEstudio = z.infer<typeof Trabajo>;

export interface RevisionTecnica {
  ok: boolean;
  fallas: { regla: string; detalle: string }[];
}

export interface Estudio {
  /** `false` si no contesta: Homero cae al armado viejo (solo /reel_prueba) y lo dice. */
  salud(): Promise<boolean>;
  bloques(): Promise<unknown>;
  validar(guion: unknown): Promise<ErrorDeGuionDeEstudio[]>;
  /** El cuadro de un segundo, como PNG. Tira `GuionInvalido` si el guion no pasa. */
  cuadro(guion: unknown, segundo: number): Promise<Buffer>;
  /** Encola el render. Con la misma clave y el mismo guion devuelve el mismo trabajo. */
  crear(guion: unknown, clave: string): Promise<string>;
  trabajo(id: string): Promise<TrabajoDeEstudio>;
  archivo(id: string, nombre: string): Promise<Buffer>;
}

export function clienteDeEstudio(cfg: ConfigDeEstudio, pedir: Pedir = fetch): Estudio {
  const base = cfg.url.replace(/\/+$/, '');
  const cabeceras = { 'X-Empresa': cfg.empresa, Authorization: `Bearer ${cfg.clave}` };

  async function llamar(metodo: string, ruta: string, o: { cuerpo?: unknown; clave?: string; plazoMs?: number } = {}): Promise<Response> {
    let r: Response;
    try {
      r = await pedir(`${base}${ruta}`, {
        method: metodo,
        headers: {
          ...cabeceras,
          ...(o.cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(o.clave ? { 'Idempotency-Key': o.clave } : {}),
        },
        ...(o.cuerpo !== undefined ? { body: JSON.stringify(o.cuerpo) } : {}),
        signal: AbortSignal.timeout(o.plazoMs ?? 60_000),
      });
    } catch (err) {
      throw new ErrorDeEstudio(`el estudio no contesta: ${err instanceof Error ? err.message : String(err)}`);
    }
    return r;
  }

  async function deErrores(r: Response): Promise<ErrorDeGuionDeEstudio[]> {
    const j = (await r.json().catch(() => ({}))) as { errores?: ErrorDeGuionDeEstudio[] };
    return j.errores ?? [];
  }

  async function fallar(r: Response, que: string): Promise<never> {
    const texto = (await r.text().catch(() => '')).slice(0, 300);
    throw new ErrorDeEstudio(`${que}: el estudio contestó ${r.status} ${texto}`.trim(), r.status);
  }

  return {
    async salud() {
      try {
        const r = await pedir(`${base}/v1/salud`, { signal: AbortSignal.timeout(5_000) });
        return r.ok;
      } catch {
        return false;
      }
    },

    async bloques() {
      const r = await llamar('GET', '/v1/bloques');
      if (!r.ok) await fallar(r, 'no pude leer los bloques');
      return r.json();
    },

    async validar(guion) {
      const r = await llamar('POST', '/v1/validar', { cuerpo: guion });
      if (!r.ok) await fallar(r, 'no pude validar el guion');
      const j = (await r.json()) as { valido: boolean; errores?: ErrorDeGuionDeEstudio[] };
      return j.valido ? [] : (j.errores ?? [{ ruta: '(guion)', mensaje: 'no es válido' }]);
    },

    async cuadro(guion, segundo) {
      const r = await llamar('POST', '/v1/cuadro', { cuerpo: { guion, segundo }, plazoMs: 120_000 });
      if (r.status === 422) throw new GuionInvalido(await deErrores(r));
      if (!r.ok) await fallar(r, 'no pude sacar el cuadro');
      return Buffer.from(await r.arrayBuffer());
    },

    async crear(guion, clave) {
      const r = await llamar('POST', '/v1/trabajos', { cuerpo: guion, clave });
      if (r.status === 422) throw new GuionInvalido(await deErrores(r));
      if (r.status !== 202 && !r.ok) await fallar(r, 'no pude encolar el reel');
      return z.object({ id: z.string() }).parse(await r.json()).id;
    },

    async trabajo(id) {
      const r = await llamar('GET', `/v1/trabajos/${encodeURIComponent(id)}`);
      if (!r.ok) await fallar(r, 'no pude leer el trabajo');
      return Trabajo.parse(await r.json());
    },

    async archivo(id, nombre) {
      const r = await llamar('GET', `/v1/archivos/${encodeURIComponent(id)}/${encodeURIComponent(nombre)}`, { plazoMs: 180_000 });
      if (!r.ok) await fallar(r, 'no pude bajar el video');
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

export interface ReelDeEstudio {
  video: Buffer;
  duracion?: number;
  revision?: RevisionTecnica;
}

/** El estudio dejo el trabajo en `fallo`: lo que dijo, para Gero y para el agente. */
export class RenderFallido extends Error {}

/**
 * Encola el guion, espera a que termine y baja el MP4. Con la misma `clave` un
 * reintento de la cola (un corte a mitad) retoma el mismo trabajo en vez de
 * renderizar de nuevo.
 */
export async function renderizar(
  estudio: Estudio,
  guion: unknown,
  o: { clave: string; esperar?: (ms: number) => Promise<void>; cadaMs?: number; topeMs?: number },
): Promise<ReelDeEstudio> {
  const esperar = o.esperar ?? ((ms) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const cadaMs = o.cadaMs ?? 5_000;
  const vueltas = Math.ceil((o.topeMs ?? 20 * 60_000) / cadaMs);
  const id = await estudio.crear(guion, o.clave);
  for (let i = 0; i < vueltas; i++) {
    const t = await estudio.trabajo(id);
    if (t.estado === 'fallo') throw new RenderFallido(t.error ?? 'el render falló sin decir por qué');
    if (t.estado === 'listo') {
      const mp4 = t.archivos?.find((a) => a.nombre.toLowerCase().endsWith('.mp4'));
      if (!mp4) throw new RenderFallido('el estudio terminó pero no dejó un MP4');
      const revision = t.metadatos?.revision_tecnica as { ok?: boolean; fallas?: { regla: string; detalle: string }[] } | undefined;
      return {
        video: await estudio.archivo(id, mp4.nombre),
        ...(mp4.duracion_s ? { duracion: mp4.duracion_s } : {}),
        ...(revision ? { revision: { ok: revision.ok !== false, fallas: revision.fallas ?? [] } } : {}),
      };
    }
    await esperar(cadaMs);
  }
  throw new ErrorDeEstudio(`el render ${id} no terminó en ${Math.round((o.topeMs ?? 20 * 60_000) / 60_000)} minutos`);
}
