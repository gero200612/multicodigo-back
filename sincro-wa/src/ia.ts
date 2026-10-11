import { z } from 'zod';
import type { Contexto } from './contexto.js';
import { emitir } from './eventos.js';
import { Rechazo, responder } from './envio.js';
import { costoDeIa } from './reglas.js';
import type { Negocio, Numero, TrabajoIa } from './store.js';

/**
 * La IA la corre Homero, no el bot.
 *
 * Homero ya tiene el fondo comun de cuentas de Claude; el bot no tiene cuentas
 * propias. Asi que el bot deja trabajos en una cola, Homero los toma con
 * `GET /admin/ia/pendientes`, los corre y devuelve el resultado. Lo que hace
 * con ese resultado (contestar, avisar a la app) es del bot: ahi estan las
 * reglas de bajas y ventana.
 */

const TOMADA_MS = 10 * 60_000;
const TRABAJOS_POR_PEDIDO = 10;
const ESPERA_MAXIMA_S = 30;
/** Lo que ve la IA de una charla para contestar. */
export const MENSAJES_DE_CONTEXTO = 20;

export const TEXTO_FACTURA_PDF = 'Por ahora leo fotos o capturas: mandame una foto de la factura.';
export const TEXTO_NO_ES_FACTURA = 'Eso no parece una factura. Mandame una foto de la factura y la cargo.';
export const TEXTO_FACTURA_ILEGIBLE = 'No la pude leer, ¿me la mandás de nuevo más nítida?';

export async function encolar(
  ctx: Contexto,
  negocio: Negocio,
  numero: Numero,
  contacto: string,
  tipo: TrabajoIa['tipo'],
  entrada: Record<string, unknown>,
): Promise<void> {
  // Si la persona manda tres mensajes seguidos, la IA contesta una vez con la
  // charla entera, no tres veces.
  const ya = tipo === 'atender' ? await ctx.store.trabajoPendiente(numero.id, contacto, tipo) : undefined;
  if (ya) await ctx.store.cambiarTrabajo(ya.id, { entrada });
  else await ctx.store.crearTrabajo({ negocioId: negocio.id, numeroId: numero.id, contacto, tipo, entrada, creado: ctx.ahora() });
  ctx.despertador.despertar('ia');
}

/** Long-poll de Homero: toma hasta 10 y los reserva 10 minutos. */
export async function tomarPendientes(ctx: Contexto, segundos: number): Promise<TrabajoIa[]> {
  const tomar = () => {
    const ahora = ctx.ahora();
    return ctx.store.tomarTrabajos(ahora, new Date(ahora.getTime() + TOMADA_MS), TRABAJOS_POR_PEDIDO);
  };
  const ya = await tomar();
  if (ya.length || segundos <= 0) return ya;
  await ctx.despertador.esperar('ia', Math.min(segundos, ESPERA_MAXIMA_S) * 1000);
  return tomar();
}

const DatosDeFactura = z
  .object({
    proveedor: z.string().nullish(),
    cuit: z.string().nullish(),
    numero: z.string().nullish(),
    fecha: z.string().nullish(),
    vencimiento: z.string().nullish(),
    total: z.number().nullish(),
    moneda: z.string().nullish(),
    impuestos: z.array(z.object({ nombre: z.string(), monto: z.number() })).nullish(),
  })
  .passthrough();
export type DatosDeFactura = z.infer<typeof DatosDeFactura>;

const SalidaDeFactura = z.object({
  es_factura: z.boolean(),
  datos: DatosDeFactura.nullish(),
  falta: z.array(z.string()).nullish(),
});

const SalidaDeAtender = z.object({
  respuesta: z.string().nullish(),
  derivar: z.boolean().nullish(),
  motivo: z.string().nullish(),
});

