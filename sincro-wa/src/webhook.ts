import { createHmac, timingSafeEqual } from 'node:crypto';
import { alertar } from './alertas.js';
import { categoriasPermitidas, tiene, type CategoriaDePlantilla } from './capacidades.js';
import { tokenDe, type Contexto } from './contexto.js';
import { emitir } from './eventos.js';
import { responder } from './envio.js';
import { encolar, MENSAJES_DE_CONTEXTO, TEXTO_FACTURA_ILEGIBLE, TEXTO_FACTURA_PDF } from './ia.js';
import { esAlta, esBaja, precioDe, revisarTopeDeGasto, TEXTO_DE_ALTA, TEXTO_DE_BAJA } from './reglas.js';
import type { Negocio, Numero } from './store.js';
import { refrescarNumero } from './tareas.js';
import { taparTokens, textoDeError } from './tapar.js';

/**
 * Lo que manda Meta. La firma se verifica sobre el cuerpo CRUDO: si se
 * verificara sobre el JSON re-serializado, cualquier diferencia de espacios o
 * de escapes la romperia (y una firma que "a veces falla" termina apagada).
 */
export function firmaValida(crudo: Buffer, encabezado: string | undefined, secreto: string): boolean {
  if (!encabezado?.startsWith('sha256=')) return false;
  const esperada = createHmac('sha256', secreto).update(crudo).digest();
  const recibida = Buffer.from(encabezado.slice(7), 'hex');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

// Lo que mira el bot de cada pedazo del webhook. Meta manda mucho mas; lo que
// no esta aca se ignora.
type Json = Record<string, any>;

export async function procesarWebhook(ctx: Contexto, cuerpo: Json): Promise<void> {
  if (cuerpo.object !== 'whatsapp_business_account') return;
  for (const entrada of asArray(cuerpo.entry)) {
    const waba = String(entrada.id ?? '');
    for (const cambio of asArray(entrada.changes)) {
      const valor: Json = cambio.value ?? {};
      switch (cambio.field) {
        case 'messages':
          await procesarMensajes(ctx, valor);
          break;
        case 'message_template_status_update':
          await estadoDePlantilla(ctx, waba, valor);
          break;
        case 'template_category_update':
          await categoriaDePlantilla(ctx, waba, valor);
          break;
        case 'phone_number_quality_update':
          // Trae el numero visible, no el phone_number_id: se refrescan los
          // numeros de esa WABA, que es lo que da el dato completo.
          for (const n of await ctx.store.numerosDeWaba(waba)) {
            await refrescarNumero(ctx, n).catch((e) => ctx.log(`calidad de ${n.phoneNumberId}: ${textoDeError(e)}`));
          }
          break;
      }
    }
  }
}

const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

async function procesarMensajes(ctx: Contexto, valor: Json): Promise<void> {
  const phoneNumberId = String(valor.metadata?.phone_number_id ?? '');
  const numero = await ctx.store.numeroPorPhoneId(phoneNumberId);
  if (!numero) {
    ctx.log(`webhook de un número desconocido (${phoneNumberId || 'sin id'}): descartado`);
    return;
  }
  const negocio = await ctx.store.negocio(numero.negocioId);
  if (!negocio?.activo) {
    ctx.log(`webhook del número ${phoneNumberId} de un negocio inactivo: descartado`);
    return;
  }
  await ctx.store.registrarWebhook(numero.id, ctx.ahora());
  if (numero.sinMensajesAlertado) await ctx.store.cambiarNumero(numero.id, { sinMensajesAlertado: false });

  const nombres = new Map<string, string>();
  for (const c of asArray(valor.contacts)) if (c.wa_id && c.profile?.name) nombres.set(String(c.wa_id), String(c.profile.name));
  for (const m of asArray(valor.messages)) await entrante(ctx, negocio, numero, m, nombres.get(String(m.from)) ?? null);
  for (const s of asArray(valor.statuses)) await estadoDeMensaje(ctx, negocio, s);
}

const TIPOS_CON_MEDIA = new Set(['image', 'document', 'audio', 'video', 'sticker']);

function textoDe(m: Json): string | null {
  const t =
    m.text?.body ?? m[m.type]?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
  return typeof t === 'string' ? t : null;
}

async function entrante(ctx: Contexto, negocio: Negocio, numero: Numero, m: Json, nombre: string | null): Promise<void> {
  const contacto = String(m.from ?? '');
  const tipo = String(m.type ?? 'unknown');
  if (!contacto || !m.id) return;
  const texto = textoDe(m);
  const ahora = ctx.ahora();
  const mensaje = await ctx.store.guardarMensaje({
    negocioId: negocio.id,
    numeroId: numero.id,
    contacto,
    direccion: 'entra',
    tipo,
    texto,
    mediaId: null,
    referral: m.referral && typeof m.referral === 'object' ? m.referral : null,
    plantilla: null,
    wamid: String(m.id),
    categoria: null,
    costoEstimado: 0,
    costoReal: null,
    estado: null,
    error: null,
    fecha: ahora,
  });
  // Meta repite webhooks: el wamid ya estaba, ya se proceso.
  if (!mensaje) return;
  const charla = await ctx.store.registrarEntrada(numero.id, negocio.id, contacto, nombre, ahora);

  // Bajas primero: ninguna capacidad ve un "baja" ni un "alta".
  if (tipo === 'text' && charla.baja && esAlta(texto)) {
    await ctx.store.cambiarContacto(numero.id, contacto, { baja: false, bajaDesde: null });
    await responder(ctx, negocio, numero, contacto, TEXTO_DE_ALTA);
    return;
  }
  if (tipo === 'text' && esBaja(texto)) {
    if (!charla.baja) {
      await ctx.store.cambiarContacto(numero.id, contacto, { baja: true, bajaDesde: ahora });
      // Se contesta UNA vez: un segundo "baja" no recibe nada.
      await responder(ctx, negocio, numero, contacto, TEXTO_DE_BAJA, { saltearBaja: true });
    }
    return;
  }

  const media: Json | undefined = TIPOS_CON_MEDIA.has(tipo) ? m[tipo] : undefined;
  const mime = typeof media?.mime_type === 'string' ? media.mime_type : '';
  // Una foto mandada "como documento" sigue siendo una foto.
  const esFoto = tipo === 'image' || (tipo === 'document' && mime.startsWith('image/'));
  const caps = negocio.capacidades;
  const pasaALaApp = tiene(caps, 'leads') || (tiene(caps, 'atender') && charla.derivada);
  const facturas = tiene(caps, 'facturas');

  let mediaId: number | null = null;
  if (media?.id && (pasaALaApp || (facturas && esFoto))) {
    mediaId = await bajarMedia(ctx, negocio, numero, String(media.id));
    if (mediaId !== null) await ctx.store.cambiarMensaje(mensaje.id, { mediaId });
  }

  if (pasaALaApp) {
    await emitir(ctx, negocio, 'mensaje', {
      contacto,
      nombre,
      tipo,
      texto,
      media_id: mediaId,
      referral: mensaje.referral,
      mensaje_id: mensaje.id,
    });
  }

  if (facturas) {
    if (esFoto && mediaId !== null) {
      await encolar(ctx, negocio, numero, contacto, 'factura', { media_id: mediaId, mime: mime || 'image/jpeg' });
    } else if (esFoto) {
      await responder(ctx, negocio, numero, contacto, TEXTO_FACTURA_ILEGIBLE);
    } else if (tipo === 'document') {
      await responder(ctx, negocio, numero, contacto, TEXTO_FACTURA_PDF);
    }
  }

  if (tiene(caps, 'atender') && !charla.derivada && tipo === 'text') {
    const ultimos = await ctx.store.charla(negocio.id, contacto, MENSAJES_DE_CONTEXTO);
    await encolar(ctx, negocio, numero, contacto, 'atender', {
      contexto: negocio.contextoAtender,
      charla: ultimos.filter((x) => x.texto).map((x) => ({ direccion: x.direccion, texto: x.texto })),
      negocio: negocio.nombre,
    });
  }
}

/** Baja el archivo de Meta y lo guarda. Null si no se pudo (queda logueado). */
async function bajarMedia(ctx: Contexto, negocio: Negocio, numero: Numero, idDeMeta: string): Promise<number | null> {
  try {
    const token = tokenDe(ctx, numero);
    const { url, mime } = await ctx.meta.urlDeMedia(token, idDeMeta);
    const datos = await ctx.meta.bajarMedia(token, url);
    return await ctx.store.guardarMedia(negocio.id, mime, datos, ctx.ahora());
  } catch (e) {
    ctx.log(`no se pudo bajar el media ${idDeMeta} (${negocio.nombre}): ${textoDeError(e)}`);
    return null;
  }
}

const ORDEN_DE_ESTADO: Record<string, number> = { aceptado: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Un estado de un mensaje que salio. Idempotente: el mismo estado dos veces,
 * o uno viejo que llega tarde (sent despues de read), no cambia nada.
 */
async function estadoDeMensaje(ctx: Contexto, negocio: Negocio, s: Json): Promise<void> {
  const mensaje = s.id ? await ctx.store.mensajePorWamid(String(s.id)) : undefined;
  if (!mensaje || mensaje.negocioId !== negocio.id) return;
  const estado = String(s.status ?? '');
  const avanza = (ORDEN_DE_ESTADO[estado] ?? -1) > (ORDEN_DE_ESTADO[mensaje.estado ?? 'aceptado'] ?? 0);

  let costoReal: number | undefined;
  if (s.pricing && typeof s.pricing === 'object') {
    // billable:false es gratis de verdad (utilidad en ventana, 72 h de un anuncio).
    costoReal =
      s.pricing.billable === false
        ? 0
        : ((await precioDe(ctx, String(s.pricing.category ?? mensaje.categoria ?? ''))) ?? mensaje.costoEstimado);
  }
  const cambiaCosto = costoReal !== undefined && costoReal !== mensaje.costoReal;
  if (!avanza && !cambiaCosto) return;

  const primerError = asArray(s.errors)[0];
  const error = primerError
    ? {
        codigo: primerError.code ?? 'meta',
        detalle: taparTokens(String(primerError.error_data?.details ?? primerError.message ?? primerError.title ?? '')),
      }
    : null;
  await ctx.store.cambiarMensaje(mensaje.id, {
    ...(avanza ? { estado, ...(error ? { error } : {}) } : {}),
    ...(cambiaCosto ? { costoReal } : {}),
  });
  if (cambiaCosto) await revisarTopeDeGasto(ctx, negocio);
  if (avanza) {
    await emitir(ctx, negocio, 'estado', { mensaje_id: mensaje.id, wamid: mensaje.wamid, estado, error });
  }
}

async function plantillasDelCambio(ctx: Contexto, waba: string, v: Json) {
  const porId = v.message_template_id ? await ctx.store.plantillaPorMetaId(String(v.message_template_id)) : undefined;
  if (porId) return [porId];
  if (!v.message_template_name || !v.message_template_language) return [];
  return ctx.store.plantillasDeWaba(waba, String(v.message_template_name), String(v.message_template_language));
}

async function estadoDePlantilla(ctx: Contexto, waba: string, v: Json): Promise<void> {
  const estado = String(v.event ?? '');
  if (!estado) return;
  const motivo = v.reason && v.reason !== 'NONE' ? String(v.reason) : null;
  for (const p of await plantillasDelCambio(ctx, waba, v)) {
    if (p.estado === estado && p.motivo === motivo) continue;
    await ctx.store.cambiarPlantilla(p.id, { estado, motivo });
    if (estado === 'REJECTED') {
      const negocio = await ctx.store.negocio(p.negocioId);
      await alertar(ctx, {
        negocioId: p.negocioId,
        tipo: 'plantilla_rechazada',
        texto: `Meta rechazó la plantilla ${p.nombre} (${p.idioma}) de ${negocio?.nombre ?? '?'}${motivo ? `: ${motivo}` : ''}.`,
      });
    }
  }
}

const CATEGORIAS = new Set<string>(['MARKETING', 'UTILITY', 'AUTHENTICATION']);

/**
 * Meta recategoriza plantillas por su cuenta (una de utilidad que "parece"
 * promocion pasa a marketing). Si la nueva categoria no esta en las
 * capacidades de la app, la plantilla queda bloqueada para ella.
 */
async function categoriaDePlantilla(ctx: Contexto, waba: string, v: Json): Promise<void> {
  const nueva = String(v.new_category ?? '').toUpperCase();
  if (!CATEGORIAS.has(nueva)) return;
  const categoria = nueva as CategoriaDePlantilla;
  for (const p of await plantillasDelCambio(ctx, waba, v)) {
    const negocio = await ctx.store.negocio(p.negocioId);
    if (!negocio) continue;
    const bloqueada = !categoriasPermitidas(negocio.capacidades).has(categoria);
    await ctx.store.cambiarPlantilla(p.id, { categoria, bloqueada });
    if (bloqueada && !p.bloqueada) {
      await alertar(ctx, {
        negocioId: negocio.id,
        tipo: 'plantilla_bloqueada',
        texto: `Meta pasó la plantilla ${p.nombre} de ${negocio.nombre} de ${p.categoria} a ${categoria}, que esa app no tiene: la bloqueé.`,
      });
    }
  }
}
