import { z } from 'zod';
import type { Contexto } from './contexto.js';
import { emitir } from './eventos.js';

/**
 * El formulario de contacto de la web de un negocio (hoy, sincro.apps.punchi.dev).
 *
 * Es lo unico del bot que recibe datos de cualquiera en internet, asi que:
 * - solo existe si el despliegue dice a que negocio va (FORMULARIO_NEGOCIO);
 * - CORS solo para los origenes de esa web;
 * - un tope de envios por IP, un campo trampa para bots y textos cortos;
 * - no guarda nada propio: se lo pasa a la app del negocio como evento
 *   `formulario` (lo recibe quien tiene `leads`), y ella decide que hacer.
 */

export interface ConfigDeFormulario {
  negocioId: number;
  origenes: string[];
}

const linea = (max: number) =>
  z
    .string()
    .transform((t) => t.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max));

export const Formulario = z
  .object({
    nombre: linea(80).pipe(z.string().min(1)),
    negocio: linea(120).optional(),
    whatsapp: linea(30).optional(),
    mail: linea(120).optional(),
    tema: linea(80).optional(),
    mensaje: z.string().trim().max(2000).optional(),
    acepta_whatsapp: z.boolean().optional(),
    // El campo trampa: una persona no lo ve, un bot lo llena.
    sitio: z.string().optional(),
  })
  .strip();

export type DatosDeFormulario = z.infer<typeof Formulario>;

/**
 * `11 2345-6789`, `011 15 2345 6789`, `+54 9 11...` -> `5491123456789`. Un
 * numero de otro pais con su codigo queda como vino (solo digitos).
 */
export function telefonoDeWhatsapp(t: string | undefined): string | undefined {
  let d = (t ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  // El 15 del celular despues de la caracteristica: 11 15 2345 6789.
  const sin15 = /^(\d{2,4})15(\d{6,8})$/.exec(d);
  if (sin15 && sin15[1]!.length + sin15[2]!.length === 10) d = sin15[1]! + sin15[2]!;
  if (d.length === 10) d = `549${d}`;
  else if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) d = `549${d.slice(2)}`;
  return d.length >= 11 && d.length <= 15 ? d : undefined;
}

const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Resultado =
  | { ok: true; evento?: number }
  | { ok: false; status: 400 | 404 | 429; code: string };

/** Cuantos envios deja por IP en la ventana; alcanza para equivocarse y reenviar. */
export const ENVIOS_POR_IP = 5;
export const VENTANA_DE_IP_MS = 10 * 60_000;

export class TopePorIp {
  private vistos = new Map<string, number[]>();
  constructor(private max = ENVIOS_POR_IP, private ventanaMs = VENTANA_DE_IP_MS) {}

  /** True si este envio entra; lo anota. */
  pasa(ip: string, ahora: number): boolean {
    const recientes = (this.vistos.get(ip) ?? []).filter((t) => ahora - t < this.ventanaMs);
    if (recientes.length >= this.max) {
      this.vistos.set(ip, recientes);
      return false;
    }
    recientes.push(ahora);
    this.vistos.set(ip, recientes);
    // Que el mapa no crezca sin fin con IPs que ya no vuelven.
    if (this.vistos.size > 5000) {
      for (const [k, v] of this.vistos) if (!v.some((t) => ahora - t < this.ventanaMs)) this.vistos.delete(k);
    }
    return true;
  }
}

export async function recibirFormulario(ctx: Contexto, cfg: ConfigDeFormulario, cuerpo: unknown): Promise<Resultado> {
  const r = Formulario.safeParse(cuerpo);
  if (!r.success) return { ok: false, status: 400, code: 'formulario_invalido' };
  const f = r.data;
  // Al bot que lleno la trampa se le dice que si, y no se hace nada.
  if (f.sitio?.trim()) return { ok: true };

  const whatsapp = telefonoDeWhatsapp(f.whatsapp);
  const mail = f.mail && MAIL.test(f.mail) ? f.mail.toLowerCase() : undefined;
  if (!whatsapp && !mail) return { ok: false, status: 400, code: 'falta_contacto' };

  const negocio = await ctx.store.negocio(cfg.negocioId);
  if (!negocio) return { ok: false, status: 404, code: 'no_existe' };
  const evento = await emitir(ctx, negocio, 'formulario', {
    nombre: f.nombre,
    negocio: f.negocio || null,
    whatsapp: whatsapp ?? null,
    mail: mail ?? null,
    tema: f.tema || null,
    mensaje: f.mensaje || null,
    // Sin numero valido no hay a quien escribirle, aunque haya tildado.
    acepta_whatsapp: Boolean(f.acepta_whatsapp && whatsapp),
  });
  return { ok: true, evento: evento?.id };
}
