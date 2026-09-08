import { describe, it, expect } from 'vitest';
import { PREFIJOS, parseMenuData, tecladoDePlan, tecladoDeOrgs } from '../src/menu.js';

/**
 * Los prefijos de `callback_data`, que son letras sueltas.
 *
 * Este archivo existe por un bug concreto: `PLAN` se declaro como `'p'` cuando
 * `PROYECTO` ya era `'p'`. El `if` de proyecto va antes en `parseMenuData`, asi
 * que `p:si` caia ahi, no pasaba el chequeo de UUID, y devolvia null.
 *
 * El boton de "Arrancar" de una corrida no hacia NADA. Sin error, sin log, sin
 * un mensaje raro: la persona lo tocaba y no pasaba nada. Es la peor clase de
 * falla y la mas barata de prevenir.
 */
describe('los prefijos de callback_data', () => {
  it('no se repiten', () => {
    const usados = Object.values(PREFIJOS);
    const repetidos = usados.filter((p, i) => usados.indexOf(p) !== i);
    expect(repetidos, `prefijos repetidos: ${repetidos.join(', ')}`).toEqual([]);
  });

  it('son de una sola letra', () => {
    // El `callback_data` de Telegram tiene 64 bytes: los prefijos largos se los
    // comen para nada.
    for (const [nombre, p] of Object.entries(PREFIJOS)) {
      expect(p.length, `${nombre} deberia ser una letra`).toBe(1);
    }
  });

  // La prueba de verdad: cada boton que el sistema genera tiene que volver a
  // parsearse como lo que es. Un prefijo repetido rompe esto aunque la lista de
  // arriba pase.
  it('cada boton que se genera se parsea de vuelta', () => {
    for (const fila of tecladoDePlan()) {
      for (const b of fila) {
        const leido = parseMenuData(b.data);
        expect(leido, `no se parsea: ${b.data}`).not.toBeNull();
        expect(leido?.kind).toBe('plan');
      }
    }

    for (const fila of tecladoDeOrgs(['Sincro-arg', 'gero200612'])) {
      for (const b of fila) {
        const leido = parseMenuData(b.data);
        expect(leido, `no se parsea: ${b.data}`).not.toBeNull();
        expect(leido?.kind).toBe('org');
      }
    }
  });

  it('los dos botones del plan dicen cosas distintas', () => {
    const [fila] = tecladoDePlan();
    const arrancar = parseMenuData(fila![0]!.data);
    const descartar = parseMenuData(fila![1]!.data);
    expect(arrancar).toEqual({ kind: 'plan', arrancar: true });
    expect(descartar).toEqual({ kind: 'plan', arrancar: false });
  });
});
