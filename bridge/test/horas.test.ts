import { describe, it, expect } from 'vitest';
import { aHoraArgentina } from '../src/horas.js';

/**
 * La hora del cartel de Anthropic, en hora de Argentina.
 *
 * Viene como "1:30am (UTC)" y se mostraba tal cual. Quien la lee esta en
 * Argentina, asi que "vuelve a la 1:30am" significaba tres horas mas tarde de
 * lo que parecia — y esa hora es justo la que decide si conviene esperar o
 * cambiar de agente.
 */
describe('aHoraArgentina', () => {
  it('resta las tres horas', () => {
    expect(aHoraArgentina('1:30am (UTC)')).toBe('10:30pm');
    expect(aHoraArgentina('5:00pm (UTC)')).toBe('2:00pm');
  });

  // Cruzar la medianoche hacia atras es donde una resta ingenua da "-2:30".
  it('cruza la medianoche sin dar horas negativas', () => {
    expect(aHoraArgentina('2:00am (UTC)')).toBe('11:00pm');
    expect(aHoraArgentina('12:30am (UTC)')).toBe('9:30pm');
  });

  // Las 12 son el caso que rompe cualquier resta hecha sobre el numero visible:
  // 12am es 0 y 12pm es 12.
  it('maneja el mediodia y la medianoche', () => {
    expect(aHoraArgentina('12:00pm (UTC)')).toBe('9:00am');
    expect(aHoraArgentina('12:00am (UTC)')).toBe('9:00pm');
  });

  it('acepta el formato sin espacio ni parentesis', () => {
    expect(aHoraArgentina('1:30am UTC')).toBe('10:30pm');
    expect(aHoraArgentina('1:30AM (UTC)')).toBe('10:30pm');
  });

  // Un formato que no se reconoce vuelve TAL CUAL: mostrar la hora original es
  // peor que nada, pero mucho mejor que mostrar una convertida mal.
  it('lo que no entiende lo devuelve sin tocar', () => {
    expect(aHoraArgentina('mañana')).toBe('mañana');
    expect(aHoraArgentina('')).toBe('');
    expect(aHoraArgentina('25:99am (UTC)')).toBe('25:99am (UTC)');
  });

  // Sin "(UTC)" no se asume nada: puede ser una hora que Anthropic ya dio en
  // otra zona, y restarle tres seria empeorarla.
  it('sin la marca UTC no convierte', () => {
    expect(aHoraArgentina('1:30am')).toBe('1:30am');
  });
});