export const Resultado = z.union([
  z.object({
    ok: z.literal(true),
    salida: z.record(z.unknown()),
    modelo: z.string().min(1).max(100),
    chars_entrada: z.number().int().min(0),
    chars_salida: z.number().int().min(0),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
]);
export type Resultado = z.infer<typeof Resultado>;

const NOMBRES: Record<string, string> = {
  proveedor: 'el proveedor',
  cuit: 'el CUIT',
  numero: 'el número',
  fecha: 'la fecha',
  vencimiento: 'el vencimiento',
  total: 'el total',
  moneda: 'la moneda',
  impuestos: 'los impuestos',
};

function lista(cosas: string[]): string {
  return cosas.length <= 1 ? (cosas[0] ?? '') : `${cosas.slice(0, -1).join(', ')} y ${cosas.at(-1)}`;
}

/** `2026-10-18` → `18/10`. Si viene en otro formato, tal cual. */
function diaYMes(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  return m ? `${m[3]}/${m[2]}` : fecha;
}

/** Lo que se le contesta a quien mando la factura. */
export function textoDeFactura(salida: z.infer<typeof SalidaDeFactura>): string {
  if (!salida.es_factura) return TEXTO_NO_ES_FACTURA;
  const falta = salida.falta ?? [];
  if (falta.length) {
    return `No llego a leer ${lista(falta.map((f) => NOMBRES[f] ?? f))}. ¿Me mandás otra foto donde se vea bien?`;
  }
  const d = salida.datos ?? {};
  const partes = [`Cargada: ${d.proveedor || 'la factura'}`];
  if (typeof d.total === 'number') partes.push(`$${d.total.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);
  if (d.vencimiento) partes.push(`vence el ${diaYMes(d.vencimiento)}`);
  return partes.join(', ');
}

/** Lo que devolvio Homero. Contesta por WhatsApp y le avisa a la app. */
export async function registrarResultado(ctx: Contexto, id: number, r: Resultado): Promise<void> {
  const t = await ctx.store.trabajo(id);
  if (!t) throw new Rechazo(404, 'no_existe');
  if (t.estado === 'lista' || t.estado === 'fallida') throw new Rechazo(409, 'ya_resuelta');
  const negocio = await ctx.store.negocio(t.negocioId);
  const numero = await ctx.store.numero(t.numeroId);
  if (!negocio || !numero) throw new Rechazo(404, 'no_existe');

  if (!r.ok) {
    await ctx.store.cambiarTrabajo(id, { estado: 'fallida', error: r.error });
    if (t.tipo === 'factura') await responder(ctx, negocio, numero, t.contacto, TEXTO_FACTURA_ILEGIBLE);
    else await derivar(ctx, negocio, numero, t.contacto, 'la IA no pudo contestar');
    return;
  }

  const costo = costoDeIa(r.chars_entrada, r.chars_salida);
  await ctx.store.registrarUsoIa({
    negocioId: negocio.id,
    capacidad: t.tipo === 'factura' ? 'facturas' : 'atender',
    modelo: r.modelo,
    ...costo,
    fecha: ctx.ahora(),
  });

  if (t.tipo === 'factura') {
    const salida = SalidaDeFactura.safeParse(r.salida);
    if (!salida.success) throw new Rechazo(400, 'salida_invalida', salida.error.issues[0]?.message);
    await ctx.store.cambiarTrabajo(id, { estado: 'lista', resultado: r.salida });
    await responder(ctx, negocio, numero, t.contacto, textoDeFactura(salida.data));
    if (salida.data.es_factura && !salida.data.falta?.length) {
      await emitir(ctx, negocio, 'factura', {
        contacto: t.contacto,
        media_id: t.entrada.media_id ?? null,
        datos: salida.data.datos ?? {},
      });
    }
    return;
  }

  const salida = SalidaDeAtender.safeParse(r.salida);
  if (!salida.success) throw new Rechazo(400, 'salida_invalida', salida.error.issues[0]?.message);
  await ctx.store.cambiarTrabajo(id, { estado: 'lista', resultado: r.salida });
  // Puede contestar Y derivar ("te paso con alguien del equipo").
  if (salida.data.respuesta?.trim()) await responder(ctx, negocio, numero, t.contacto, salida.data.respuesta.trim());
  if (salida.data.derivar) await derivar(ctx, negocio, numero, t.contacto, salida.data.motivo || 'pidió hablar con alguien');
}

/** La IA deja de contestar en esa charla hasta que la app la libere. */
async function derivar(ctx: Contexto, negocio: Negocio, numero: Numero, contacto: string, motivo: string): Promise<void> {
  await ctx.store.cambiarContacto(numero.id, contacto, { derivada: true });
  await emitir(ctx, negocio, 'derivar', { contacto, motivo });
}
