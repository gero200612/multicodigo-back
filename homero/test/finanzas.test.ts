import { describe, expect, it } from 'vitest';
import { crearApi } from '../src/api.js';
import { dolarDel, finanzasDelDia, numerosDeFinanzas, suscripciones } from '../src/finanzas.js';
import { REGLA_INICIAL, reglaActual } from '../src/precios.js';
import type { Acciones } from '../src/telegram.js';
import { MemoriaStore } from './memoria.js';

const OCTUBRE = '2026-10';

describe('Claude: cuentas vinculadas × plan, por día', () => {
  it('tres Pro todo el mes son USD 60', async () => {
    const store = new MemoriaStore();
    await store.guardarCuentasDelDia('2026-10-01', ['c1', 'c2', 'c3']);
    const n = await numerosDeFinanzas({ store }, OCTUBRE, 50);
    expect(n.claude.usd).toBe(60);
    expect(n.claude.cuentas.map((c) => [c.slot, c.dias, c.usd])).toEqual([
      ['c1', 31, 20],
      ['c2', 31, 20],
      ['c3', 31, 20],
    ]);
  });

  it('una cuenta que entra a mitad de mes paga su parte; un plan Max se respeta', async () => {
    const store = new MemoriaStore();
    // La foto de septiembre rige desde el 1 de octubre.
    await store.guardarCuentasDelDia('2026-09-20', ['c1', 'c2']);
    await store.guardarCuentasDelDia('2026-10-17', ['c1', 'c2', 'c10']);
    await store.guardarCuentaClaude({ slot: 'c2', plan: 'Max', precio: 100 });
    const n = await numerosDeFinanzas({ store }, OCTUBRE, 50);
    const c10 = n.claude.cuentas.find((c) => c.slot === 'c10')!;
    expect(c10.dias).toBe(15);
    expect(c10.usd).toBeCloseTo((20 * 15) / 31, 2);
    expect(n.claude.cuentas.find((c) => c.slot === 'c2')!.usd).toBe(100);
    // Orden numérico: c10 después de c2.
    expect(n.claude.cuentas.map((c) => c.slot)).toEqual(['c1', 'c2', 'c10']);
  });

  it('sin ninguna foto (Punchi nunca contestó) lo dice y no inventa', async () => {
    const n = await numerosDeFinanzas({ store: new MemoriaStore() }, OCTUBRE, 50);
    expect(n.claude).toEqual({ usd: 0, cuentas: [], sinDatos: true });
  });
});

describe('publicidad, fijos e ingresos', () => {
  it('los pesos de Meta pasan con el dólar de ESE día', async () => {
    const store = new MemoriaStore();
    await store.guardarCotizacion('2026-10-01', 1000);
    await store.guardarCotizacion('2026-10-10', 1250);
    await store.guardarGastos([
      { dia: '2026-10-05', anuncioId: 1, gasto: 10_000, impresiones: 100, consultas: 2 },
      { dia: '2026-10-12', anuncioId: 1, gasto: 25_000, impresiones: 300, consultas: 3 },
    ]);
    const n = await numerosDeFinanzas({ store }, OCTUBRE, 50);
    // 10.000 / 1.000 + 25.000 / 1.250 = 10 + 20
    expect(n.publicidad).toEqual({ ars: 35_000, usd: 30, consultas: 5 });
    expect(n.dolar).toEqual({ valor: 1250, dia: '2026-10-10' });
    expect(n.faltaDolar).toBe(false);
  });

  it('sin ninguna cotización, los pesos no se suman y se avisa', async () => {
    const store = new MemoriaStore();
    await store.guardarGastos([{ dia: '2026-10-05', anuncioId: 1, gasto: 10_000, impresiones: 1, consultas: 0 }]);
    const n = await numerosDeFinanzas({ store }, OCTUBRE, 50);
    expect(n.publicidad.usd).toBeUndefined();
    expect(n.faltaDolar).toBe(true);
    expect(n.gastado).toBe(0);
  });

  it('el dólar de un día sin cotización es el último anterior, o el primero que haya', () => {
    const c = [
      { dia: '2026-10-03', valor: 1100 },
      { dia: '2026-10-08', valor: 1200 },
    ];
    expect(dolarDel('2026-10-05', c)).toBe(1100);
    expect(dolarDel('2026-10-08', c)).toBe(1200);
    expect(dolarDel('2026-10-01', c)).toBe(1100);
    expect(dolarDel('2026-10-01', [])).toBeUndefined();
  });

  it('fijos vigentes en el mes (el anual por doceavos), pagos, resultado y cuánto hace falta vender', async () => {
    const store = new MemoriaStore();
    await store.guardarCotizacion('2026-10-01', 1000);
    await store.guardarCuentasDelDia('2026-10-01', ['c1', 'c2', 'c3']);
    await store.guardarFijo({ nombre: 'VPS', monto: 12, moneda: 'USD', periodo: 'mensual', desde: '2026-10-15' });
    await store.guardarFijo({ nombre: 'Dominio', monto: 24_000, moneda: 'ARS', periodo: 'anual', desde: '2026-01-01' });
    await store.guardarFijo({ nombre: 'Viejo', monto: 99, moneda: 'USD', periodo: 'mensual', desde: '2026-01-01', hasta: '2026-09-30' });
    const cliente = await store.guardarCliente({ nombre: 'Clínica', proyecto: 'clinica', armado: 400, abono: 50, desde: '2026-10-01', estado: 'activo' });
    await store.guardarPago({ clienteId: cliente, dia: '2026-10-20', monto: 200, moneda: 'USD', concepto: 'armado' });

    const n = await numerosDeFinanzas({ store }, OCTUBRE, 50);
    expect(n.fijos.map((f) => [f.nombre, f.usd])).toEqual([
      ['Dominio', 2],
      ['VPS', 12],
    ]);
    expect(n.gastado).toBe(74); // 60 Claude + 2 + 12
    expect(n.ingresos.usd).toBe(200);
    expect(n.ingresos.pagos[0]!.cliente).toBe('Clínica');
    expect(n.resultado).toBe(126);
    expect(n.paraCubrir).toEqual({ clientes: 2, abono: 50 });
  });
});

