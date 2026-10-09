import { describe, expect, it } from 'vitest';
import { crearApi } from '../src/api.js';
import { correrSiguiente } from '../src/cola.js';
import {
  leerPresupuesto,
  pedirPresupuesto,
  precios,
  presupuestar,
  REGLA_INICIAL,
  reglaActual,
  type Contenido,
} from '../src/precios.js';
import type { Acciones } from '../src/telegram.js';
import { armar } from './armar.js';

const RESPUESTA = JSON.stringify({
  personas: 12,
  usuarios: 'recepción (2) y odontólogos (5)',
  horas_ahorradas_mes: 80,
  costo_hora_usd: 6,
  razonamiento: 'Dos recepcionistas pasan medio día con turnos y recordatorios por WhatsApp.',
  titulo: 'Sistema de turnos y cobros para Clínica Levín',
  resumen: 'Los pacientes sacan turno solos y reciben el recordatorio.',
  incluye: ['Turnos online', 'Recordatorios por WhatsApp'],
  no_incluye: ['Migración de fichas viejas'],
  plazo_semanas: 3,
  abono_incluye: ['Hosting y backups', '4 horas de soporte'],
});

async function conDemo(o: { pedirIa?: (p: string) => Promise<string>; estadoDemo?: 'lista' | 'pliego' } = {}) {
  const h = armar({ pedirIa: o.pedirIa });
  const leadId = (await h.store.crearLead({
    nombre: 'Clínica Levín',
    rubro: 'odontologia',
    ciudad: 'Capital Federal',
    email: 'info@levin.com',
    fuente: 'osm',
  }))!;
  const inicio = new Date('2026-10-05T15:00:00Z');
  const reunionId = (await h.store.crearReunion({
    leadId,
    inicio,
    fin: new Date(inicio.getTime() + 1_800_000),
    link: 'https://meet.jit.si/x',
  }))!;
  const demoId = (await h.store.crearDemo({ reunionId, leadId, proyecto: 'clinica-levin-demo' }))!;
  await h.store.actualizarDemo(demoId, { estado: o.estadoDemo ?? 'lista', pliego: '# Turnero para Clínica Levín' });
  return { ...h, demoId, leadId };
}

describe('la regla de precio', () => {
  it('meses de ahorro, con piso y redondeo comercial', () => {
    // 480 USD/mes de ahorro: 4 meses = 1920 -> 1900; abono 12% = 57.6 -> piso 60
    expect(precios(480, REGLA_INICIAL)).toEqual({ armado: 1900, abono: 60 });
    // Ahorro chico: los dos pisos.
    expect(precios(50, REGLA_INICIAL)).toEqual({ armado: 400, abono: 50 });
    // Ahorro grande: 2000 * 4 = 8000; 12% = 240.
    expect(precios(2000, REGLA_INICIAL)).toEqual({ armado: 8000, abono: 240 });
  });
});

describe('leerPresupuesto', () => {
  it('los precios los pone la regla, no Claude', () => {
    const r = leerPresupuesto(RESPUESTA, REGLA_INICIAL)!;
    expect(r.justificacion.ahorroMensual).toBe(480);
    expect(r.contenido.armado.precio).toBe(1900);
    expect(r.contenido.abono).toMatchObject({ precio: 60, horasSoporte: 4 });
    expect(r.contenido.armado.formaDePago).toBe('50% al aprobar el presupuesto y 50% a la entrega.');
    expect(r.contenido.validezDias).toBe(15);
  });

  it('lo que no es el JSON pedido no se lee', () => {
    expect(leerPresupuesto('no sé', REGLA_INICIAL)).toBeUndefined();
    expect(leerPresupuesto(JSON.stringify({ titulo: 'x' }), REGLA_INICIAL)).toBeUndefined();
  });
});

