import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { categoriasPermitidas, tiene } from './capacidades.js';
import { tokenDe, type Contexto } from './contexto.js';
import { enviarAviso, enviarTexto, marcarTokenCaido, numeroPara, Rechazo } from './envio.js';
import { DIA_MS } from './horas.js';
import { cuerpoDeEvento, esperarEventos } from './eventos.js';
import { ErrorDeMeta, esTokenCaido, type ReelDeInstagram } from './meta.js';
import { negocioDe } from './privado.js';
import { ventanaAbierta } from './reglas.js';
import type { Numero, Plantilla } from './store.js';

/**
 * Las rutas de las apps. La puerta (privado.ts) ya decidio que la clave tiene
 * la capacidad de la ruta; aca solo queda lo propio de cada una. Todo se
 * busca por el negocio de la clave: una app no puede nombrar otro negocio.
 */

// Un numero de WhatsApp tiene hasta 15 digitos; los ids de Instagram y Messenger, algunos mas.
const Contacto = z.string().regex(/^\d{8,20}$/, 'solo dígitos, de 8 a 20');
const CanalDeEnvio = z.enum(['whatsapp', 'instagram', 'messenger']).default('whatsapp');
const Id = z.coerce.number().int().positive();

const Boton = z.string().trim().min(1).max(20);
const Mensaje = z
  .object({
    a: Contacto,
    texto: z.string().trim().min(1).max(4096),
    botones: z
      .array(Boton)
      .min(1)
      .max(3)
      .refine((b) => new Set(b).size === b.length, 'botones repetidos')
      .optional(),
    link: z.object({ texto: Boton, url: z.string().url().startsWith('https://') }).optional(),
    canal: CanalDeEnvio,
  })
  // Meta no deja botones de respuesta y de link en el mismo mensaje, y el
  // cuerpo de un interactivo llega hasta 1024.
  .refine((m) => !(m.botones && m.link), 'botones o link, no los dos')
  .refine((m) => !(m.botones || m.link) || m.texto.length <= 1024, 'con botones el texto llega hasta 1024');

const Aviso = z.object({
  a: Contacto,
  plantilla: z.string().regex(/^[a-z0-9_]{1,512}$/),
  idioma: z.string().min(2).max(15),
  variables: z.array(z.string().max(1024)).max(20).default([]),
});

const NuevaPlantilla = z.object({
  nombre: z.string().regex(/^[a-z0-9_]{1,512}$/),
  idioma: z.string().min(2).max(15),
  categoria: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  componentes: z.array(z.record(z.unknown())).min(1).max(10),
});

const Esperar = z.object({ esperar: z.coerce.number().int().min(0).max(30).default(25) });
const Ack = z.object({ ids: z.array(z.number().int().positive()).max(500) });

export function vistaDePlantilla(p: Plantilla) {
  return { id: p.id, nombre: p.nombre, idioma: p.idioma, categoria: p.categoria, estado: p.estado, motivo: p.motivo, bloqueada: p.bloqueada };
}

/** `leads`, `puente` y `bandeja` contestan cualquier charla; `atender` solo las que la IA le derivó. */
const contestaTodo = (caps: Parameters<typeof tiene>[0]) => tiene(caps, 'leads') || tiene(caps, 'puente') || tiene(caps, 'bandeja');

