import { describe, expect, it, vi } from 'vitest';
import {
  aprobarAnuncio,
  cambiarPresupuesto,
  descartarAnuncio,
  pedirCambio,
  proponerAnuncio,
  registrarVeredicto,
  type DepsDeAnuncios,
} from '../src/anuncios.js';
import { CRITERIOS, type Criterio } from '../src/store.js';
import { PANEL } from './ejemplos.js';
import { crearApi } from '../src/api.js';
import { cambiarEnsayo, estadoDeHomero } from '../src/comandos.js';
import { armarDemo, cancelarDemo, editarPliego, enviarDemo, type DepsDeDemos } from '../src/demos.js';
import type { Acciones } from '../src/telegram.js';
import {
  apagarEnsayo,
  aprobarLead,
  aprobarSaliente,
  descartarLead,
  descartarSaliente,
  ensayoActivo,
  lugaresHoy,
  mandarMuestras,
  proponerPrioridad,
  reproponerBorradores,
} from '../src/ventas.js';
import { armar, type Opciones } from './armar.js';
import { metaFalsa } from './meta-falsa.js';

const TOKEN = 'token-de-la-api-de-homero';

/** Las mismas acciones que arma `main.ts`. */
function accionesDe(deps: DepsDeDemos & DepsDeAnuncios): Acciones {
  return {
    aprobarLead: (id) => aprobarLead(id, deps),
    descartarLead: (id) => descartarLead(id, deps),
    aprobarSaliente: (id) => aprobarSaliente(id, deps),
    descartarSaliente: (id) => descartarSaliente(id, deps),
    mandarMuestras: (a) => mandarMuestras(a, deps),
    ensayo: () => ensayoActivo(deps),
    apagarEnsayo: () => apagarEnsayo(deps),
    reproponerBorradores: () => reproponerBorradores(deps),
    prioridad: (n) => proponerPrioridad(deps, n),
    lugaresHoy: () => lugaresHoy(deps),
    estado: () => estadoDeHomero(deps),
    cambiarEnsayo: (p) => cambiarEnsayo(deps, p),
    armarDemo: (id) => armarDemo(id, deps),
    enviarDemo: (id) => enviarDemo(id, deps),
    cancelarDemo: (id) => cancelarDemo(id, deps),
    editarPliego: (id, p) => editarPliego(id, p, deps),
    probarIa: async () => 'hola',
    aprobarAnuncio: (id) => aprobarAnuncio(id, deps),
    descartarAnuncio: (id) => descartarAnuncio(id, deps),
    cambiarAnuncio: (id, pedido) => pedirCambio(id, pedido, deps),
    cambiarPresupuesto: (monto) => cambiarPresupuesto(monto, deps),
  };
}

function conApi(o: Opciones = {}) {
  const h = armar(o);
  const deps: DepsDeDemos = {
    ...h.deps,
    punchi: { abrir: vi.fn(async () => ({ ok: true as const, corridaId: 'c-1' })), estado: vi.fn(async () => undefined) },
  };
  const cambiarBotones = vi.fn(async () => {});
  const app = crearApi({ token: TOKEN, store: h.store, acciones: accionesDe(deps), cambiarBotones, ahora: h.ahora });
  const pedir = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload ? { payload } : {}) });
  return { ...h, deps, app, pedir, cambiarBotones };
}

async function borrador(h: ReturnType<typeof conApi>) {
  const leadId = (await h.store.crearLead({ nombre: 'Taller Gómez', rubro: 'taller', ciudad: 'Rosario', email: 'a@gomez.com', fuente: 'osm' }))!;
  await h.store.actualizarLead(leadId, {
    estado: 'borrador',
    investigacion: { resumen_empresa: 'Taller', dolor: 'turnos por teléfono', idea: 'turnero', factibilidad: 8 },
  });
  const inicial = await h.store.crearSaliente({ leadId, tipo: 'inicial', paso: 0, asunto: 'hola', cuerpo: 'mail' });
  await h.store.actualizarSaliente(inicial, { telegramMsg: 555 });
  await h.store.crearSaliente({ leadId, tipo: 'seguimiento', paso: 1, asunto: 'Re: hola', cuerpo: 'seguimiento' });
  return { leadId, inicial };
}

