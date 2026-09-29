import { describe, expect, it } from 'vitest';
import { horaArgentina, inicioDelDia, instanteDeReset, proximaVentanaDeEnvio } from '../src/horas.js';

describe('proximaVentanaDeEnvio', () => {
  it('dentro del horario habil devuelve el mismo instante', () => {
    // Martes 2026-09-29 14:00 AR = 17:00 UTC
    const ahora = new Date('2026-09-29T17:00:00Z');
    expect(proximaVentanaDeEnvio(ahora)).toEqual(ahora);
  });

  it('de madrugada espera a las 9 del mismo dia', () => {
    const ahora = new Date('2026-09-29T06:00:00Z'); // 3:00 AR
    expect(proximaVentanaDeEnvio(ahora).toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });

  it('despues de las 19 pasa al dia siguiente', () => {
    const ahora = new Date('2026-09-29T23:30:00Z'); // 20:30 AR
    expect(proximaVentanaDeEnvio(ahora).toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('un viernes a la noche salta al lunes', () => {
    const ahora = new Date('2026-10-02T23:00:00Z'); // viernes 20:00 AR
    expect(proximaVentanaDeEnvio(ahora).toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });

  it('el sabado a la mañana tambien salta al lunes', () => {
    const ahora = new Date('2026-10-03T13:00:00Z'); // sabado 10:00 AR
    expect(proximaVentanaDeEnvio(ahora).toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });
});

describe('instanteDeReset', () => {
  const ahora = new Date('2026-09-29T20:00:00Z');

  it('lee la hora con minutos del cartel', () => {
    expect(instanteDeReset('10:50pm (UTC)', ahora)?.toISOString()).toBe('2026-09-29T22:50:00.000Z');
  });

  it('lee la hora sin minutos', () => {
    expect(instanteDeReset('11pm (UTC)', ahora)?.toISOString()).toBe('2026-09-29T23:00:00.000Z');
  });

  it('si la hora ya paso, es la de mañana', () => {
    expect(instanteDeReset('1:30am (UTC)', ahora)?.toISOString()).toBe('2026-09-30T01:30:00.000Z');
  });

  it('un texto que no es una hora no inventa nada', () => {
    expect(instanteDeReset('pronto', ahora)).toBeUndefined();
  });
});

describe('horas de Argentina', () => {
  it('inicioDelDia es la medianoche de Argentina', () => {
    expect(inicioDelDia(new Date('2026-09-30T01:00:00Z')).toISOString()).toBe('2026-09-29T03:00:00.000Z');
  });
  it('horaArgentina resta tres horas', () => {
    expect(horaArgentina(new Date('2026-09-29T22:50:00Z'))).toBe('19:50');
  });
});
