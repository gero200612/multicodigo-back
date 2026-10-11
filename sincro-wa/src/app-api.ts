import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { categoriasPermitidas, tiene } from './capacidades.js';
import { tokenDe, type Contexto } from './contexto.js';
import { enviarAviso, enviarTexto, numeroPara, Rechazo } from './envio.js';
import { cuerpoDeEvento, esperarEventos } from './eventos.js';
import { ErrorDeMeta } from './meta.js';
import { negocioDe } from './privado.js';
import { ventanaAbierta } from './reglas.js';
import type { Plantilla } from './store.js';

/**
 * Las rutas de las apps. La puerta (privado.ts) ya decidio que la clave tiene
 * la capacidad de la ruta; aca solo queda lo propio de cada una. Todo se
 * busca por el negocio de la clave: una app no puede nombrar otro negocio.
 */

const Contacto = z.string().regex(/^\d{8,15}$/, 'solo dígitos, de 8 a 15');
const Id = z.coerce.number().int().positive();

const Mensaje = z.object({ a: Contacto, texto: z.string().trim().min(1).max(4096) });

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

export function registrarRutasDeApp(app: FastifyInstance, ctx: Contexto): void {
  const { store } = ctx;

  app.get('/yo', async (req) => {
    const n = negocioDe(req);
    // Sin gasto ni tope: el cliente no los ve.
    return { negocio: { id: n.id, nombre: n.nombre, capacidades: n.capacidades } };
  });

  app.post('/mensajes', async (req) => {
    const negocio = negocioDe(req);
    const { a, texto } = Mensaje.parse(req.body);
    // Con `atender` (y sin `leads`) la app solo contesta charlas que la IA le derivo.
    if (!tiene(negocio.capacidades, 'leads')) {
      const charlas = await store.contactosDe(negocio.id, a);
      if (!charlas.some((c) => c.derivada)) throw new Rechazo(409, 'no_derivada');
    }
    const numero = await numeroPara(ctx, negocio.id, a);
    const m = await enviarTexto(ctx, negocio, numero, a, texto);
    return { id: m.id, wamid: m.wamid };
  });

  app.get('/charlas/:contacto', async (req) => {
    const negocio = negocioDe(req);
    const contacto = Contacto.parse((req.params as { contacto: string }).contacto);
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(200).default(30) }).parse(req.query);
    const charlas = await store.contactosDe(negocio.id, contacto);
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