describe('suscripciones, no agentes', () => {
  // 2026-10-09: 6 slots sobre 3 cuentas Pro contaban USD 120.
  it('varios slots con la misma cuenta son una sola, nombrada por su primer slot; sin huella, cuenta sola', () => {
    expect(
      suscripciones([
        { slot: 'c10', cuenta: 'aaaa' },
        { slot: 'c2', cuenta: 'aaaa' },
        { slot: 'c3', cuenta: 'bbbb' },
        { slot: 'c4' },
      ]),
    ).toEqual([
      { id: 'c2', slots: ['c2', 'c10'] },
      { id: 'c3', slots: ['c3'] },
      { id: 'c4', slots: ['c4'] },
    ]);
  });

  it('la tarea del día guarda una cuenta por suscripción y qué agentes la usan', async () => {
    const store = new MemoriaStore();
    await finanzasDelDia({
      store,
      ahora: () => new Date('2026-10-09T15:00:00Z'),
      pedirDolar: async () => 2000,
      punchi: { cuentas: async () => [{ slot: 'c1', cuenta: 'h1' }, { slot: 'c4', cuenta: 'h1' }, { slot: 'c2', cuenta: 'h2' }] },
    });
    const n = await numerosDeFinanzas({ store }, '2026-10', 50);
    expect(n.claude.cuentas.map((c) => [c.slot, c.agentes])).toEqual([
      ['c1', ['c1', 'c4']],
      ['c2', ['c2']],
    ]);
    expect(n.claude.usd).toBe(40);
  });
});

describe('la tarea del día', () => {
  it('guarda el dólar y la foto de las cuentas; si una falla, la otra igual', async () => {
    const store = new MemoriaStore();
    const ahora = () => new Date('2026-10-09T15:00:00Z');
    await finanzasDelDia({ store, ahora, pedirDolar: async () => 1480, punchi: { cuentas: async () => [{ slot: 'c1' }, { slot: 'c2' }] } });
    expect(await store.cotizaciones('2026-10-31')).toEqual([{ dia: '2026-10-09', valor: 1480 }]);
    expect(await store.cuentasPorDia('2026-10-01')).toEqual([{ dia: '2026-10-09', slots: ['c1', 'c2'] }]);

    const otro = new MemoriaStore();
    await finanzasDelDia({
      store: otro,
      ahora,
      pedirDolar: async () => {
        throw new Error('dolarapi caído');
      },
      punchi: { cuentas: async () => [{ slot: 'c3' }] },
    });
    expect(await otro.cotizaciones('2026-10-31')).toEqual([]);
    expect(await otro.cuentasPorDia('2026-10-01')).toEqual([{ dia: '2026-10-09', slots: ['c3'] }]);
  });
});

