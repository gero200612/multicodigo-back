import { describe, it, expect } from 'vitest';
import { NOMBRE, saludo, encabezadoDeMenu } from '../src/identidad.js';

/**
 * El bot tiene nombre propio.
 *
 * Lo que esto protege es la separacion: Punchi es quien te atiende, y C1 es a
 * quien le pasa el trabajo. Antes no habia ninguna de las dos cosas — todo
 * sonaba como si lo dijera el agente conectado.
 */
describe('la identidad del bot', () => {
  it('se presenta por su nombre', () => {
    expect(saludo()).toContain(NOMBRE);
  });

  // Dice quien es, que hace y que hacer ahora. El anterior no decia ninguna de
  // las tres: era la lista de agentes.
  it('el saludo dice que hace y como seguir', () => {
    const t = saludo();
    expect(t).toContain('agentes');
    expect(t).toMatch(/elegi|Elegi/);
  });

  it('el encabezado del menu lleva el nombre pero no repite la presentacion', () => {
    const e = encabezadoDeMenu();
    expect(e).toContain(NOMBRE);
    expect(e.length).toBeLessThan(saludo().length);
  });
});
