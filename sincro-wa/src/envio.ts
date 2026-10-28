import { alertar } from './alertas.js';
import { categoriasPermitidas } from './capacidades.js';
import { tokenDe, type Contexto } from './contexto.js';
import { DIA_MS, diaDe } from './horas.js';
import { emitir } from './eventos.js';
import { ErrorDeMeta, esTokenCaido, type Interactivo } from './meta.js';
import { gastoDelMes, precioDe, revisarTopeDeGasto, ventanaAbierta } from './reglas.js';
import type { Canal, CategoriaDeMensaje, ContenidoDeMensaje, Mensaje, Negocio, NuevoMensaje, Numero } from './store.js';
import { textoDeError } from './tapar.js';

/**
 * Todo lo que sale por WhatsApp pasa por aca, sea de una app, de la IA o del
 * propio bot (la respuesta a una baja). Aca se controlan bajas, ventana y
 * topes; las rutas solo traducen los rechazos a HTTP.
 */

/** Un envio que no sale, con el status y el codigo que ve la app. */
export class Rechazo extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detalle?: string,
  ) {
    super(code);
    this.name = 'Rechazo';
  }
}

/**
 * Desde que numero del negocio se le escribe a un contacto: el ultimo por el
 * que escribio el; si nunca escribio, el primero del negocio. Una app nunca
 * elige el numero, asi que no puede mandar desde el de otro negocio.
 */
export async function numeroPara(ctx: Contexto, negocioId: number, contacto: string, canal: Canal = 'whatsapp'): Promise<Numero> {
  const numeros = (await ctx.store.numerosDe(negocioId)).filter((n) => n.canal === canal);
  if (!numeros.length) throw new Rechazo(409, 'sin_numero');
  const charlas = (await ctx.store.contactosDe(negocioId, contacto))
    .filter((c) => c.ultimaEntrada && numeros.some((n) => n.id === c.numeroId))
    .sort((a, b) => b.ultimaEntrada!.getTime() - a.ultimaEntrada!.getTime());
  return numeros.find((n) => n.id === charlas[0]?.numeroId) ?? numeros[0]!;
}

async function guardarSaliente(ctx: Contexto, m: Omit<NuevoMensaje, 'direccion' | 'fecha' | 'referral'>): Promise<Mensaje> {
  const guardado = await ctx.store.guardarMensaje({ ...m, direccion: 'sale', referral: null, fecha: ctx.ahora() });
  if (!guardado) throw new Error(`wamid repetido al guardar un saliente: ${m.wamid}`);
  return guardado;
}

/**
 * Meta invalido el token (190): se frenan los envios de ese numero, se avisa a Gero (alerta de admin, que
 * Homero manda por Telegram) y a la app del negocio (evento `conexion`, para que avise a la empresa por mail
 * y muestre "Reconectar Meta"). Una sola vez por caida. Lo que entra sigue entrando.
 */
export async function marcarTokenCaido(ctx: Contexto, numeroId: number, detalle: string): Promise<void> {
  const numero = await ctx.store.numero(numeroId);
  if (!numero || numero.tokenCaido) return;
  await ctx.store.cambiarNumero(numero.id, { tokenCaido: true });
  const negocio = await ctx.store.negocio(numero.negocioId);
  await alertar(ctx, {
    negocioId: numero.negocioId,
    tipo: 'token_caido',
    texto: `Meta invalidó el token del número ${numero.phoneNumberId} (${negocio?.nombre ?? '?'}): se frenaron los envíos. Hay que reconectarlo. ${detalle}`,
  });
  if (negocio) await emitir(ctx, negocio, 'conexion', { estado: 'token_caido', numero: numero.phoneNumberId });
}

/** Meta no lo acepto: queda registrado el intento y la app recibe el error tapado. */
async function fallaDeMeta(ctx: Contexto, e: unknown, base: Omit<NuevoMensaje, 'direccion' | 'fecha' | 'referral' | 'wamid'>): Promise<never> {
  if (!(e instanceof ErrorDeMeta)) throw e;
  if (esTokenCaido(e)) await marcarTokenCaido(ctx, base.numeroId, e.message);
  await guardarSaliente(ctx, { ...base, wamid: null, estado: 'failed', error: { codigo: 'meta', detalle: e.message } });
  throw new Rechazo(502, 'meta', e.message);
}

