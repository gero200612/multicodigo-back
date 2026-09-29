import { describe, expect, it } from 'vitest';
import {
  cuandoReintentar,
  ErrorDeCuenta,
  ErrorDeLimite,
  pedirTexto,
  REINTENTO_SIN_HORA_MS,
  type QueryFn,
} from '../src/ia.js';

const stream =
  (...mensajes: object[]): QueryFn =>
  async function* () {
    for (const m of mensajes) yield m;
  };

const falla =
  (mensaje: string): QueryFn =>
  async function* () {
    throw new Error(mensaje);
  };

describe('pedirTexto', () => {
  it('devuelve el texto de un resultado normal', async () => {
    const q = stream({ type: 'result', subtype: 'success', result: 'hola' });
    expect(await pedirTexto('x', { sistema: 's', query: q })).toBe('hola');
  });

  it('no le da herramientas al modelo', async () => {
    let opciones: Record<string, unknown> = {};
    const q: QueryFn = async function* ({ options }) {
      opciones = options;
      yield { type: 'result', subtype: 'success', result: 'ok' };
    };
    await pedirTexto('x', { sistema: 's', query: q });
    expect(opciones.tools).toEqual([]);
    expect(opciones.maxTurns).toBe(1);
  });

  it('el cartel del limite dentro de un resultado exitoso es un ErrorDeLimite con su hora', async () => {
    const q = stream({ type: 'result', subtype: 'success', result: "You've hit your limit · resets 10:50pm (UTC)" });
    const err = await pedirTexto('x', { sistema: 's', query: q }).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLimite);
    expect(err.resets).toBe('10:50pm (UTC)');
  });

  it('un 429 tirado por el SDK tambien es limite', async () => {
    const err = await pedirTexto('x', { sistema: 's', query: falla('API Error: 429 rate_limit') }).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDeLimite);
  });

  it('una sesion vencida es ErrorDeCuenta', async () => {
    const q = stream({ type: 'assistant', error: 'authentication_failed' });
    await expect(pedirTexto('x', { sistema: 's', query: q })).rejects.toBeInstanceOf(ErrorDeCuenta);
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