export function registrarRutasDeApp(app: FastifyInstance, ctx: Contexto): void {
  const { store } = ctx;

  app.get('/yo', async (req) => {
    const n = negocioDe(req);
    // Sin gasto ni tope: el cliente no los ve.
    return { negocio: { id: n.id, nombre: n.nombre, capacidades: n.capacidades } };
  });

  app.post('/mensajes', async (req) => {
    const negocio = negocioDe(req);
    const { a, texto, botones, link, canal } = Mensaje.parse(req.body);
    // Con `atender` (y sin `leads`) la app solo contesta charlas que la IA le derivo.
    if (!contestaTodo(negocio.capacidades)) {
      const charlas = await store.contactosDe(negocio.id, a);
      if (!charlas.some((c) => c.derivada)) throw new Rechazo(409, 'no_derivada');
    }
    const numero = await numeroPara(ctx, negocio.id, a, canal);
    const interactivo = botones ? { botones } : link ? { link } : undefined;
    const m = await enviarTexto(ctx, negocio, numero, a, texto, { interactivo });
    return { id: m.id, wamid: m.wamid };
  });

  // "Escribiendo..." mientras la app piensa la respuesta. Es cosmetico: si no
  // hay a que mensaje engancharlo o Meta no lo toma, no sale y no es error.
  app.post('/escribiendo', async (req) => {
    const negocio = negocioDe(req);
    const { a } = z.object({ a: Contacto }).parse(req.body);
    // Igual que /mensajes: con `atender` solo en las charlas que le derivaron.
    if (!contestaTodo(negocio.capacidades) && !(await store.contactosDe(negocio.id, a)).some((c) => c.derivada)) {
      throw new Rechazo(409, 'no_derivada');
    }
    const ultimo = (await store.charla(negocio.id, a, 10)).filter((m) => m.direccion === 'entra' && m.wamid).at(-1);
    const numero = ultimo ? await store.numero(ultimo.numeroId) : undefined;
    // «Escribiendo…» es de WhatsApp; en Instagram y Messenger no se manda.
    if (!ultimo || !numero || numero.negocioId !== negocio.id || numero.canal !== 'whatsapp') return { ok: false };
    if (!ventanaAbierta(await store.contacto(numero.id, a), ctx.ahora())) return { ok: false };
    try {
      await ctx.meta.escribiendo(tokenDe(ctx, numero), numero.phoneNumberId, ultimo.wamid!);
      return { ok: true };
    } catch (e) {
      if (e instanceof ErrorDeMeta) return { ok: false };
      throw e;
    }
  });

  // La lista de charlas del negocio, la mas reciente primero, con su ultimo mensaje y si todavia se puede contestar (ventana de 24 h).
  // Una fila por contacto; el canal es el de la cuenta por la que hablo por ultima vez.
  app.get('/charlas', async (req) => {
    const negocio = negocioDe(req);
    const { limite, canal } = z
      .object({ limite: z.coerce.number().int().min(1).max(100).default(50), canal: z.enum(['whatsapp', 'instagram', 'messenger']).optional() })
      .parse(req.query);
    const numeros = new Map((await store.numerosDe(negocio.id)).map((n) => [n.id, n]));
    const ahora = ctx.ahora();
    const filas = (await store.charlas(negocio.id, 500)).filter(({ ultimo }) => {
      const n = numeros.get(ultimo.numeroId);
      return !!n && (!canal || n.canal === canal);
    });
    return Promise.all(
      filas.slice(0, limite).map(async ({ ultimo, cantidad }) => {
        const numero = numeros.get(ultimo.numeroId)!;
        const contacto = await store.contacto(numero.id, ultimo.contacto);
        return {
          contacto: ultimo.contacto,
          canal: numero.canal,
          nombre: contacto?.nombre ?? null,
          ventana_abierta: ventanaAbierta(contacto, ahora),
          baja: contacto?.baja ?? false,
          mensajes: cantidad,
          ultimo: { direccion: ultimo.direccion, tipo: ultimo.tipo, texto: ultimo.texto, fecha: ultimo.fecha.toISOString() },
        };
      }),
    );
  });

  app.get('/charlas/:contacto', async (req) => {
    const negocio = negocioDe(req);
    const contacto = Contacto.parse((req.params as { contacto: string }).contacto);
    const { limite, canal } = z.object({ limite: z.coerce.number().int().min(1).max(200).default(30), canal: z.enum(['whatsapp', 'instagram', 'messenger']).optional() }).parse(req.query);
    // Con `canal`, la ventana y la baja son las de las cuentas de ese canal.
    const delCanal = canal ? new Set((await store.numerosDe(negocio.id)).filter((n) => n.canal === canal).map((n) => n.id)) : undefined;
    const charlas = (await store.contactosDe(negocio.id, contacto)).filter((c) => !delCanal || delCanal.has(c.numeroId));
    const ahora = ctx.ahora();
    const mensajes = await store.charla(negocio.id, contacto, limite);
    return {
      contacto,
      ventana_abierta: charlas.some((c) => ventanaAbierta(c, ahora)),
      baja: charlas.some((c) => c.baja),
      derivada: charlas.some((c) => c.derivada),
      mensajes: mensajes.map((m) => ({
        id: m.id,
        direccion: m.direccion,
        tipo: m.tipo,
        texto: m.texto,
        media_id: m.mediaId,
        referral: m.referral,
        fecha: m.fecha.toISOString(),
      })),
    };
  });

  // La baja que decide la empresa (la persona no usó las palabras exactas): desde ahora nada sale a ese contacto.
  app.post('/charlas/:contacto/baja', async (req) => {
    const negocio = negocioDe(req);
    const contacto = Contacto.parse((req.params as { contacto: string }).contacto);
    const ahora = ctx.ahora();
    for (const c of await store.contactosDe(negocio.id, contacto)) {
      if (!c.baja) await store.cambiarContacto(c.numeroId, contacto, { baja: true, bajaDesde: ahora });
    }
    return { ok: true };
  });

  // ---- Comentarios publicos (Instagram y pagina de Facebook) ----

  const comentarioDe = async (negocioId: number, id: string) => {
    const c = await store.comentario(negocioId, z.string().regex(/^[\w.-]{3,100}$/).parse(id));
    if (!c) throw new Rechazo(404, 'no_existe');
    const numero = await store.numero(c.numeroId);
    if (!numero || numero.negocioId !== negocioId) throw new Rechazo(404, 'no_existe');
    return { c, numero, canal: numero.canal as 'instagram' | 'messenger' };
  };

  /** Una llamada a Meta sobre un comentario: si el token esta caido se frena todo, si Meta rechaza vuelve 502. */
  const conMeta = async <T>(numero: Numero, f: () => Promise<T>): Promise<T> => {
    if (numero.tokenCaido) throw new Rechazo(409, 'token_caido');
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof ErrorDeMeta)) throw e;
      if (esTokenCaido(e)) await marcarTokenCaido(ctx, numero.id, e.message);
      throw new Rechazo(502, 'meta', e.message);
    }
  };

  // Una respuesta en publico por comentario: no hay forma de que dos corridas se contesten entre si.
  app.post('/comentarios/:id/responder', async (req) => {
    const negocio = negocioDe(req);
    const { texto } = z.object({ texto: z.string().trim().min(1).max(2000) }).parse(req.body);
    const { c, numero, canal } = await comentarioDe(negocio.id, (req.params as { id: string }).id);
    if (canal !== 'instagram' && canal !== 'messenger') throw new Rechazo(409, 'sin_comentarios_en_canal');
    if (c.respondido) throw new Rechazo(409, 'ya_respondido');
    const r = await conMeta(numero, () => ctx.meta.responderComentario(tokenDe(ctx, numero), canal, c.comentarioId, texto));
    await store.cambiarComentario(c.id, { respondido: true });
    return { ok: true, id: r.id };
  });

  // La respuesta privada: una sola y dentro de los 7 dias del comentario (la regla de Meta). Nunca a quien pidio la baja.
  app.post('/comentarios/:id/privado', async (req) => {
    const negocio = negocioDe(req);
    const { texto } = z.object({ texto: z.string().trim().min(1).max(1000) }).parse(req.body);
    const { c, numero } = await comentarioDe(negocio.id, (req.params as { id: string }).id);
    if (c.respuestaPrivada) throw new Rechazo(409, 'ya_respondido_en_privado');
    if (ctx.ahora().getTime() - c.fecha.getTime() > 7 * DIA_MS) throw new Rechazo(409, 'fuera_de_plazo');
    if (c.autorId && (await store.contactosDe(negocio.id, c.autorId)).some((k) => k.baja)) throw new Rechazo(409, 'baja');
    const r = await conMeta(numero, () => ctx.meta.respuestaPrivada(tokenDe(ctx, numero), numero.phoneNumberId, c.comentarioId, texto));
    await store.cambiarComentario(c.id, { respuestaPrivada: true });
    if (c.autorId) {
      await store.guardarMensaje({
        negocioId: negocio.id, numeroId: numero.id, contacto: c.autorId, direccion: 'sale', tipo: 'text', texto, mediaId: null, referral: null,
        plantilla: null, wamid: r.wamid, categoria: 'service', costoEstimado: 0, costoReal: null, estado: 'aceptado', error: null, fecha: ctx.ahora(),
      });
    }
    return { ok: true, wamid: r.wamid };
  });

  app.post('/comentarios/:id/ocultar', async (req) => {
    const negocio = negocioDe(req);
    const { c, numero, canal } = await comentarioDe(negocio.id, (req.params as { id: string }).id);
    if (canal !== 'instagram' && canal !== 'messenger') throw new Rechazo(409, 'sin_comentarios_en_canal');
    if (c.oculto) return { ok: true };
    await conMeta(numero, () => ctx.meta.ocultarComentario(tokenDe(ctx, numero), canal, c.comentarioId));
    await store.cambiarComentario(c.id, { oculto: true });
    return { ok: true };
  });

  // ---- Lectura de Instagram (agente de contenido) ----

  const cuentaDeInstagram = async (negocioId: number): Promise<Numero> => {
    const cuenta = (await store.numerosDe(negocioId)).find((n) => n.canal === 'instagram');
    if (!cuenta) throw new Rechazo(409, 'sin_numero');
    if (cuenta.tokenCaido) throw new Rechazo(409, 'token_caido');
    return cuenta;
  };
  const leerInstagram = async <T>(cuenta: Numero, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof ErrorDeMeta)) throw e;
      if (esTokenCaido(e)) await marcarTokenCaido(ctx, cuenta.id, e.message);
      throw new Rechazo(502, 'meta', e.message);
    }
  };
  const idDeReel = z.string().regex(/^\d{5,30}$/);
  const vistaDeReel = (r: ReelDeInstagram, m: Record<string, number>) => ({
    id: r.id,
    texto: r.texto,
    enlace: r.enlace,
    fecha: r.fecha,
    duracion_s: r.duracion_s,
    metricas: {
      alcance: m.reach ?? null,
      reproducciones: m.views ?? null,
      interacciones: m.total_interactions ?? null,
      guardados: m.saved ?? null,
      compartidos: m.shares ?? null,
      me_gusta: r.me_gusta,
      comentarios: r.comentarios,
    },
  });

  app.get('/instagram/reels', async (req) => {
    const negocio = negocioDe(req);
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(100).default(12) }).parse(req.query);
    const cuenta = await cuentaDeInstagram(negocio.id);
    const token = tokenDe(ctx, cuenta);
    return leerInstagram(cuenta, async () => {
      const reels = await ctx.meta.reelsDeLaCuenta(token, cuenta.phoneNumberId, limite);
      // Las metricas de un reel que Meta no da (muy nuevo, sin permiso) quedan en null: no tumban la lista.
      return Promise.all(reels.map(async (r) => vistaDeReel(r, await ctx.meta.metricasDelReel(token, r.id).catch(() => ({})))));
    });
  });

  app.get('/instagram/reels/:id', async (req) => {
    const negocio = negocioDe(req);
    const id = idDeReel.parse((req.params as { id: string }).id);
    const cuenta = await cuentaDeInstagram(negocio.id);
    const token = tokenDe(ctx, cuenta);
    return leerInstagram(cuenta, async () => {
      const reel = await ctx.meta.reel(token, id);
      // Con un token compartido, un id de otra cuenta no se lee: 404 antes de pedir metricas.
      if (!reel || reel.ownerId !== cuenta.phoneNumberId) throw new Rechazo(404, 'reel_no_existe');
      return vistaDeReel(reel, await ctx.meta.metricasDelReel(token, id).catch(() => ({})));
    });
  });

  app.get('/instagram/reels/:id/archivo', async (req, reply) => {
    const negocio = negocioDe(req);
    const id = idDeReel.parse((req.params as { id: string }).id);
    const cuenta = await cuentaDeInstagram(negocio.id);
    const token = tokenDe(ctx, cuenta);
    const datos = await leerInstagram(cuenta, async () => {
      const reel = await ctx.meta.reel(token, id);
      if (!reel?.mediaUrl || reel.ownerId !== cuenta.phoneNumberId) throw new Rechazo(404, 'reel_no_existe');
      return ctx.meta.bajarMedia(token, reel.mediaUrl);
    });
    return reply.type('video/mp4').send(datos);
  });

  app.get('/media/:id', async (req, reply) => {
    const negocio = negocioDe(req);
    const id = Id.parse((req.params as { id: string }).id);
    const media = await store.media(id);
    // La de otro negocio "no existe", igual que una que nunca existio.
    if (!media || media.negocioId !== negocio.id) throw new Rechazo(404, 'no_existe');
    return reply.type(media.mime).send(media.datos);
  });

  app.post('/avisos', async (req) => {
    const negocio = negocioDe(req);
    const { mensaje, costoEstimado } = await enviarAviso(ctx, negocio, Aviso.parse(req.body));
    return { id: mensaje.id, wamid: mensaje.wamid, costo_estimado_ars: costoEstimado };
  });

  app.get('/plantillas', async (req) => {
    const negocio = negocioDe(req);
    return (await store.plantillas(negocio.id)).map(vistaDePlantilla);
  });

  app.post('/plantillas', async (req) => {
    const negocio = negocioDe(req);
    const p = NuevaPlantilla.parse(req.body);
    const permitidas = categoriasPermitidas(negocio.capacidades);
    if (!permitidas.has(p.categoria)) throw new Rechazo(404, 'no_existe');
    if (await store.plantilla(negocio.id, p.nombre, p.idioma)) throw new Rechazo(409, 'ya_existe');
    const [numero] = await store.numerosDe(negocio.id);
    if (!numero) throw new Rechazo(409, 'sin_numero');

    let creada: { id: string; estado: string; categoria: string };
    try {
      creada = await ctx.meta.crearPlantilla(tokenDe(ctx, numero), numero.wabaId, p);
    } catch (e) {
      if (e instanceof ErrorDeMeta) throw new Rechazo(502, 'meta', e.message);
      throw e;
    }
    // Meta puede recategorizarla ya al crearla.
    const categoria = (['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(creada.categoria) ? creada.categoria : p.categoria) as Plantilla['categoria'];
    const guardada = await store.crearPlantilla({
      negocioId: negocio.id,
      wabaId: numero.wabaId,
      metaId: creada.id || null,
      nombre: p.nombre,
      idioma: p.idioma,
      categoria,
      componentes: p.componentes,
      estado: creada.estado,
      motivo: null,
      bloqueada: !permitidas.has(categoria),
    });
    if (!guardada) throw new Rechazo(409, 'ya_existe');
    return vistaDePlantilla(guardada);
  });

  app.put('/atender/contexto', async (req) => {
    const negocio = negocioDe(req);
    const { texto } = z.object({ texto: z.string().max(20_000) }).parse(req.body);
    await store.cambiarNegocio(negocio.id, { contextoAtender: texto });
    return { ok: true };
  });

  app.post('/charlas/:contacto/liberar', async (req) => {
    const negocio = negocioDe(req);
    const contacto = Contacto.parse((req.params as { contacto: string }).contacto);
    for (const c of await store.contactosDe(negocio.id, contacto)) {
      if (c.derivada) await store.cambiarContacto(c.numeroId, contacto, { derivada: false });
    }
    return { ok: true };
  });

  app.get('/eventos', async (req) => {
    const negocio = negocioDe(req);
    const { esperar } = Esperar.parse(req.query);
    return (await esperarEventos(ctx, negocio.id, esperar)).map(cuerpoDeEvento);
  });

  app.post('/eventos/ack', async (req) => {
    const negocio = negocioDe(req);
    const { ids } = Ack.parse(req.body);
    return { ok: true, marcados: await store.ackEventos(negocio.id, ids) };
  });
}
