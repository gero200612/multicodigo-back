import { alertar } from './alertas.js';
import { tokenDe, type Contexto } from './contexto.js';
import { reintentarPushes } from './eventos.js';
import { DIA_MS, HORA_MS } from './horas.js';
import { topeDeTier } from './meta.js';
import type { Numero } from './store.js';
import { textoDeError } from './tapar.js';

/**
 * Lo que corre solo, cada tanto. Cada tarea es una funcion suelta para que los
 * tests la llamen con el reloj que quieran; `arrancarTareas` solo las agenda.
 */

const CALIDAD_MALA = new Set(['YELLOW', 'RED']);

/** Pide a Meta calidad, tier, estado y nombre del numero. Alerta si la calidad baja. */
export async function refrescarNumero(ctx: Contexto, numero: Numero): Promise<void> {
  const datos = await ctx.meta.datosDelNumero(tokenDe(ctx, numero), numero.phoneNumberId);
  const calidad = datos.quality_rating ?? numero.calidad;
  const tope = topeDeTier(datos.messaging_limit_tier);
  await ctx.store.cambiarNumero(numero.id, {
    calidad,
    ...(tope !== undefined ? { topeMeta: tope } : {}),
    estado: datos.status ?? numero.estado,
    nombreVerificado: datos.verified_name ?? numero.nombreVerificado,
  });
  if (calidad && calidad !== numero.calidad && CALIDAD_MALA.has(calidad)) {
    const negocio = await ctx.store.negocio(numero.negocioId);
    await alertar(ctx, {
      negocioId: numero.negocioId,
      tipo: 'calidad',
      texto: `La calidad del número ${numero.phoneNumberId} (${negocio?.nombre ?? '?'}) bajó a ${calidad === 'RED' ? 'roja' : 'amarilla'}.`,
    });
  }
}

export async function revisarCalidad(ctx: Contexto): Promise<void> {
  for (const n of await ctx.store.todosLosNumeros()) {
    try {
      await refrescarNumero(ctx, n);
    } catch (e) {
      ctx.log(`calidad de ${n.phoneNumberId}: ${textoDeError(e)}`);
    }
  }
}

// Un numero con movimiento (20 eventos en la semana) que se queda 6 h sin
// nada probablemente perdio el webhook: Meta lo desuscribio o vencio el token.
const MOVIMIENTO_MINIMO = 20;
const SILENCIO_MS = 6 * HORA_MS;

export async function revisarSilencio(ctx: Contexto): Promise<void> {
  const ahora = ctx.ahora().getTime();
  for (const n of await ctx.store.todosLosNumeros()) {
    if (n.sinMensajesAlertado) continue;
    if ((await ctx.store.contarWebhooks(n.id, new Date(ahora - 7 * DIA_MS))) < MOVIMIENTO_MINIMO) continue;
    if ((await ctx.store.contarWebhooks(n.id, new Date(ahora - SILENCIO_MS))) > 0) continue;
    const negocio = await ctx.store.negocio(n.negocioId);
    await ctx.store.cambiarNumero(n.id, { sinMensajesAlertado: true });
    await alertar(ctx, {
      negocioId: n.negocioId,
      tipo: 'sin_mensajes',
      texto: `No llegan mensajes de Meta hace 6 h al número ${n.phoneNumberId} (${negocio?.nombre ?? '?'}). Revisar el webhook y el token.`,
    });
  }
}

const MEDIA_DURA_MS = 30 * DIA_MS;
const WEBHOOKS_DURAN_MS = 8 * DIA_MS;

export async function limpiar(ctx: Contexto): Promise<void> {
  const ahora = ctx.ahora().getTime();
  const media = await ctx.store.borrarMediaVieja(new Date(ahora - MEDIA_DURA_MS));
  await ctx.store.borrarWebhooksViejos(new Date(ahora - WEBHOOKS_DURAN_MS));
  if (media) ctx.log(`media: ${media} archivos de más de 30 días borrados`);
}

export async function liberarIa(ctx: Contexto): Promise<void> {
  const n = await ctx.store.liberarTrabajosVencidos(ctx.ahora());
  if (n) {
    ctx.log(`ia: ${n} trabajos tomados sin resultado vuelven a pendientes`);
    ctx.despertador.despertar('ia');
  }
}

/** Agenda todo. Devuelve con que pararlo (para cerrar prolijo). */
export function arrancarTareas(ctx: Contexto): () => void {
  const cada = (ms: number, nombre: string, f: (c: Contexto) => Promise<void>) => {
    let corriendo = false;
    return setInterval(() => {
      // Si una vuelta tarda mas que el intervalo, la siguiente no se pisa.
      if (corriendo) return;
      corriendo = true;
      f(ctx)
        .catch((e) => ctx.log(`${nombre}: ${textoDeError(e)}`))
        .finally(() => (corriendo = false));
    }, ms);
  };
  const relojes = [
    cada(30 * 60_000, 'calidad', revisarCalidad),
    cada(15 * 60_000, 'silencio', revisarSilencio),
    cada(HORA_MS, 'limpieza', limpiar),
    cada(15_000, 'push', reintentarPushes),
    cada(60_000, 'ia', liberarIa),
  ];
  return () => relojes.forEach(clearInterval);
}
