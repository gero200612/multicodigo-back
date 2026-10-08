import { describe, expect, it } from 'vitest';
import { cuandoReintentar, ErrorDeCuenta, ErrorDeLimite, pedirTexto, REINTENTO_SIN_HORA_MS } from '../src/ia.js';
import type { PedidoDeCorrida } from '../src/gateway.js';

describe('pedirTexto', () => {
  it('pide un solo turno sin herramientas ni web, y devuelve el texto', async () => {
    const pedidos: PedidoDeCorrida[] = [];
    const gateway = {
      correr: async (p: PedidoDeCorrida) => {
        pedidos.push(p);
        return { texto: 'hola', turnos: 1, pasos: [] };
      },
    };
    expect(await pedirTexto('x', { sistema: 's', modelo: 'sonnet', gateway })).toBe('hola');
    expect(pedidos[0]).toMatchObject({ herramientas: [], web: false, maxTurnos: 1, objetivo: 'x', sistema: 's', modelo: 'sonnet' });
  });

  it('los errores del gateway pasan tal cual (la cola sabe que hacer con cada uno)', async () => {
    const gateway = {
      correr: async () => {
        throw new ErrorDeLimite('10:50pm (UTC)');
      },
    };
    await expect(pedirTexto('x', { sistema: 's', gateway })).rejects.toBeInstanceOf(ErrorDeLimite);
  });
});

describe('cuandoReintentar', () => {
  const ahora = new Date('2026-09-29T20:00:00Z');

  it('espera al reset mas un minuto, aunque falten muchas horas', () => {
    // 9 horas: el bridge cortaria (tope de 6), Homero espera.
    const r = cuandoReintentar(new ErrorDeLimite('5:00am (UTC)'), ahora);
    expect(r.toISOString()).toBe('2026-09-30T05:01:00.000Z');
  });

  it('sin hora en el cartel reintenta en media hora', () => {
    const r = cuandoReintentar(new ErrorDeLimite(), ahora);
    expect(r.getTime() - ahora.getTime()).toBe(REINTENTO_SIN_HORA_MS);
  });

  it('una cuenta vencida tambien se reintenta, no se corta', () => {
    const r = cuandoReintentar(new ErrorDeCuenta('x'), ahora);
    expect(r.getTime()).toBeGreaterThan(ahora.getTime());
  });
});
