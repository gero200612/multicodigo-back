import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { vistaDePlantilla } from './app-api.js';
import { CAPACIDADES, categoriasPermitidas } from './capacidades.js';
import { cifrar } from './cifrado.js';
import { generarClave, generarSecreto, hashDeClave } from './claves.js';
import type { Contexto } from './contexto.js';
import { Rechazo } from './envio.js';
import { cuerpoDeEvento, esperarEventos } from './eventos.js';
import { DIA_MS, diaDe, mesDe, rangoDelMes } from './horas.js';
import { registrarResultado, Resultado, tomarPendientes } from './ia.js';
import { gastoDelMes, porcentaje, VENTANA_MS } from './reglas.js';
import type { Cambio, CambiosDeNegocio, Negocio, Numero } from './store.js';
import { refrescarNumero } from './tareas.js';
import { textoDeError } from './tapar.js';

/**
 * Las rutas de admin: las usa solo Homero, con `SINCRO_WA_ADMIN_KEY`, para la
 * seccion WhatsApp, para levantar alertas y para correr la IA.
 *
 * Todo lo que cambia algo lleva `quien` y queda en `cambios`: el tope y las
 * capacidades los cambia Gero, y tiene que quedar quien, cuando y de cuanto a
 * cuanto.
 */

const Quien = z.string().trim().min(1).max(50);
const Id = z.coerce.number().int().positive();
const Capacidades = z.array(z.enum(CAPACIDADES)).max(CAPACIDADES.length).transform((c) => [...new Set(c)]);
const Tope = z.number().positive().max(1e12);
const UrlBase = z.string().url().max(500).nullable();
const Mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Esperar = z.object({ esperar: z.coerce.number().int().min(0).max(30).default(25) });
const FiltroDeNegocio = z.object({ negocio: Id.optional() });

const NuevoNegocio = z.object({
  nombre: z.string().trim().min(1).max(200),
  app: z.string().trim().min(1).max(100),
  capacidades: Capacidades,
  tope_mensual_ars: Tope,
  url_base: UrlBase.optional(),
  quien: Quien,
});

const CambiosPedidos = z.object({
  capacidades: Capacidades.optional(),
  tope_mensual_ars: Tope.optional(),
  url_base: UrlBase.optional(),
  activo: z.boolean().optional(),
  quien: Quien,
});

const NuevoNumero = z.object({
  negocio_id: z.number().int().positive(),
  phone_number_id: z.string().regex(/^\d{5,30}$/),
  waba_id: z.string().regex(/^\d{5,30}$/),
  token: z.string().min(10).optional(),
  quien: Quien,
});

function vistaDeNumero(n: Numero) {
  return {
    id: n.id,
    phone_number_id: n.phoneNumberId,
    waba_id: n.wabaId,
    calidad: n.calidad,
    tope_meta: n.topeMeta,
    estado: n.estado,
  };
}

function vistaDeNegocio(n: Negocio) {
  return {
    id: n.id,
    nombre: n.nombre,
    app: n.app,
    capacidades: n.capacidades,
    tope_mensual_ars: n.topeMensualArs,
    activo: n.activo,
    clave_ultimo_uso: n.claveUltimoUso?.toISOString() ?? null,
  };
}

function vistaDeCambio(c: Cambio) {
  return { negocio_id: c.negocioId, campo: c.campo, antes: c.antes, despues: c.despues, quien: c.quien, fecha: c.fecha.toISOString() };
}

