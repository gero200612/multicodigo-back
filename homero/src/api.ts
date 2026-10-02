import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { isTokenValid } from '@multicodigo/shared';
import { z } from 'zod';
import { cortarBusquedas, pausar, pedirBusqueda, ponerModo, seguir } from './comandos.js';
import { inicioDelDia } from './horas.js';
import { RUBROS } from './rubros.js';
import type { Store } from './store.js';
import type { Acciones } from './telegram.js';
import { claveDeEleccion, PREFIJO_DE_ELECCION, type Boton, type Eleccion } from './ventas.js';

/**
 * La API interna de Homero: lo que usa punchi.dev para manejarlo entero desde
 * la web.
 *
 * No esta expuesta a internet: vive en la red `puente` y solo la llama el
 * panel, que ya verifico que quien pide es el dueño. El token es la segunda
 * llave, igual que el `BRIDGE_API_TOKEN`.
 *
 * Cada accion llama a LA MISMA funcion que el boton de Telegram, y despues le
 * saca (o redibuja) los botones a la tarjeta del chat: decidir en un lado deja
 * decidido el otro.
 */
export interface DepsDeApi {
  token: string;
  store: Store;
  acciones: Acciones;
  cambiarBotones: (msg: number, botones: Boton[] | undefined) => Promise<void>;
  ahora: () => Date;
}

const DIAS_DE_REUNIONES_PASADAS = 7;
const LEADS_POR_PAGINA = 50;

