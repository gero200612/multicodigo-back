import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { isTokenValid } from '@multicodigo/shared';
import { z } from 'zod';
import { estadoDelMes, numerosDelMes, presupuestoDelMes, textoDelResumen } from './anuncios.js';
import { cortarBusquedas, pausar, pedirBusqueda, ponerModo, seguir } from './comandos.js';
import { inicioDelDia } from './horas.js';
import { Contenido, editarPresupuesto, guardarRegla, pedirPresupuesto, Regla, reglaActual } from './patan.js';
import { RUBROS } from './rubros.js';
import type { Store } from './store.js';
import type { Acciones } from './telegram.js';
import { armarTablero } from './tablero.js';
import { escribirLibreta, ITEMS_POR_LISTA, LARGO_DE_ITEM, leerLibreta, Libreta } from './libreta.js';
import { CONFIG_DEL_BUSCADOR, type ConfigDelBuscador } from './agentes.js';
import type { Actividad } from './mcp.js';
import { muestraDe, type Boton } from './ventas.js';

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
  /** Lo que hacen los agentes ahora mismo (las sesiones MCP abiertas). */
  enCurso?: () => Actividad[];
}

const DIAS_DE_REUNIONES_PASADAS = 7;
const LEADS_POR_PAGINA = 50;

const CORRIDAS_EN_LISTA = 50;
const LARGO_DE_INFORME_EN_LISTA = 300;

const Id = z.coerce.number().int().positive();
const AgenteValido = z.enum(['buscador', 'vendedor', 'atencion', 'publicista', 'revisor']);