const texto = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export function registrarRutasDeAdmin(app: FastifyInstance, ctx: Contexto): void {
  const { store } = ctx;

  async function negocioCompleto(n: Negocio) {
    const gasto = await gastoDelMes(ctx, n.id);
    return {
      ...vistaDeNegocio(n),
      numeros: (await store.numerosDe(n.id)).map(vistaDeNumero),
      gasto_mes_ars: Math.round(gasto.totalArs * 100) / 100,
      porcentaje_tope: porcentaje(gasto.totalArs, n.topeMensualArs),
    };
  }

  async function negocioOFalla(id: number): Promise<Negocio> {
    const n = await store.negocio(id);
    if (!n) throw new Rechazo(404, 'no_existe');
    return n;
  }

  /** Recalcula `bloqueada` de sus plantillas: sacarle `promociones` bloquea las de marketing. */
  async function rebloquear(n: Negocio): Promise<void> {
    const permitidas = categoriasPermitidas(n.capacidades);
    for (const p of await store.plantillas(n.id)) {
      const bloqueada = !permitidas.has(p.categoria);
      if (bloqueada !== p.bloqueada) await store.cambiarPlantilla(p.id, { bloqueada });
    }
  }

  app.post('/admin/negocios', async (req, reply) => {
    const b = NuevoNegocio.parse(req.body);
    const secreto = generarSecreto();
    const ahora = ctx.ahora();
    const creado = await store.crearNegocio(
      {
        nombre: b.nombre,
        app: b.app,
        capacidades: b.capacidades,
        topeMensualArs: b.tope_mensual_ars,
        urlBase: b.url_base ?? null,
        secretoEventos: cifrar(ctx.claveCifrado, secreto),
      },
      ahora,
    );
    // La clave lleva el id adentro, asi que se arma despues de crear el negocio.
    const clave = generarClave(creado.id);
    const negocio = (await store.cambiarNegocio(creado.id, { claveHash: hashDeClave(clave) }))!;
    await store.registrarCambios([
      { negocioId: negocio.id, campo: 'alta', antes: null, despues: texto({ capacidades: b.capacidades, tope_mensual_ars: b.tope_mensual_ars }), quien: b.quien, fecha: ahora },
    ]);
    // La clave y el secreto se muestran esta unica vez: el bot no los puede volver a dar.
    return reply.code(201).send({ negocio: vistaDeNegocio(negocio), clave, secreto_eventos: secreto });
  });

  app.get('/admin/negocios', async () => Promise.all((await store.negocios()).map(negocioCompleto)));

  app.get('/admin/negocios/:id', async (req) => {
    const n = await negocioOFalla(Id.parse((req.params as { id: string }).id));
    // El detalle suma lo que la lista no necesita: a donde van los push y el contexto de atender.
    return { ...(await negocioCompleto(n)), url_base: n.urlBase, contexto_atender: n.contextoAtender };
  });

  app.patch('/admin/negocios/:id', async (req) => {
    const n = await negocioOFalla(Id.parse((req.params as { id: string }).id));
    const b = CambiosPedidos.parse(req.body);
    const cambios: CambiosDeNegocio = {};
    const registro: Cambio[] = [];
    const ahora = ctx.ahora();
    const anotar = <K extends keyof CambiosDeNegocio>(campo: string, clave: K, antes: Negocio[K], despues: Negocio[K] | undefined) => {
      if (despues === undefined || JSON.stringify(antes) === JSON.stringify(despues)) return;
      cambios[clave] = despues;
      registro.push({ negocioId: n.id, campo, antes: texto(antes), despues: texto(despues), quien: b.quien, fecha: ahora });
    };
    anotar('capacidades', 'capacidades', n.capacidades, b.capacidades);
    anotar('tope_mensual_ars', 'topeMensualArs', n.topeMensualArs, b.tope_mensual_ars);
    anotar('url_base', 'urlBase', n.urlBase, b.url_base);
    anotar('activo', 'activo', n.activo, b.activo);
    if (!registro.length) return negocioCompleto(n);
    const nuevo = (await store.cambiarNegocio(n.id, cambios))!;
    await store.registrarCambios(registro);
    if (cambios.capacidades) await rebloquear(nuevo);
    return negocioCompleto(nuevo);
  });

  app.post('/admin/negocios/:id/rotar-clave', async (req) => {
    const n = await negocioOFalla(Id.parse((req.params as { id: string }).id));
    const { quien } = z.object({ quien: Quien }).parse(req.body);
    const clave = generarClave(n.id);
    // La vieja deja de andar en el acto.
    await store.cambiarNegocio(n.id, { claveHash: hashDeClave(clave) });
    await store.registrarCambios([{ negocioId: n.id, campo: 'clave', antes: null, despues: 'rotada', quien, fecha: ctx.ahora() }]);
    return { clave };
  });

  app.post('/admin/numeros', async (req, reply) => {
    const b = NuevoNumero.parse(req.body);
    await negocioOFalla(b.negocio_id);
    const numero = await store.crearNumero({
      negocioId: b.negocio_id,
      phoneNumberId: b.phone_number_id,
      wabaId: b.waba_id,
      tokenCifrado: b.token ? cifrar(ctx.claveCifrado, b.token) : null,
    });
    if (!numero) throw new Rechazo(409, 'ya_existe');
    await store.registrarCambios([
      { negocioId: b.negocio_id, campo: 'numero', antes: null, despues: b.phone_number_id, quien: b.quien, fecha: ctx.ahora() },
    ]);
    // Calidad y tope de Meta ya, sin esperar la vuelta de 30 min. Si Meta no
    // contesta, el numero queda dado de alta igual.
    try {
      await refrescarNumero(ctx, numero);
    } catch (e) {
      ctx.log(`datos del número ${numero.phoneNumberId}: ${textoDeError(e)}`);
    }
    return reply.code(201).send({ numero: vistaDeNumero((await store.numero(numero.id)) ?? numero) });
  });

  app.get('/admin/resumen', async (req) => {
    const { mes } = z.object({ mes: Mes.optional() }).parse(req.query);
    const elMes = mes ?? mesDe(ctx.ahora());
    const { desde, hasta } = rangoDelMes(elMes);
    const salientes = await store.salientes(desde, hasta);
    const dolar = (await store.dolar()) ?? null;
    const negocios = await Promise.all(
      (await store.negocios()).map(async (n) => {
        const mensajes = { marketing: 0, utility: 0, authentication: 0, service: 0 };
        for (const s of salientes) if (s.negocioId === n.id && s.categoria) mensajes[s.categoria]++;
        const gasto = await gastoDelMes(ctx, n.id, elMes);
        const r2 = (x: number) => Math.round(x * 100) / 100;
        return {
          id: n.id,
          nombre: n.nombre,
          mensajes,
          meta_ars: r2(gasto.metaArs),
          ia_usd: Math.round(gasto.iaUsd * 10_000) / 10_000,
          ia_ars: r2(gasto.iaArs),
          total_ars: r2(gasto.totalArs),
          tope_mensual_ars: n.topeMensualArs,
          porcentaje_tope: porcentaje(gasto.totalArs, n.topeMensualArs),
        };
      }),
    );
    return { mes: elMes, dolar_ars: dolar, negocios };
  });

  app.get('/admin/mensajes', async (req) => {
    const q = z.object({ negocio: Id.optional(), desde: Dia.optional(), hasta: Dia.optional() }).parse(req.query);
    const ahora = ctx.ahora();
    // Los dias son de Argentina, como el resto: `desde` y `hasta` incluidos.
    const aFecha = (dia: string) => new Date(`${dia}T03:00:00.000Z`);
    const desde = q.desde ? aFecha(q.desde) : aFecha(diaDe(new Date(ahora.getTime() - 30 * DIA_MS)));
    const hasta = q.hasta ? new Date(aFecha(q.hasta).getTime() + DIA_MS) : ahora;
    const filas = new Map<string, { dia: string; negocio_id: number; categoria: string; cantidad: number; costo_ars: number }>();
    for (const s of await store.salientes(desde, hasta, q.negocio)) {
      const dia = diaDe(s.fecha);
      const categoria = s.categoria ?? 'service';
      const k = `${dia}|${s.negocioId}|${categoria}`;
      const f = filas.get(k) ?? { dia, negocio_id: s.negocioId, categoria, cantidad: 0, costo_ars: 0 };
      f.cantidad++;
      f.costo_ars = Math.round((f.costo_ars + s.costo) * 10_000) / 10_000;
      filas.set(k, f);
    }
    return {
      filas: [...filas.values()].sort((a, b) => a.dia.localeCompare(b.dia) || a.negocio_id - b.negocio_id || a.categoria.localeCompare(b.categoria)),
      ventanas_abiertas: await store.ventanasAbiertas(new Date(ahora.getTime() - VENTANA_MS), q.negocio),
    };
  });

  app.get('/admin/plantillas', async (req) => {
    const { negocio } = FiltroDeNegocio.parse(req.query);
    return (await store.plantillas(negocio)).map((p) => ({ ...vistaDePlantilla(p), negocio_id: p.negocioId }));
  });

  app.get('/admin/bajas', async (req) => {
    const { negocio } = FiltroDeNegocio.parse(req.query);
    return (await store.bajas(negocio)).map((c) => ({
      negocio_id: c.negocioId,
      contacto: c.contacto,
      desde: c.bajaDesde?.toISOString() ?? null,
    }));
  });

  app.get('/admin/alertas', async (req) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
    return (await store.alertas(limite)).map((a) => ({
      id: a.id,
      negocio_id: a.negocioId,
      tipo: a.tipo,
      texto: a.texto,
      fecha: a.fecha.toISOString(),
    }));
  });

  app.get('/admin/cambios', async (req) => {
    const { negocio } = FiltroDeNegocio.parse(req.query);
    return (await store.cambios(negocio)).map(vistaDeCambio);
  });

  app.get('/admin/precios', async () =>
    (await store.precios()).map((p) => ({ categoria: p.categoria, precio_ars: p.precioArs, vigente_desde: p.desde.toISOString() })),
  );

  app.put('/admin/precios', async (req) => {
    const b = z
      .object({
        categoria: z.string().regex(/^[a-z_]{1,40}$/),
        precio_ars: z.number().min(0).max(1e6),
        quien: Quien,
      })
      .parse(req.body);
    const ahora = ctx.ahora();
    const antes = (await store.precios()).find((p) => p.categoria === b.categoria)?.precioArs;
    await store.ponerPrecio(b.categoria, b.precio_ars, ahora);
    await store.registrarCambios([
      { negocioId: null, campo: `precio:${b.categoria}`, antes: texto(antes), despues: texto(b.precio_ars), quien: b.quien, fecha: ahora },
    ]);
    return { ok: true };
  });

  app.put('/admin/dolar', async (req) => {
    const b = z.object({ ars_por_usd: z.number().positive().max(1e7), quien: Quien }).parse(req.body);
    const ahora = ctx.ahora();
    const antes = await store.dolar();
    await store.ponerDolar(b.ars_por_usd, b.quien, ahora);
    await store.registrarCambios([
      { negocioId: null, campo: 'dolar', antes: texto(antes), despues: texto(b.ars_por_usd), quien: b.quien, fecha: ahora },
    ]);
    return { ok: true };
  });

  app.get('/admin/eventos', async (req) => {
    const { esperar } = Esperar.parse(req.query);
    return (await esperarEventos(ctx, null, esperar)).map(cuerpoDeEvento);
  });

  app.post('/admin/eventos/ack', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body);
    return { ok: true, marcados: await store.ackEventos(null, ids) };
  });

  app.get('/admin/ia/pendientes', async (req) => {
    const { esperar } = Esperar.parse(req.query);
    return (await tomarPendientes(ctx, esperar)).map((t) => ({ id: t.id, negocio_id: t.negocioId, tipo: t.tipo, entrada: t.entrada }));
  });

  app.get('/admin/ia/:id/archivo', async (req, reply) => {
    const t = await store.trabajo(Id.parse((req.params as { id: string }).id));
    const mediaId = Number(t?.entrada.media_id);
    const media = t && Number.isInteger(mediaId) ? await store.media(mediaId) : undefined;
    if (!t || !media || media.negocioId !== t.negocioId) throw new Rechazo(404, 'no_existe');
    return reply.type(media.mime).send(media.datos);
  });

  app.post('/admin/ia/:id/resultado', async (req) => {
    await registrarResultado(ctx, Id.parse((req.params as { id: string }).id), Resultado.parse(req.body));
    return { ok: true };
  });
}
