import { alertar } from './alertas.js';
import type { Contexto } from './contexto.js';
import { DIA_MS, mesDe, rangoDelMes } from './horas.js';
import type { Contacto, Negocio } from './store.js';

/**
 * Las reglas comunes a todas las capacidades: bajas, ventana de 24 h, costos y
 * topes. Ninguna app las puede saltear porque viven aca y no en la app.
 */

// "Como mensaje completo o casi": "baja" o "no me escriban mas" si, pero no un
// parrafo que de casualidad dice "stop" en el medio.
const LARGO_MAXIMO_DE_BAJA = 60;
const BAJA = /baja|stop|no me escrib|no me manden|no quiero (mas|más) mensajes|dej(a|á) de escrib|desuscrib/i;
const ALTA = /^\s*alta\s*[.!¡]*\s*$/i;

export const TEXTO_DE_BAJA = 'Listo, no te vamos a escribir más. Si querés volver, escribí ALTA.';
export const TEXTO_DE_ALTA = 'Listo, ya te podemos volver a escribir.';

export function esBaja(texto: string | null): boolean {
  if (!texto) return false;
  const t = texto.trim();
  return t.length <= LARGO_MAXIMO_DE_BAJA && BAJA.test(t);
}

export function esAlta(texto: string | null): boolean {
  return !!texto && ALTA.test(texto);
}

export const VENTANA_MS = DIA_MS;

/** La ventana de 24 h de Meta: se abre con cada mensaje entrante. */
export function ventanaAbierta(contacto: Pick<Contacto, 'ultimaEntrada'> | undefined, ahora: Date): boolean {
  return !!contacto?.ultimaEntrada && ahora.getTime() - contacto.ultimaEntrada.getTime() < VENTANA_MS;
}

export async function precioDe(ctx: Contexto, categoria: string): Promise<number | undefined> {
  return (await ctx.store.precios()).find((p) => p.categoria === categoria.toLowerCase())?.precioArs;
}

export interface Gasto {
  metaArs: number;
  iaUsd: number;
  iaArs: number;
  totalArs: number;
  /** Null si todavia nadie cargo el dolar: la IA cuenta 0 en pesos. */
  dolar: number | null;
}

export async function gastoDelMes(ctx: Contexto, negocioId: number, mes = mesDe(ctx.ahora())): Promise<Gasto> {
  const { desde, hasta } = rangoDelMes(mes);
  const { metaArs, iaUsd } = await ctx.store.costosDelPeriodo(negocioId, desde, hasta);
  const dolar = (await ctx.store.dolar()) ?? null;
  const iaArs = iaUsd * (dolar ?? 0);
  return { metaArs, iaUsd, iaArs, totalArs: metaArs + iaArs, dolar };
}

export function porcentaje(gasto: number, tope: number): number {
  return tope > 0 ? Math.round((gasto / tope) * 1000) / 10 : 0;
}

export function pesos(n: number): string {
  return `$${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
}

const UMBRALES = [80, 100] as const;

/** Alerta al cruzar 80 % y 100 % del tope, una vez por umbral y mes. */
export async function revisarTopeDeGasto(ctx: Contexto, negocio: Negocio): Promise<void> {
  const mes = mesDe(ctx.ahora());
  const gasto = await gastoDelMes(ctx, negocio.id, mes);
  const pct = porcentaje(gasto.totalArs, negocio.topeMensualArs);
  for (const umbral of UMBRALES) {
    if (pct < umbral) continue;
    await alertar(ctx, {
      clave: `tope:${negocio.id}:${mes}:${umbral}`,
      negocioId: negocio.id,
      tipo: `tope_${umbral}`,
      // Lista para Telegram: Homero la manda tal cual.
      texto:
        `${negocio.nombre} llegó al ${umbral} % del tope de gasto del mes (${pesos(gasto.totalArs)} de ${pesos(negocio.topeMensualArs)})` +
        (umbral === 100 ? '. Frené lo que se paga; lo gratis sigue.' : ''),
    });
  }
}

// Lo que cobra la IA, estimado: chars/4 tokens a USD 3 / MTok de entrada y
// USD 15 / MTok de salida. Es control nuestro, no la factura.
const USD_POR_TOKEN_ENTRADA = 3 / 1_000_000;
const USD_POR_TOKEN_SALIDA = 15 / 1_000_000;

export function costoDeIa(charsEntrada: number, charsSalida: number): { tokensEntrada: number; tokensSalida: number; costoUsd: number } {
  const tokensEntrada = Math.ceil(Math.max(0, charsEntrada) / 4);
  const tokensSalida = Math.ceil(Math.max(0, charsSalida) / 4);
  return { tokensEntrada, tokensSalida, costoUsd: tokensEntrada * USD_POR_TOKEN_ENTRADA + tokensSalida * USD_POR_TOKEN_SALIDA };
}