/**
 * Texto libre: es servicio (gratis) y solo dentro de la ventana de 24 h.
 * `saltearBaja` lo usa solo la respuesta a la baja misma.
 */
export async function enviarTexto(
  ctx: Contexto,
  negocio: Negocio,
  numero: Numero,
  a: string,
  texto: string,
  opciones: { saltearBaja?: boolean; interactivo?: Interactivo } = {},
): Promise<Mensaje> {
  const { interactivo } = opciones;
  // Instagram y Messenger no tienen botones de este tipo: mejor rechazarlo que mandarlo sin ellos.
  if (interactivo && numero.canal !== 'whatsapp') throw new Rechazo(400, 'sin_botones_en_canal');
  const contacto = await ctx.store.contacto(numero.id, a);
  if (contacto?.baja && !opciones.saltearBaja) throw new Rechazo(409, 'baja');
  if (numero.tokenCaido) throw new Rechazo(409, 'token_caido');
  if (!ventanaAbierta(contacto, ctx.ahora())) throw new Rechazo(409, 'fuera_de_ventana');
  const base = {
    negocioId: negocio.id,
    numeroId: numero.id,
    contacto: a,
    tipo: interactivo ? 'interactive' : 'text',
    // Los botones van como renglones para que la pantalla Charlas los muestre.
    texto: interactivo ? `${texto}\n${renglonesDe(interactivo)}` : texto,
    mediaId: null,
    plantilla: null,
    categoria: 'service' as const,
    costoEstimado: 0,
    costoReal: null,
    estado: null,
    error: null,
    contenido: { cuerpo: texto, ...(interactivo ?? {}) } satisfies ContenidoDeMensaje,
  };
  let wamid: string;
  try {
    ({ wamid } = interactivo
      ? await ctx.meta.enviarInteractivo(tokenDe(ctx, numero), numero.phoneNumberId, a, texto, interactivo)
      : numero.canal === 'whatsapp'
        ? await ctx.meta.enviarTexto(tokenDe(ctx, numero), numero.phoneNumberId, a, texto)
        : await ctx.meta.enviarMensajeria(tokenDe(ctx, numero), numero.phoneNumberId, a, texto));
  } catch (e) {
    return fallaDeMeta(ctx, e, base);
  }
  return guardarSaliente(ctx, { ...base, wamid, estado: 'aceptado' });
}

function renglonesDe(i: Interactivo): string {
  return 'botones' in i ? i.botones.map((b) => `[${b}]`).join('\n') : `[${i.link.texto} → ${i.link.url}]`;
}

/** Lo que manda el bot por su cuenta (baja, factura cargada, IA). Si no sale, se loguea y sigue. */
export async function responder(
  ctx: Contexto,
  negocio: Negocio,
  numero: Numero,
  a: string,
  texto: string,
  opciones: { saltearBaja?: boolean } = {},
): Promise<Mensaje | undefined> {
  try {
    return await enviarTexto(ctx, negocio, numero, a, texto, opciones);
  } catch (e) {
    ctx.log(`no se pudo contestar a ${a} (${negocio.nombre}): ${e instanceof Rechazo ? e.code : textoDeError(e)}`);
    return undefined;
  }
}

export interface PedidoDeAviso {
  a: string;
  plantilla: string;
  idioma: string;
  variables: string[];
}