function recortar(texto: string | undefined, largo: number): string | null {
  if (!texto) return null;
  return texto.length > largo ? `${texto.slice(0, largo - 1).trimEnd()}…` : texto;
}
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
      salida.push({
        lead,
        inicial,
        seguimiento: seguimiento ?? null,
        // En ensayo: cuando le llego a Gero la muestra (la web muestra "Enviado").
        muestraEnviada: (await store.leerEstado<string>(muestraDe(id))) ?? null,
      });
    }
    salida.sort((a, b) => (b.lead.investigacion?.factibilidad ?? 0) - (a.lead.investigacion?.factibilidad ?? 0));
    return { borradores: salida };
  });

  // Las respuestas llegan ya armadas por el agente de atencion: Enviar / No
  // enviar, nada que elegir antes.
  app.get('/respuestas', async () => {
    const salientes = [];
    for (const s of await store.salientesEnBorrador(['respuesta', 'confirmacion', 'recordatorio'])) {
      const reunion = s.reunionId ? await store.reunion(s.reunionId) : undefined;
      salientes.push({ saliente: s, lead: (await store.lead(s.leadId)) ?? null, reunion: reunion ?? null });
    }
    return { salientes };
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

  // ------------------------------------------------------------ comandos

  app.post('/buscar', async (request, reply) => {
    const b = z
      .object({
        rubro: z.string().optional(),
        ciudad: z.string().max(80).optional(),
        // Cuantos negocios nuevos tiene que conseguir el buscador.
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

  // ------------------------------------------------------------ agentes
  //
  // La pestaña Agentes de la web: que penso cada agente en cada corrida y que
  // anoto en su libreta. La lista va liviana (sin pasos ni objetivo, que
  // pueden ser largos); el detalle se pide al tocar una corrida.

  // El tablero: el estado de cada agente en este momento. La web lo pide
  // seguido (cada pocos segundos mientras alguno trabaja).
  app.get('/agentes/estado', async () =>
    armarTablero({ store, ahora: d.ahora, enCurso: d.enCurso ?? (() => []) }),
  );

  app.get('/agentes/config/buscador', async () => ({
    config: (await store.leerEstado<ConfigDelBuscador>(CONFIG_DEL_BUSCADOR)) ?? {},
  }));

  // Lo que Gero le indica al buscador: zonas, rubros, notas. Texto corto; va
  // tal cual al objetivo de cada corrida.
  const Config = z.object({
    zonas: z.string().max(600).optional(),
    rubrosPreferidos: z.string().max(600).optional(),
    rubrosAEvitar: z.string().max(600).optional(),
    notas: z.string().max(2000).optional(),
  });
  app.put('/agentes/config/buscador', async (request, reply) => {
    const c = Config.safeParse(request.body);
    if (!c.success) return invalido(reply);
    await store.guardarEstado(CONFIG_DEL_BUSCADOR, c.data);
    return { config: c.data };
  });

  app.get('/agentes', async () => {
    const [buscador, vendedor, atencion, publicista, revisor, corridas] = await Promise.all([
      store.libreta('buscador'),
      store.libreta('vendedor'),
      store.libreta('atencion'),
      store.libreta('publicista'),
      store.libreta('revisor'),
      store.corridas({ limite: CORRIDAS_EN_LISTA }),
    ]);
    // Varias corridas suelen ser del mismo lead: se busca cada nombre una vez.
    const nombres = new Map<number, string | null>();
    for (const c of corridas) {
      if (c.leadId != null && !nombres.has(c.leadId)) nombres.set(c.leadId, (await store.lead(c.leadId))?.nombre ?? null);
    }
    return {
      libretas: {
        buscador: leerLibreta(buscador),
        vendedor: leerLibreta(vendedor),
        atencion: leerLibreta(atencion),
        publicista: leerLibreta(publicista),
        revisor: leerLibreta(revisor),
      },
      corridas: corridas.map((c) => ({
        id: c.id,
        agente: c.agente,
        estado: c.estado,
        slot: c.slot ?? null,
        turnos: c.turnos ?? null,
        informe: recortar(c.informe, LARGO_DE_INFORME_EN_LISTA),
        resumen: c.resumen ?? null,
        error: c.error ?? null,
        inicio: c.inicio,
        fin: c.fin ?? null,
        leadId: c.leadId ?? null,
        lead: c.leadId != null ? (nombres.get(c.leadId) ?? null) : null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/agentes/corridas/:id', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return invalido(reply);
    const c = await store.corrida(id.data);
    if (!c) return reply.code(404).send({ code: 'no_existe', message: 'esa corrida no existe' });
    const lead = c.leadId != null ? ((await store.lead(c.leadId))?.nombre ?? null) : null;
    return { corrida: { ...c, pasos: c.pasos ?? [], lead } };
  });

  // Gero corrige lo que el agente aprendio: el agente la lee al arrancar la
  // proxima corrida, asi que lo que se escribe aca manda.
  app.put<{ Params: { agente: string } }>('/agentes/libretas/:agente', async (request, reply) => {
    const agente = AgenteValido.safeParse(request.params.agente);
    if (!agente.success) return invalido(reply, 'agente desconocido');
    const b = Libreta.safeParse(request.body);
    if (!b.success) {
      return invalido(reply, `la libreta va como { tenerEnCuenta, evitar }: hasta ${ITEMS_POR_LISTA} items de ${LARGO_DE_ITEM} caracteres`);
    }
    await store.guardarLibreta(agente.data, escribirLibreta(b.data));
    return { agente: agente.data, libreta: leerLibreta(await store.libreta(agente.data)) };
  });

  // ------------------------------------------------------------ anuncios
  //
  // La pagina /homero/anuncios: la misma tarjeta que llega por Telegram, con los
  // mismos botones, y los numeros del mes.

  app.get('/anuncios', async () => {
    const [n, todos] = await Promise.all([numerosDelMes({ store, ahora: d.ahora }), store.anuncios()]);
    return {
      mes: n.mes,
      consultasHoy: n.consultasHoy,
      consultasMes: n.consultasMes,
      reunionesMes: n.reunionesMes,
      costoPorConsulta: n.costoPorConsulta ?? null,
      mejor: n.mejor?.anuncio.id ?? null,
      anuncios: todos.map((a) => {
        const f = n.anuncios.find((x) => x.anuncio.id === a.id);
        return {
          ...a,
          imagen: `/anuncios/${a.id}/imagen`,
          gasto: f?.gasto ?? 0,
          impresiones: f?.impresiones ?? 0,
          consultas: f?.consultas ?? 0,
          leads: f?.leads ?? 0,
          reuniones: f?.reuniones ?? 0,
          costoPorConsulta: f?.costoPorConsulta ?? null,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/anuncios/:id/imagen', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return invalido(reply);
    const png = await store.imagenDelAnuncio(id.data);
    if (!png) return reply.code(404).send({ code: 'no_existe', message: 'ese anuncio no existe' });
    return reply.type('image/png').send(png);
  });

  for (const [ruta, accion] of [
    ['aprobar', (id: number) => acciones.aprobarAnuncio(id)],
    ['descartar', (id: number) => acciones.descartarAnuncio(id)],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/anuncios/:id/${ruta}`, async (request, reply) => {
      const id = Id.safeParse(request.params.id);
      if (!id.success) return invalido(reply);
      const r = await accion(id.data);
      if (!r.ok) return noSe(reply, r.motivo);
      await quitar(r.anuncio.telegramMsg);
      return { anuncio: r.anuncio, nota: r.nota ?? null };
    });
  }

  app.post<{ Params: { id: string } }>('/anuncios/:id/cambiar', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    const b = z.object({ pedido: z.string().trim().min(3).max(2000) }).safeParse(request.body);
    if (!id.success || !b.success) return invalido(reply, 'mandá { pedido } con lo que hay que cambiar');
    const r = await acciones.cambiarAnuncio(id.data, b.data.pedido);
    if (!r.ok) return noSe(reply, r.motivo);
    await quitar(r.anuncio.telegramMsg);
    return { anuncio: r.anuncio };
  });

  app.get('/anuncios/presupuesto', async () => ({
    presupuesto: await presupuestoDelMes(store),
    mes: await estadoDelMes({ store, ahora: d.ahora }),
  }));

  app.put('/anuncios/presupuesto', async (request, reply) => {
    const b = z.object({ monto: z.number().positive().max(100_000_000) }).safeParse(request.body);
    if (!b.success) return invalido(reply, 'mandá { monto } en pesos por mes');
    const r = await acciones.cambiarPresupuesto(b.data.monto);
    return { ...r, aviso: r.aviso ?? null, mes: await estadoDelMes({ store, ahora: d.ahora }) };
  });

  app.get('/anuncios/resumen', async () => {
    const n = await numerosDelMes({ store, ahora: d.ahora });
    return { ...n, texto: textoDelResumen(n) };
  });

  // ------------------------------------------------------------ patán
  //
  // Vive en Homero, pero en la web es su propia seccion (/patan).

  app.get('/patan', async () => {
    const clientes = [];
    for (const demo of await store.demosPresupuestables()) {
      clientes.push({
        demo,
        lead: (await store.lead(demo.leadId)) ?? null,
        reunion: (await store.reunion(demo.reunionId)) ?? null,
        presupuesto: (await store.presupuestoDeDemo(demo.id)) ?? null,
      });
    }
    return { regla: await reglaActual(store), clientes };
  });

  app.post<{ Params: { id: string } }>('/patan/demos/:id/armar', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    const b = z.object({ notas: z.string().max(20_000).default('') }).safeParse(request.body ?? {});
    if (!id.success || !b.success) return invalido(reply);
    const r = await pedirPresupuesto(id.data, b.data.notas, store);
    return r.ok ? { presupuesto: await store.presupuesto(r.presupuestoId) } : noSe(reply, r.motivo);
  });

  app.patch<{ Params: { id: string } }>('/patan/presupuestos/:id', async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    const b = z.object({ contenido: Contenido }).safeParse(request.body);
    if (!id.success) return invalido(reply);
    if (!b.success) return invalido(reply, b.error.issues[0]?.message ?? 'presupuesto invalido');
    const r = await editarPresupuesto(id.data, b.data.contenido, store);
    return r.ok ? { presupuesto: await store.presupuesto(r.presupuestoId) } : noSe(reply, r.motivo);
  });

  app.patch('/patan/regla', async (request, reply) => {
    const b = z.object({ regla: Regla }).safeParse(request.body);
    if (!b.success) return invalido(reply);
    await guardarRegla(store, b.data.regla);
    return { regla: b.data.regla };
  });

  return app;
}
