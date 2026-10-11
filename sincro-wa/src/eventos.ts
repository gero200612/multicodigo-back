import { createHmac } from 'node:crypto';
import { alertar } from './alertas.js';
import { recibeEvento, type TipoDeEvento } from './capacidades.js';
import { descifrar } from './cifrado.js';
import type { Contexto } from './contexto.js';
import { HORA_MS } from './horas.js';
import type { Evento, Negocio } from './store.js';
import { textoDeError } from './tapar.js';

/**
 * La bandeja de salida hacia las apps (y hacia Homero, para las alertas).
 *
 * Todo evento se guarda primero y despues se entrega: por long-poll
 * (`GET /eventos`) y, si la app tiene `url_base`, tambien por push. Lo que
 * llegue primero cuenta como entregado. Asi una app caida no pierde nada.
 */

/** Despierta a los long-polls que esperan una clave (`n:3`, `admin`, `ia`). */
export class Despertador {
  private readonly esperando = new Map<string, Set<() => void>>();

  esperar(clave: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.esperando.get(clave) ?? new Set();
      this.esperando.set(clave, set);
      const listo = () => {
        clearTimeout(reloj);
        set.delete(listo);
        if (!set.size) this.esperando.delete(clave);
        resolve();
      };
      const reloj = setTimeout(listo, ms);
      set.add(listo);
    });
  }

  despertar(clave: string): void {
    for (const f of [...(this.esperando.get(clave) ?? [])]) f();
  }
}

const claveDe = (negocioId: number | null) => (negocioId === null ? 'admin' : `n:${negocioId}`);

const ESPERA_INICIAL_MS = 30_000;
const REINTENTOS_DURANTE_MS = HORA_MS;
export const EVENTOS_POR_PEDIDO = 50;
export const ESPERA_MAXIMA_S = 30;

/**
 * Le manda un evento a la app del negocio. Si sus capacidades no lo reciben,
 * no se guarda: un taller con solo `facturas` no tiene por que enterarse de
 * una charla.
 */
export async function emitir(
  ctx: Contexto,
  negocio: Negocio,
  tipo: TipoDeEvento,
  datos: Record<string, unknown>,
): Promise<Evento | undefined> {
  if (!recibeEvento(negocio.capacidades, tipo)) return undefined;
  const evento = await ctx.store.crearEvento(negocio.id, tipo, datos, ctx.ahora());
  ctx.despertador.despertar(claveDe(negocio.id));
  if (negocio.urlBase) {
    // El primer push sale ya; si falla, lo levanta `reintentarPushes`. El
    // proximo intento queda adelante para que los dos no salgan juntos.
    const proximoIntento = new Date(evento.fecha.getTime() + ESPERA_INICIAL_MS);
    await ctx.store.cambiarEvento(evento.id, { proximoIntento });
    void intentarPush(ctx, negocio, { ...evento, proximoIntento }).catch((e) => ctx.log(`push: ${textoDeError(e)}`));
  }
  return evento;
}

export async function emitirAdmin(ctx: Contexto, datos: Record<string, unknown>): Promise<void> {
  await ctx.store.crearEvento(null, 'alerta', datos, ctx.ahora());
  ctx.despertador.despertar('admin');
}

export function cuerpoDeEvento(e: Evento): { id: number; tipo: string; fecha: string; datos: Record<string, unknown> } {
  return { id: e.id, tipo: e.tipo, fecha: e.fecha.toISOString(), datos: e.datos };
}

/** Long-poll: devuelve apenas hay algo, o `[]` al cumplirse la espera. */
export async function esperarEventos(ctx: Contexto, negocioId: number | null, segundos: number): Promise<Evento[]> {
  const ya = await ctx.store.eventosPendientes(negocioId, EVENTOS_POR_PEDIDO);
  if (ya.length || segundos <= 0) return ya;
  await ctx.despertador.esperar(claveDe(negocioId), Math.min(segundos, ESPERA_MAXIMA_S) * 1000);
  return ctx.store.eventosPendientes(negocioId, EVENTOS_POR_PEDIDO);
}

export function firmar(secreto: string, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
}

async function intentarPush(ctx: Contexto, negocio: Negocio, evento: Evento): Promise<void> {
  if (!negocio.urlBase) return;
  const cuerpo = JSON.stringify(cuerpoDeEvento(evento));
  const secreto = descifrar(ctx.claveCifrado, negocio.secretoEventos);
  const url = `${negocio.urlBase.replace(/\/$/, '')}/bot/${evento.tipo}`;
  if (await ctx.push(url, cuerpo, firmar(secreto, cuerpo))) {
    await ctx.store.cambiarEvento(evento.id, { entregado: true });
    return;
  }
  const intentos = evento.intentos + 1;
  const ahora = ctx.ahora();
  if (ahora.getTime() - evento.fecha.getTime() >= REINTENTOS_DURANTE_MS) {
    // Despues de una hora deja de insistir: el evento queda para GET /eventos.
    await ctx.store.cambiarEvento(evento.id, { intentos, alertado: true });
    await alertar(ctx, {
      // Una por negocio y hora: si la app se cae con 200 eventos en cola, una alerta.
      clave: `app_caida:${negocio.id}:${ahora.toISOString().slice(0, 13)}`,
      negocioId: negocio.id,
      tipo: 'app_caida',
      texto: `La app de ${negocio.nombre} no recibe eventos hace más de 1 h (${url}). Quedan para GET /eventos.`,
    });
    return;
  }
  // 30 s, 1, 2, 4, 8, 16, 32 min...
  const espera = ESPERA_INICIAL_MS * 2 ** (intentos - 1);
  await ctx.store.cambiarEvento(evento.id, { intentos, proximoIntento: new Date(ahora.getTime() + espera) });
}

export async function reintentarPushes(ctx: Contexto): Promise<void> {
  const eventos = await ctx.store.eventosParaPush(ctx.ahora());
  const negocios = new Map<number, Negocio | undefined>();
  for (const e of eventos) {
    if (e.negocioId === null) continue;
    if (!negocios.has(e.negocioId)) negocios.set(e.negocioId, await ctx.store.negocio(e.negocioId));
    const negocio = negocios.get(e.negocioId);
    if (!negocio?.activo) continue;
    await intentarPush(ctx, negocio, e);
  }
}