/** Una plantilla. Los controles van en el orden del contrato, cada uno con su codigo. */
export async function enviarAviso(ctx: Contexto, negocio: Negocio, p: PedidoDeAviso): Promise<{ mensaje: Mensaje; costoEstimado: number }> {
  const plantilla = await ctx.store.plantilla(negocio.id, p.plantilla, p.idioma);
  if (!plantilla || plantilla.estado !== 'APPROVED') throw new Rechazo(409, 'plantilla_no_aprobada');
  // Una plantilla de una categoria que la app no tiene "no existe" para ella.
  if (plantilla.bloqueada || !categoriasPermitidas(negocio.capacidades).has(plantilla.categoria)) {
    throw new Rechazo(404, 'no_existe');
  }

  const numero = await numeroPara(ctx, negocio.id, p.a);
  const contacto = await ctx.store.contacto(numero.id, p.a);
  if (contacto?.baja) throw new Rechazo(409, 'baja');
  if (numero.tokenCaido) throw new Rechazo(409, 'token_caido');

  const ahora = ctx.ahora();
  const usados = numero.topeMeta === null ? 0 : await usoDelTopeMeta(ctx, numero, p.a, ahora);
  if (numero.topeMeta !== null && usados > numero.topeMeta) throw new Rechazo(429, 'tope_meta');

  // Una de utilidad dentro de la ventana no se cobra; las demas, segun la tabla.
  const categoria = plantilla.categoria.toLowerCase() as CategoriaDeMensaje;
  const costoEstimado =
    categoria === 'utility' && ventanaAbierta(contacto, ahora) ? 0 : ((await precioDe(ctx, categoria)) ?? 0);
  if (costoEstimado > 0) {
    const gasto = await gastoDelMes(ctx, negocio.id);
    if (gasto.totalArs >= negocio.topeMensualArs) throw new Rechazo(402, 'tope_alcanzado');
  }

  const base = {
    negocioId: negocio.id,
    numeroId: numero.id,
    contacto: p.a,
    tipo: 'template',
    texto: p.variables.length ? p.variables.join(' | ') : null,
    contenido: contenidoDePlantilla(plantilla.componentes, p.variables),
    mediaId: null,
    plantilla: plantilla.nombre,
    categoria,
    costoEstimado,
    costoReal: null,
    estado: null,
    error: null,
  };
  let wamid: string;
  try {
    ({ wamid } = await ctx.meta.enviarPlantilla(tokenDe(ctx, numero), numero.phoneNumberId, p.a, {
      nombre: plantilla.nombre,
      idioma: plantilla.idioma,
      variables: p.variables,
    }));
  } catch (e) {
    return fallaDeMeta(ctx, e, { ...base, costoEstimado: 0 });
  }
  const mensaje = await guardarSaliente(ctx, { ...base, wamid, estado: 'aceptado' });

  if (costoEstimado > 0) await revisarTopeDeGasto(ctx, negocio);
  if (numero.topeMeta !== null && usados >= numero.topeMeta * 0.8) {
    await alertar(ctx, {
      clave: `tope_meta:${numero.id}:${diaDe(ahora)}`,
      negocioId: negocio.id,
      tipo: 'tope_meta',
      texto: `El número ${numero.phoneNumberId} de ${negocio.nombre} va por ${usados} de ${numero.topeMeta} contactos con plantilla en 24 h (tope de Meta).`,
    });
  }
  return { mensaje, costoEstimado };
}

/** Reemplaza {{1}}, {{2}}... por las variables; una que falta queda como esta. */
const conVariables = (t: string, vars: string[]) => t.replace(/\{\{(\d+)\}\}/g, (m, n) => vars[Number(n) - 1] ?? m);

/** La plantilla como la ve la persona: encabezado, cuerpo con las variables puestas, pie y botones. */
export function contenidoDePlantilla(componentes: unknown[], variables: string[]): ContenidoDeMensaje | null {
  const cs = componentes.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
  const de = (tipo: string) => cs.find((c) => String(c.type).toUpperCase() === tipo);
  const texto = (c?: Record<string, unknown>) => (typeof c?.text === 'string' ? c.text : undefined);
  const cuerpo = texto(de('BODY'));
  const encabezado = String(de('HEADER')?.format ?? 'TEXT').toUpperCase() === 'TEXT' ? texto(de('HEADER')) : undefined;
  const pie = texto(de('FOOTER'));
  const botones = (Array.isArray(de('BUTTONS')?.buttons) ? (de('BUTTONS')!.buttons as Record<string, unknown>[]) : [])
    .map((b) => (typeof b.text === 'string' ? b.text : undefined))
    .filter((t): t is string => !!t);
  if (!cuerpo) return null;
  return {
    cuerpo: conVariables(cuerpo, variables),
    ...(encabezado ? { encabezado } : {}),
    ...(pie ? { pie } : {}),
    ...(botones.length ? { botones } : {}),
  };
}

/** Contactos distintos con plantilla en las ultimas 24 h, contando a este. */
async function usoDelTopeMeta(ctx: Contexto, numero: Numero, a: string, ahora: Date): Promise<number> {
  const distintos = await ctx.store.contactosConPlantilla(numero.id, new Date(ahora.getTime() - DIA_MS));
  return distintos.length + (distintos.includes(a) ? 0 : 1);
}