describe('la regla de precios', () => {
  it('los mínimos de Gero: 400 de armado, 50 de abono, su hora a 15 y 30% de margen', () => {
    expect(REGLA_INICIAL).toMatchObject({ pisoArmado: 400, pisoAbono: 50, valorHora: 15, margen: 0.3 });
  });

  it('una regla vieja de Patán con los mínimos de fábrica toma los nuevos; si los había cambiado, se respetan', async () => {
    const store = new MemoriaStore();
    const vieja = { mesesDeAhorro: 5, pisoArmado: 1000, porcentajeAbono: 0.12, pisoAbono: 60, horasSoporte: 4, anticipo: 0.5, validezDias: 15 };
    await store.guardarEstado('patan:regla', vieja);
    expect(await reglaActual(store)).toMatchObject({ mesesDeAhorro: 5, pisoArmado: 400, pisoAbono: 50, valorHora: 15 });

    await store.guardarEstado('patan:regla', { ...vieja, pisoArmado: 700 });
    expect((await reglaActual(store)).pisoArmado).toBe(700);
  });
});

describe('la API de finanzas', () => {
  const TOKEN = 'token-de-la-api-de-homero';
  function conApi() {
    const store = new MemoriaStore();
    const app = crearApi({ token: TOKEN, store, acciones: {} as Acciones, cambiarBotones: async () => {}, ahora: () => new Date('2026-10-09T15:00:00Z') });
    const pedir = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, ...(payload ? { payload } : {}) });
    return { store, pedir };
  }

  it('carga, edita y borra fijos, planes, clientes y pagos; el mes los muestra', async () => {
    const h = conApi();
    await h.store.guardarCuentasDelDia('2026-10-01', ['c1']);
    const fijo = (await h.pedir('POST', '/finanzas/fijos', { nombre: 'VPS', monto: 15, moneda: 'USD', periodo: 'mensual', desde: '2026-10-01' })).json().id;
    expect((await h.pedir('PUT', `/finanzas/fijos/${fijo}`, { nombre: 'VPS', monto: 18, moneda: 'USD', periodo: 'mensual', desde: '2026-10-01' })).statusCode).toBe(200);
    expect((await h.pedir('PUT', '/finanzas/cuentas/c1', { plan: 'Max', precio: 100 })).statusCode).toBe(200);
    const cliente = (await h.pedir('POST', '/finanzas/clientes', { nombre: 'Clínica', armado: 400, abono: 50, desde: '2026-10-01' })).json().id;
    expect((await h.pedir('POST', '/finanzas/pagos', { clienteId: cliente, dia: '2026-10-05', monto: 400, moneda: 'USD', concepto: 'armado' })).statusCode).toBe(200);

    const r = (await h.pedir('GET', '/finanzas')).json();
    expect(r.numeros.mes).toBe('2026-10');
    expect(r.numeros.claude.usd).toBe(100);
    expect(r.numeros.gastado).toBe(118);
    expect(r.numeros.ingresos.usd).toBe(400);
    expect(r.clientes).toHaveLength(1);
    expect(r.planPorDefecto).toEqual({ plan: 'Pro', precio: 20 });

    expect((await h.pedir('DELETE', `/finanzas/fijos/${fijo}`)).statusCode).toBe(200);
    expect((await h.pedir('GET', '/finanzas')).json().numeros.gastado).toBe(100);
  });

  it('rechaza lo mal formado', async () => {
    const h = conApi();
    expect((await h.pedir('GET', '/finanzas?mes=2026-13')).statusCode).toBe(400);
    expect((await h.pedir('POST', '/finanzas/fijos', { nombre: '', monto: 1, moneda: 'USD', periodo: 'mensual', desde: '2026-10-01' })).statusCode).toBe(400);
    expect((await h.pedir('PUT', '/finanzas/cuentas/c1', { plan: 'Pro', precio: -5 })).statusCode).toBe(400);
    expect((await h.pedir('POST', '/finanzas/pagos', { clienteId: 99, dia: '2026-10-05', monto: 1, moneda: 'USD', concepto: 'abono' })).statusCode).toBe(400);
  });
});
