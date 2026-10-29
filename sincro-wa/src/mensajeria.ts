import { tiene } from './capacidades.js';
import type { Contexto } from './contexto.js';
import { emitir } from './eventos.js';
import { responder } from './envio.js';
import { esAlta, esBaja, TEXTO_DE_ALTA, TEXTO_DE_BAJA } from './reglas.js';
import type { Canal, Negocio, Numero } from './store.js';
import { textoDeError } from './tapar.js';

/**
 * Instagram y Messenger. Llegan por el mismo webhook de la app de Meta, con otro `object` (`instagram` y `page`).
 * Cada cuenta es un «numero» con su canal: `phone_number_id` es el id de la cuenta (ig_user_id o id de la pagina),
 * asi la ventana de 24 h, la baja, el registro y los topes son los de siempre.
 */

type Json = Record<string, any>;

const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

export async function procesarMensajeria(ctx: Contexto, canal: Exclude<Canal, 'whatsapp'>, cuerpo: Json): Promise<void> {
  for (const entrada of asArray(cuerpo.entry)) {
    const cuentaId = String(entrada.id ?? '');
    const numero = await ctx.store.numeroPorPhoneId(cuentaId);
    if (!numero || numero.canal !== canal) {
      ctx.log(`webhook de una cuenta de ${canal} desconocida (${cuentaId || 'sin id'}): descartado`);
      continue;
    }
    const negocio = await ctx.store.negocio(numero.negocioId);
    if (!negocio?.activo) {
      ctx.log(`webhook de la cuenta ${cuentaId} de un negocio inactivo: descartado`);
      continue;
    }
    await ctx.store.registrarWebhook(numero.id, ctx.ahora());
    if (numero.sinMensajesAlertado) await ctx.store.cambiarNumero(numero.id, { sinMensajesAlertado: false });

    for (const m of asArray(entrada.messaging)) {
      try {
        // Lo que manda la propia cuenta vuelve como eco: no es de la persona.
        if (m.message && !m.message.is_echo && m.sender?.id && String(m.sender.id) !== cuentaId) await entrante(ctx, negocio, numero, m);
      } catch (e) {
        ctx.log(`mensaje de ${canal}: ${textoDeError(e)}`);
        throw e;
      }
    }
    for (const cambio of asArray(entrada.changes)) {
      if (canal === 'instagram' && cambio.field === 'comments') await comentarioDeInstagram(ctx, negocio, numero, cambio.value ?? {});
      else if (canal === 'messenger' && cambio.field === 'leadgen') await leadDeLaPagina(ctx, negocio, numero, cambio.value ?? {});
      else if (canal === 'messenger' && cambio.field === 'feed') await comentarioDeLaPagina(ctx, negocio, numero, cambio.value ?? {});
    }
  }
}

async function entrante(ctx: Contexto, negocio: Negocio, numero: Numero, m: Json): Promise<void> {
  const contacto = String(m.sender.id);
  const mid = String(m.message.mid ?? '');
  if (!mid) return;
  const adjunto = asArray(m.message.attachments)[0];
  const texto = typeof m.message.text === 'string' ? m.message.text : null;
  const tipo = texto ? 'text' : String(adjunto?.type ?? 'unknown');
  const ahora = ctx.ahora();
  const mensaje = await ctx.store.guardarMensaje({
    negocioId: negocio.id,
    numeroId: numero.id,
    contacto,
    direccion: 'entra',
    tipo,
    texto,
    mediaId: null,
    referral: null,
    plantilla: null,
    contenido: null,
    wamid: mid,
    categoria: null,
    costoEstimado: 0,
    costoReal: null,
    estado: null,
    error: null,
    fecha: ahora,
  });
  // Meta repite webhooks: el mid ya estaba, ya se proceso.
  if (!mensaje) return;
  const charla = await ctx.store.registrarEntrada(numero.id, negocio.id, contacto, null, ahora);

  if (tipo === 'text' && charla.baja && esAlta(texto)) {
    await ctx.store.cambiarContacto(numero.id, contacto, { baja: false, bajaDesde: null });
    await responder(ctx, negocio, numero, contacto, TEXTO_DE_ALTA);
    await emitir(ctx, negocio, 'alta', { contacto, canal: numero.canal });
    return;
  }
  if (tipo === 'text' && esBaja(texto)) {
    if (!charla.baja) {
      await ctx.store.cambiarContacto(numero.id, contacto, { baja: true, bajaDesde: ahora });
      await responder(ctx, negocio, numero, contacto, TEXTO_DE_BAJA, { saltearBaja: true });
      await emitir(ctx, negocio, 'baja', { contacto, canal: numero.canal, motivo: 'baja' });
    }
    return;
  }

  const caps = negocio.capacidades;
  if (tiene(caps, 'leads') || tiene(caps, 'puente') || (tiene(caps, 'atender') && charla.derivada)) {
    await emitir(ctx, negocio, 'mensaje', {
      contacto,
      nombre: null,
      tipo,
      texto,
      media_id: null,
      referral: null,
      mensaje_id: mensaje.id,
      canal: numero.canal,
      wamid: mid,
    });
  }
}

