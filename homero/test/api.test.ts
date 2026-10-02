import { describe, expect, it, vi } from 'vitest';
import { crearApi } from '../src/api.js';
import { cambiarEnsayo, estadoDeHomero } from '../src/comandos.js';
import { armarDemo, cancelarDemo, editarPliego, enviarDemo, type DepsDeDemos } from '../src/demos.js';
import type { Acciones } from '../src/telegram.js';
import {
  alternarHorario,
  apagarEnsayo,
  aprobarLead,
  aprobarSaliente,
  armarRespuesta,
  claveDeEleccion,
  descartarLead,
  descartarSaliente,
  ensayoActivo,
  lugaresHoy,
  mandarMuestras,
  noResponder,
  proponerPrioridad,
  reproponerBorradores,
} from '../src/ventas.js';
import { armar } from './armar.js';

const TOKEN = 'token-de-la-api-de-homero';

/** Las mismas acciones que arma `main.ts`. */
function accionesDe(deps: DepsDeDemos): Acciones {
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
    alternarHorario: (id, i) => alternarHorario(id, i, deps),
    armarRespuesta: (id) => armarRespuesta(id, deps),
    noResponder: (id) => noResponder(id, deps),
    estado: () => estadoDeHomero(deps),
    cambiarEnsayo: (p) => cambiarEnsayo(deps, p),
    armarDemo: (id) => armarDemo(id, deps),
    enviarDemo: (id) => enviarDemo(id, deps),
    cancelarDemo: (id) => cancelarDemo(id, deps),
    editarPliego: (id, p) => editarPliego(id, p, deps),
  };
}

function conApi() {
  const h = armar();
  const deps: DepsDeDemos = {
    ...h.deps,
    punchi: { abrir: vi.fn(async () => ({ ok: true as const, corridaId: 'c-1' })), estado: vi.fn(async () => undefined) },
  };
  const cambiarBotones = vi.fn(async () => {});
  const app = crearApi({ token: TOKEN, store: h.store, acciones: accionesDe(deps), cambiarBotones, ahora: h.ahora });
  const pedir = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
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

  it('marcar un horario redibuja los botones de la tarjeta', async () => {
    const h = conApi();
    const { leadId } = await borrador(h);
    await h.store.guardarEstado(claveDeEleccion(leadId), {
      recibido: { cuenta: 'x', messageId: 'm', de: 'a@gomez.com', asunto: 'Re: hola', cuerpo: 'me interesa', recibidoEn: new Date() },
      libres: ['2026-10-01T15:00:00.000Z', '2026-10-02T18:00:00.000Z'],
      elegidos: [],
      resumen: 'Respondió',
      telegramMsg: 777,
    });
    const respuestas = (await h.pedir('GET', '/respuestas')).json();
    expect(respuestas.elecciones[0].leadId).toBe(leadId);

    const r = await h.pedir('POST', `/respuestas/${leadId}/horarios/1`);
    expect(r.json()).toEqual({ elegidos: [1] });
    expect(h.cambiarBotones).toHaveBeenCalledWith(777, expect.arrayContaining([expect.objectContaining({ datos: `ho:${leadId}:1` })]));

    expect((await h.pedir('POST', `/respuestas/${leadId}/armar`)).statusCode).toBe(200);
    expect(h.cambiarBotones).toHaveBeenLastCalledWith(777, undefined);
  });

  it('buscar valida el rubro', async () => {
    const h = conApi();
    expect((await h.pedir('POST', '/buscar', { rubro: 'astronautas' })).statusCode).toBe(409);
    const r = await h.pedir('POST', '/buscar', { rubro: 'taller', ciudad: 'Rosario' });
    expect(r.statusCode).toBe(200);
    expect(h.store.tareas.at(-1)!.tipo).toBe('prospectar');
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
});