describe('pedir y armar un presupuesto', () => {
  it('con la demo lista: encola, Claude contesta y queda listo con aviso', async () => {
    const h = await conDemo({ pedirIa: async () => RESPUESTA });
    const r = await pedirPresupuesto(h.demoId, 'Tienen 2 recepcionistas, cobran 900 mil cada una', h.store);
    expect(r.ok).toBe(true);
    expect(h.store.tareas.at(-1)!.tipo).toBe('presupuestar');

    await correrSiguiente(h.deps);
    const p = (await h.store.presupuestoDeDemo(h.demoId))!;
    expect(p.estado).toBe('listo');
    expect(p.contenido!.titulo).toContain('Clínica Levín');
    expect(h.prompts.at(-1)).toContain('Tienen 2 recepcionistas');
    expect(h.avisos.at(-1)).toContain('Armé el presupuesto de Clínica Levín');
  });

  it('una demo que no se mandó a Punchi todavía no se presupuesta', async () => {
    const h = await conDemo({ estadoDemo: 'pliego' });
    expect(await pedirPresupuesto(h.demoId, '', h.store)).toEqual({
      ok: false,
      motivo: 'esa demo todavía no está para presupuestar',
    });
  });

  it('si Claude contesta dos veces algo ilegible, queda fallido para reintentar', async () => {
    let veces = 0;
    const h = await conDemo({ pedirIa: async () => (veces++, 'cualquier cosa') });
    const r = await pedirPresupuesto(h.demoId, '', h.store);
    await presupuestar({ presupuestoId: r.ok ? r.presupuestoId : 0 }, h.deps);
    expect(veces).toBe(2);
    const p = (await h.store.presupuestoDeDemo(h.demoId))!;
    expect(p.estado).toBe('fallido');

    // Reintentar pisa el anterior: el mismo id, de nuevo armando.
    const otra = await pedirPresupuesto(h.demoId, 'notas nuevas', h.store);
    expect(otra).toEqual({ ok: true, presupuestoId: p.id });
    expect((await h.store.presupuesto(p.id))!.estado).toBe('armando');
  });
});

describe('la API de precios (antes Patán)', () => {
  const TOKEN = 'token-de-la-api-de-homero';
  async function conApi() {
    const h = await conDemo({ pedirIa: async () => RESPUESTA });
    const app = crearApi({ token: TOKEN, store: h.store, acciones: {} as Acciones, cambiarBotones: async () => {}, ahora: h.ahora });
    const pedir = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload ? { payload } : {}) });
    return { ...h, pedir };
  }

  it('lista las demos, arma, edita y guarda la regla', async () => {
    const h = await conApi();
    const lista = (await h.pedir('GET', '/patan')).json();
    expect(lista.regla).toEqual(REGLA_INICIAL);
    expect(lista.clientes).toHaveLength(1);
    expect(lista.clientes[0].lead.nombre).toBe('Clínica Levín');
    expect(lista.clientes[0].presupuesto).toBeNull();

    const armado = await h.pedir('POST', `/patan/demos/${h.demoId}/armar`, { notas: 'quieren cobrar con MP' });
    expect(armado.statusCode).toBe(200);
    expect(armado.json().presupuesto.estado).toBe('armando');
    // Dos veces seguidas no: ya esta armando.
    expect((await h.pedir('POST', `/patan/demos/${h.demoId}/armar`, {})).statusCode).toBe(409);

    await correrSiguiente(h.deps);
    const p = (await h.store.presupuestoDeDemo(h.demoId))!;
    const contenido: Contenido = { ...p.contenido!, armado: { ...p.contenido!.armado, precio: 2500 } };
    const editado = await h.pedir('PATCH', `/patan/presupuestos/${p.id}`, { contenido });
    expect(editado.json().presupuesto.contenido.armado.precio).toBe(2500);
    expect((await h.pedir('PATCH', `/patan/presupuestos/${p.id}`, { contenido: { titulo: '' } })).statusCode).toBe(400);

    const regla = { ...REGLA_INICIAL, pisoArmado: 1500 };
    expect((await h.pedir('PATCH', '/patan/regla', { regla })).statusCode).toBe(200);
    expect(await reglaActual(h.store)).toEqual(regla);
  });
});