// ---- Comentarios publicos ----

async function comentarioDeInstagram(ctx: Contexto, negocio: Negocio, numero: Numero, v: Json): Promise<void> {
  await guardarYAvisar(ctx, negocio, numero, {
    comentarioId: String(v.id ?? ''),
    publicacionId: v.media?.id ? String(v.media.id) : null,
    autorId: v.from?.id ? String(v.from.id) : null,
    autorNombre: v.from?.username ? String(v.from.username) : null,
    texto: typeof v.text === 'string' ? v.text : null,
    padreId: v.parent_id ? String(v.parent_id) : null,
  });
}

/**
 * Un formulario de anuncio de lead llenado. Sin datos personales: el CRM trae el
 * lead (`/{leadgen_id}`) con el token de la pagina que le dio `/conectar-pagina`.
 */
async function leadDeLaPagina(ctx: Contexto, negocio: Negocio, numero: Numero, v: Json): Promise<void> {
  if (!v.leadgen_id) return;
  const creado = Number(v.created_time);
  await emitir(ctx, negocio, 'lead', {
    tipo: 'lead',
    pagina_id: numero.phoneNumberId,
    leadgen_id: String(v.leadgen_id),
    form_id: v.form_id ? String(v.form_id) : null,
    ad_id: v.ad_id ? String(v.ad_id) : null,
    creado: Number.isFinite(creado) && creado > 0 ? new Date(creado * 1000).toISOString() : ctx.ahora().toISOString(),
  });
}

async function comentarioDeLaPagina(ctx: Contexto, negocio: Negocio, numero: Numero, v: Json): Promise<void> {
  // Solo los comentarios nuevos; lo demas del feed (reacciones, ediciones, posts) no es de Puente.
  if (v.item !== 'comment' || v.verb !== 'add') return;
  await guardarYAvisar(ctx, negocio, numero, {
    comentarioId: String(v.comment_id ?? ''),
    publicacionId: v.post_id ? String(v.post_id) : null,
    autorId: v.from?.id ? String(v.from.id) : null,
    autorNombre: v.from?.name ? String(v.from.name) : null,
    texto: typeof v.message === 'string' ? v.message : null,
    padreId: v.parent_id && String(v.parent_id) !== String(v.post_id) ? String(v.parent_id) : null,
  });
}

async function guardarYAvisar(
  ctx: Contexto,
  negocio: Negocio,
  numero: Numero,
  c: { comentarioId: string; publicacionId: string | null; autorId: string | null; autorNombre: string | null; texto: string | null; padreId: string | null },
): Promise<void> {
  if (!c.comentarioId) return;
  // Lo que comenta la propia cuenta (sus respuestas) no se contesta.
  if (c.autorId && c.autorId === numero.phoneNumberId) return;
  const guardado = await ctx.store.guardarComentario({ ...c, negocioId: negocio.id, numeroId: numero.id, fecha: ctx.ahora() });
  if (!guardado) return;
  await emitir(ctx, negocio, 'comentario', {
    canal: numero.canal,
    cuenta: numero.phoneNumberId,
    comentario_id: c.comentarioId,
    publicacion_id: c.publicacionId,
    autor_id: c.autorId,
    autor_nombre: c.autorNombre,
    texto: c.texto,
    padre_id: c.padreId,
    fecha: guardado.fecha.toISOString(),
  });
}