const Id = z.coerce.number().int().positive();
const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function crearApi(d: DepsDeApi): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const { store, acciones } = d;

  app.get('/health', async () => ({ status: 'ok' }));

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    if (!isTokenValid(request.headers.authorization, d.token)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
  });

  const noSe = (reply: FastifyReply, motivo: string) => reply.code(409).send({ code: 'no_se_pudo', message: motivo });
  const invalido = (reply: FastifyReply, motivo = 'pedido invalido') =>
    reply.code(400).send({ code: 'cuerpo_invalido', message: motivo });
  const quitar = async (msg: number | undefined) => {
    if (msg) await d.cambiarBotones(msg, undefined);
  };

  // ------------------------------------------------------------ lectura

  app.get('/estado', async () => {
    const [estado, hoy, diasOcupados] = await Promise.all([
      acciones.estado(),
      store.metricasDesde(inicioDelDia(d.ahora())),
      store.diasOcupados(),
    ]);
    return { ...estado, hoy, rubros: RUBROS.map((r) => ({ id: r.id, nombre: r.nombre })), diasOcupados };
  });

  app.get('/borradores', async () => {
    const salida = [];
    for (const id of await store.leadsEnBorrador()) {
      const lead = await store.lead(id);
      if (!lead) continue;
      const salientes = await store.salientesDeLead(id);
      const inicial = salientes.find((s) => s.tipo === 'inicial' && s.estado === 'borrador');
      if (!inicial) continue;
      const seguimiento = salientes.find((s) => s.tipo === 'seguimiento' && s.estado === 'borrador');
      salida.push({ lead, inicial, seguimiento: seguimiento ?? null });
    }
    salida.sort((a, b) => (b.lead.investigacion?.factibilidad ?? 0) - (a.lead.investigacion?.factibilidad ?? 0));
    return { borradores: salida };
  });

  app.get('/respuestas', async () => {
    const elecciones = [];
    for (const { clave, valor } of await store.estadosConPrefijo(PREFIJO_DE_ELECCION)) {
      const leadId = Number(clave.slice(PREFIJO_DE_ELECCION.length));
      const e = valor as Eleccion;
      const lead = await store.lead(leadId);
      elecciones.push({
        leadId,
        lead: lead ?? null,
        resumen: e.resumen ?? null,
        recibido: { de: e.recibido.de, asunto: e.recibido.asunto, cuerpo: e.recibido.cuerpo, recibidoEn: e.recibido.recibidoEn },
        libres: e.libres,
        elegidos: e.elegidos,
      });
    }
    const salientes = [];
    for (const s of await store.salientesEnBorrador(['respuesta', 'confirmacion', 'recordatorio'])) {
      const reunion = s.reunionId ? await store.reunion(s.reunionId) : undefined;
      salientes.push({ saliente: s, lead: (await store.lead(s.leadId)) ?? null, reunion: reunion ?? null });
    }
    return { elecciones, salientes };
  });

  app.get('/reuniones', async () => {
    const desde = new Date(d.ahora().getTime() - DIAS_DE_REUNIONES_PASADAS * 24 * 3_600_000);
    const reuniones = [];
    for (const r of await store.reunionesDesde(desde)) {
      reuniones.push({
        ...r,
        lead: (await store.lead(r.leadId)) ?? null,
        demo: (await store.demoDeReunion(r.id)) ?? null,
      });
    }
    return { reuniones };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/leads', async (request, reply) => {
    const q = z
      .object({
        estado: z.string().optional(),
        rubro: z.string().optional(),
        q: z.string().max(100).optional(),
        pagina: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query);
    if (!q.success) return invalido(reply);
    return store.listarLeads({
      estado: (q.data.estado || undefined) as never,
      rubro: q.data.rubro || undefined,
      q: q.data.q || undefined,
      limite: LEADS_POR_PAGINA,
      desde: q.data.pagina * LEADS_POR_PAGINA,
    });
  });

  app.get('/rubros', async () => {
    const stats = await store.rendimientoPorRubro();
    return {
      rubros: RUBROS.map((r) => {
        const s = stats.find((x) => x.rubro === r.id);
        return { id: r.id, nombre: r.nombre, contactados: s?.contactados ?? 0, respuestas: s?.respuestas ?? 0, reuniones: s?.reuniones ?? 0 };
      }),
    };
  });

  // ------------------------------------------------------------ borradores

  app.post<{ Params: { id: string } }>('/leads/:id/aprobar', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return invalido(reply);
    const inicial = (await store.salientesDeLead(id.data)).find((s) => s.tipo === 'inicial');
    if (!(await acciones.aprobarLead(id.data))) {
      return noSe(reply, 'ya estaba decidido, o el ensayo está prendido (en ensayo no sale nada a clientes)');
    }
    await quitar(inicial?.telegramMsg);
    return { ok: true, lugares: await acciones.lugaresHoy() };
  });

  app.post<{ Params: { id: string } }>('/leads/:id/descartar', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return invalido(reply);
    const inicial = (await store.salientesDeLead(id.data)).find((s) => s.tipo === 'inicial');
    await acciones.descartarLead(id.data);
    await quitar(inicial?.telegramMsg);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/salientes/:id', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    const cuerpo = z
      .object({ asunto: z.string().min(1).max(200).optional(), cuerpo: z.string().min(1).max(10_000) })
      .safeParse(request.body);
    if (!id.success || !cuerpo.success) return invalido(reply);
    const s = await store.saliente(id.data);
    if (!s || s.estado !== 'borrador') return noSe(reply, 'ese mail ya no se puede cambiar');
    await store.actualizarSaliente(s.id, cuerpo.data);
    return { saliente: await store.saliente(s.id) };
  });

  for (const [ruta, accion] of [
    ['enviar', (id: number) => acciones.aprobarSaliente(id)],
    ['descartar', async (id: number) => (await acciones.descartarSaliente(id), true)],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/salientes/:id/${ruta}`, async (request, reply) => {
      const id = Id.safeParse(request.params.id);
      if (!id.success) return invalido(reply);
      const s = await store.saliente(id.data);
      if (!s || s.estado !== 'borrador') return noSe(reply, 'ya estaba decidido');
      if (!(await accion(id.data))) return noSe(reply, 'ya estaba decidido');
      await quitar(s.telegramMsg);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------ respuestas

  app.post<{ Params: { leadId: string; i: string } }>('/respuestas/:leadId/horarios/:i', async (request, reply) => {
    const leadId = Id.safeParse(request.params.leadId);
    const i = z.coerce.number().int().min(0).safeParse(request.params.i);
    if (!leadId.success || !i.success) return invalido(reply);
    const botones = await acciones.alternarHorario(leadId.data, i.data);
    if (!botones) return noSe(reply, 'esa elección ya no está vigente');
    const e = await store.leerEstado<Eleccion>(claveDeEleccion(leadId.data));
    if (e?.telegramMsg) await d.cambiarBotones(e.telegramMsg, botones);
    return { elegidos: e?.elegidos ?? [] };
  });

  app.post<{ Params: { leadId: string } }>('/respuestas/:leadId/armar', async (request, reply) => {
    const leadId = Id.safeParse(request.params.leadId);
    if (!leadId.success) return invalido(reply);
    const e = await store.leerEstado<Eleccion>(claveDeEleccion(leadId.data));
    const r = await acciones.armarRespuesta(leadId.data);
    if (r === 'sin_horarios') return noSe(reply, 'marcá al menos un horario');
    if (r === 'vencida') return noSe(reply, 'esa elección ya no está vigente');
    await quitar(e?.telegramMsg);
    return { ok: true };
  });

  app.post<{ Params: { leadId: string } }>('/respuestas/:leadId/no-responder', async (request, reply) => {
    const leadId = Id.safeParse(request.params.leadId);
    if (!leadId.success) return invalido(reply);
    const e = await store.leerEstado<Eleccion>(claveDeEleccion(leadId.data));
    await acciones.noResponder(leadId.data);
    await quitar(e?.telegramMsg);
    return { ok: true };
  });

  // ------------------------------------------------------------ comandos

  app.post('/buscar', async (request, reply) => {
    const b = z
      .object({
        rubro: z.string().optional(),
        ciudad: z.string().max(80).optional(),
        // Cuantos negocios con borrador se buscan: el doble se investiga.
        cantidad: z.number().int().min(1).max(10).optional(),
      })
      .safeParse(request.body ?? {});
    if (!b.success) return invalido(reply);
    const r = await pedirBusqueda(store, b.data.rubro || undefined, b.data.ciudad || undefined, b.data.cantidad);
    return r.ok ? r : noSe(reply, r.motivo);
  });

  app.post('/modo', async (request, reply) => {
    const b = z.object({ modo: z.enum(['aprobar', 'auto']) }).safeParse(request.body);
    if (!b.success) return invalido(reply);
    await ponerModo(store, b.data.modo);
    return { ok: true };
  });

  app.post('/ensayo', async (request, reply) => {
    const b = z.object({ a: z.union([z.literal('off'), z.string().email(), z.null()]) }).safeParse(request.body);
    if (!b.success) return invalido(reply, 'mandá un mail, "off" o null');
    return acciones.cambiarEnsayo(b.data.a ?? undefined);
  });

  app.post('/pausa', async () => (await pausar(store, d.ahora()), { ok: true }));
  app.post('/seguir', async () => (await seguir(store), { ok: true }));
  app.post('/cortar', async () => ({ cortadas: await cortarBusquedas(store) }));

  app.post<{ Body: { n?: number } }>('/prioridad', async (request) => {
    const n = Math.min(20, Math.max(1, Number(request.body?.n) || 5));
    return { propuestos: await acciones.prioridad(n) };
  });

  for (const [metodo, ocupado] of [
    ['POST', true],
    ['DELETE', false],
  ] as const) {
    app.route<{ Params: { dia: string } }>({
      method: metodo,
      url: '/dias/:dia/ocupado',
      handler: async (request, reply) => {
        const dia = Dia.safeParse(request.params.dia);
        if (!dia.success) return invalido(reply, 'el día va como AAAA-MM-DD');
        await store.marcarOcupado(dia.data, ocupado);
        return { diasOcupados: await store.diasOcupados() };
      },
    });
  }

  // ------------------------------------------------------------ demos

  app.post<{ Params: { id: string } }>('/reuniones/:id/demo', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return invalido(reply);
    const r = await acciones.armarDemo(id.data);
    return r.ok ? { demo: r.demo } : noSe(reply, r.motivo);
  });

  app.patch<{ Params: { id: string } }>('/demos/:id', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    const b = z.object({ pliego: z.string().min(1).max(60_000) }).safeParse(request.body);
    if (!id.success || !b.success) return invalido(reply);
    const r = await acciones.editarPliego(id.data, b.data.pliego);
    return r.ok ? { demo: r.demo } : noSe(reply, r.motivo);
  });

  for (const [ruta, accion] of [
    ['enviar', (id: number) => acciones.enviarDemo(id)],
    ['cancelar', (id: number) => acciones.cancelarDemo(id)],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/demos/:id/${ruta}`, async (request, reply) => {
      const id = Id.safeParse(request.params.id);
      if (!id.success) return invalido(reply);
      const r = await accion(id.data);
      if (!r.ok) return noSe(reply, r.motivo);
      await quitar(r.demo.telegramMsg);
      return { demo: r.demo };
    });
  }

  return app;
}