describe('API de Homero', () => {
  it('sin token no contesta nada (salvo /health)', async () => {
    const h = conApi();
    expect((await h.app.inject({ method: 'GET', url: '/estado' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('/estado junta el estado, los numeros del dia y los rubros', async () => {
    const h = conApi();
    const r = await h.pedir('GET', '/estado');
    expect(r.statusCode).toBe(200);
    const e = r.json();
    expect(e.modo).toBe('aprobar');
    expect(e.demos).toBe(true);
    expect(e.hoy).toHaveProperty('enviados');
    expect(e.rubros.length).toBeGreaterThan(0);
  });

  it('aprobar desde la web le saca los botones a la tarjeta de Telegram', async () => {
    const h = conApi();
    const { leadId } = await borrador(h);
    const lista = (await h.pedir('GET', '/borradores')).json();
    expect(lista.borradores).toHaveLength(1);
    expect(lista.borradores[0].seguimiento.cuerpo).toBe('seguimiento');

    const r = await h.pedir('POST', `/leads/${leadId}/aprobar`);
    expect(r.statusCode).toBe(200);
    expect(h.cambiarBotones).toHaveBeenCalledWith(555, undefined);
    expect((await h.store.lead(leadId))!.estado).toBe('aprobado');

    // Ya decidido (en la web o en Telegram): 409, no un segundo envio.
    expect((await h.pedir('POST', `/leads/${leadId}/aprobar`)).statusCode).toBe(409);
  });

  it('editar un borrador cambia el texto; uno ya enviado no', async () => {
    const h = conApi();
    const { inicial } = await borrador(h);
    const r = await h.pedir('PATCH', `/salientes/${inicial}`, { cuerpo: 'mail nuevo' });
    expect(r.json().saliente.cuerpo).toBe('mail nuevo');
    await h.store.actualizarSaliente(inicial, { estado: 'enviado' });
    expect((await h.pedir('PATCH', `/salientes/${inicial}`, { cuerpo: 'otro' })).statusCode).toBe(409);
  });

  it('una respuesta ya armada se ve en /respuestas y enviarla le saca los botones a la tarjeta', async () => {
    const h = conApi();
    const { leadId } = await borrador(h);
    const id = await h.store.crearSaliente({ leadId, tipo: 'respuesta', paso: 0, asunto: 'Re: hola', cuerpo: '¿El jueves a las 15?' });
    await h.store.actualizarSaliente(id, { telegramMsg: 777 });

    const respuestas = (await h.pedir('GET', '/respuestas')).json();
    // Ya no hay horarios para marcar: la respuesta llega escrita por el agente.
    expect(respuestas.elecciones).toBeUndefined();
    expect(respuestas.salientes[0].saliente.id).toBe(id);
    expect(respuestas.salientes[0].lead.id).toBe(leadId);

    expect((await h.pedir('POST', `/salientes/${id}/enviar`)).statusCode).toBe(200);
    expect(h.cambiarBotones).toHaveBeenLastCalledWith(777, undefined);
    expect((await h.store.saliente(id))!.estado).toBe('aprobado');
    expect((await h.pedir('POST', `/salientes/${id}/descartar`)).statusCode).toBe(409);
  });

  it('las rutas de elegir horarios ya no existen', async () => {
    const h = conApi();
    expect((await h.pedir('POST', '/respuestas/1/horarios/0')).statusCode).toBe(404);
    expect((await h.pedir('POST', '/respuestas/1/armar')).statusCode).toBe(404);
    expect((await h.pedir('POST', '/respuestas/1/no-responder')).statusCode).toBe(404);
  });

  it('buscar acepta cualquier rubro y le pasa el pedido al agente buscador', async () => {
    const h = conApi();
    // El buscador ya no depende de la lista de rubros: uno inventado tambien vale.
    const r = await h.pedir('POST', '/buscar', { rubro: 'astronautas', ciudad: 'Rosario', cantidad: 4 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, rubro: 'astronautas', ciudad: 'Rosario', fueraDeZona: true });
    const t = h.store.tareas.at(-1)!;
    expect(t.tipo).toBe('agente_buscar');
    expect(t.payload).toEqual({ cantidad: 4, rubro: 'astronautas', zona: 'Rosario' });

    // Uno de la lista se pasa con su nombre, que es lo que entiende el agente.
    await h.pedir('POST', '/buscar', { rubro: 'taller' });
    expect((h.store.tareas.at(-1)!.payload as { rubro: string }).rubro).toBe('taller mecánico');
  });

  it('buscar respeta la cantidad pedida, entre 1 y 10', async () => {
    const h = conApi();
    await h.pedir('POST', '/buscar', {});
    expect((h.store.tareas.at(-1)!.payload as { cantidad: number }).cantidad).toBe(3);
    await h.pedir('POST', '/buscar', { cantidad: 7 });
    expect((h.store.tareas.at(-1)!.payload as { cantidad: number }).cantidad).toBe(7);
    expect((await h.pedir('POST', '/buscar', { cantidad: 50 })).statusCode).toBe(400);
  });

  it('pausa, modo y dias ocupados', async () => {
    const h = conApi();
    await h.pedir('POST', '/pausa');
    expect((await h.pedir('GET', '/estado')).json().pausaManual).toBe(true);
    await h.pedir('POST', '/seguir');
    await h.pedir('POST', '/modo', { modo: 'auto' });
    const e = (await h.pedir('GET', '/estado')).json();
    expect(e.pausaManual).toBe(false);
    expect(e.modo).toBe('auto');
    expect((await h.pedir('POST', '/dias/2026-10-05/ocupado')).json().diasOcupados).toEqual(['2026-10-05']);
    expect((await h.pedir('DELETE', '/dias/2026-10-05/ocupado')).json().diasOcupados).toEqual([]);
    expect((await h.pedir('POST', '/dias/5-10/ocupado')).statusCode).toBe(400);
  });

  it('las reuniones traen su demo, y la demo se arma desde la web', async () => {
    const h = conApi();
    const { leadId } = await borrador(h);
    const inicio = new Date('2026-10-02T15:00:00Z');
    const reunionId = (await h.store.crearReunion({ leadId, inicio, fin: inicio, link: 'https://meet.jit.si/x' }))!;

    const r = await h.pedir('POST', `/reuniones/${reunionId}/demo`);
    expect(r.statusCode).toBe(200);
    expect(r.json().demo.estado).toBe('redactando');
    const reuniones = (await h.pedir('GET', '/reuniones')).json().reuniones;
    expect(reuniones[0].demo.proyecto).toBe('taller-gomez-demo');
    expect((await h.pedir('POST', `/reuniones/${reunionId}/demo`)).statusCode).toBe(409);
  });
  it('/agentes trae las tres libretas y las corridas livianas, las mas nuevas primero', async () => {
    const h = conApi();
    const { leadId } = await borrador(h);
    await h.store.guardarLibreta('buscador', 'En Rosario OSM no tiene talleres: buscar en Google Maps.');
    const vieja = await h.store.crearCorrida({ agente: 'buscador', objetivo: 'Conseguí 3 talleres en Rosario' });
    await h.store.cerrarCorrida(vieja, {
      estado: 'lista',
      slot: 'cuenta-2',
      turnos: 12,
      pasos: [{ tipo: 'pensamiento', texto: 'Arranco por el mapa' }],
      informe: 'x'.repeat(1000),
    });
    const nueva = await h.store.crearCorrida({ agente: 'vendedor', objetivo: 'Escribile al taller', leadId });
    await h.store.cerrarCorrida(nueva, { estado: 'fallida', error: 'no cerro con dejar_listo' });

    const r = await h.pedir('GET', '/agentes');
    expect(r.statusCode).toBe(200);
    const a = r.json();
    // Una libreta vieja de texto libre se lee como checklist.
    expect(a.libretas).toEqual({
      buscador: { tenerEnCuenta: ['En Rosario OSM no tiene talleres: buscar en Google Maps.'], evitar: [] },
      vendedor: { tenerEnCuenta: [], evitar: [] },
      atencion: { tenerEnCuenta: [], evitar: [] },
      publicista: { tenerEnCuenta: [], evitar: [] },
      revisor: { tenerEnCuenta: [], evitar: [] },
    });
    expect(a.corridas.map((c: { id: number }) => c.id)).toEqual([nueva, vieja]);
    expect(a.corridas[0]).toMatchObject({ agente: 'vendedor', estado: 'fallida', error: 'no cerro con dejar_listo', leadId, lead: 'Taller Gómez' });
    // La lista no lleva lo pesado: eso viene en el detalle.
    expect(a.corridas[1]).not.toHaveProperty('pasos');
    expect(a.corridas[1]).not.toHaveProperty('objetivo');
    expect(a.corridas[1]).toMatchObject({ slot: 'cuenta-2', turnos: 12, lead: null });
    expect(a.corridas[1].informe.length).toBeLessThanOrEqual(300);
  });

  it('el detalle de una corrida trae el objetivo, los pasos en orden y el informe', async () => {
    const h = conApi();
    const id = await h.store.crearCorrida({ agente: 'buscador', objetivo: 'Conseguí 3 talleres' });
    const pasos = [
      { tipo: 'pensamiento' as const, texto: 'Miro el mapa primero' },
      { tipo: 'herramienta' as const, herramienta: 'mapa', texto: '{"zona":"Rosario"}' },
    ];
    await h.store.cerrarCorrida(id, { estado: 'lista', pasos, informe: 'Anoté 3' });
    const c = (await h.pedir('GET', `/agentes/corridas/${id}`)).json().corrida;
    expect(c).toMatchObject({ id, objetivo: 'Conseguí 3 talleres', informe: 'Anoté 3', pasos });
    expect((await h.pedir('GET', '/agentes/corridas/999')).statusCode).toBe(404);
    expect((await h.pedir('GET', '/agentes/corridas/abc')).statusCode).toBe(400);
  });

  it('Gero corrige una libreta como checklist; agente desconocido o items de mas no', async () => {
    const h = conApi();
    const r = await h.pedir('PUT', '/agentes/libretas/vendedor', {
      tenerEnCuenta: ['  Los talleres contestan a la mañana.  '],
      evitar: ['Franquicias'],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().libreta).toEqual({ tenerEnCuenta: ['Los talleres contestan a la mañana.'], evitar: ['Franquicias'] });
    expect((await h.pedir('PUT', '/agentes/libretas/patan', { tenerEnCuenta: [], evitar: [] })).statusCode).toBe(400);
    expect((await h.pedir('PUT', '/agentes/libretas/vendedor', { tenerEnCuenta: Array(26).fill('x'), evitar: [] })).statusCode).toBe(400);
    expect((await h.pedir('PUT', '/agentes/libretas/vendedor', { contenido: 'texto' })).statusCode).toBe(400);
  });

  describe('anuncios', () => {
    const propuesta = {
      rubro: 'taller',
      titulo: 'Turnos sin perder ninguno',
      texto: 'Los turnos que hoy entran por WhatsApp quedan agendados solos.',
      plantilla: 'panel' as const,
      contenido: PANEL,
      preguntas: [],
      diario: 2000,
      porQue: 'Los talleres responden.',
    };
    const nueves = Object.fromEntries(CRITERIOS.map((c) => [c, 9])) as Record<Criterio, number>;
    /** Como queda despues de que el revisor lo aprueba. */
    async function propuesto(h: ReturnType<typeof conApi>) {
      const id = await proponerAnuncio(propuesta, h.deps);
      await registrarVeredicto(id, { aprobado: true, puntajes: nueves, correcciones: '' }, h.deps);
      return id;
    }

    it('lista con los números del mes, sirve la imagen y aprueba como el botón de Telegram', async () => {
      const f = metaFalsa();
      const h = conApi({ meta: f.meta });
      const id = await propuesto(h);
      const lista = (await h.pedir('GET', '/anuncios')).json();
      expect(lista.mes).toMatchObject({ presupuesto: 50_000, gastado: 0 });
      expect(lista.anuncios).toEqual([expect.objectContaining({
          id,
          estado: 'propuesto',
          plantilla: 'panel',
          contenido: PANEL,
          revision: [expect.objectContaining({ ronda: 1, aprobado: true, puntajes: nueves })],
          imagen: `/anuncios/${id}/imagen`,
          gasto: 0,
        })]);

      const img = await h.pedir('GET', `/anuncios/${id}/imagen`);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.rawPayload.subarray(1, 4).toString()).toBe('PNG');

      const r = await h.pedir('POST', `/anuncios/${id}/aprobar`);
      expect(r.statusCode).toBe(200);
      expect(r.json().anuncio).toMatchObject({ estado: 'aprobado' });
      expect(h.cambiarBotones).toHaveBeenCalledWith(1001, undefined);
      expect((await h.pedir('POST', `/anuncios/${id}/aprobar`)).statusCode).toBe(409);
      expect(f.llamadas).toEqual([]);
    });

    it('pedir un cambio y descartar', async () => {
      const h = conApi({ meta: metaFalsa().meta });
      const a = await propuesto(h);
      const b = await propuesto(h);
      expect((await h.pedir('POST', `/anuncios/${a}/cambiar`, {})).statusCode).toBe(400);
      expect((await h.pedir('POST', `/anuncios/${a}/cambiar`, { pedido: 'más corto' })).json().anuncio).toMatchObject({ estado: 'descartado' });
      expect(h.store.tareas.at(-1)).toMatchObject({ tipo: 'agente_publicitar', payload: { cambio: { anuncioId: a, pedido: 'más corto' } } });
      expect((await h.pedir('POST', `/anuncios/${b}/descartar`)).json().anuncio).toMatchObject({ estado: 'descartado' });
    });

    it('el presupuesto del mes se lee y se cambia', async () => {
      const h = conApi({ meta: metaFalsa().meta });
      expect((await h.pedir('GET', '/anuncios/presupuesto')).json()).toMatchObject({ presupuesto: 50_000 });
      expect((await h.pedir('PUT', '/anuncios/presupuesto', { monto: -3 })).statusCode).toBe(400);
      expect((await h.pedir('PUT', '/anuncios/presupuesto', { monto: 80_000 })).json()).toMatchObject({ presupuesto: 80_000, pausados: 0 });
      expect((await h.pedir('GET', '/anuncios/resumen')).json().texto).toContain('de $80.000');
    });
  });
});
