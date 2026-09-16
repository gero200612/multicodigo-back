import { describe, it, expect } from 'vitest';
import {
  PREFIJOS,
  parseMenuData,
  tecladoDePlan,
  tecladoDeOrgs,
  tecladoDeCorrida,
} from '../src/menu.js';

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

  it('los botones del primer paso de /corrida se parsean como proyecto o nuevo', () => {
    const id = '3f2b8c1e-8a9d-4c1b-9e2a-1b2c3d4e5f60';
    const filas = tecladoDeCorrida([{ id, nombre: 'mesas' } as never]);
    expect(filas.flat().map((b) => parseMenuData(b.data))).toEqual([
      { kind: 'corrida_proyecto', id },
      { kind: 'corrida_proyecto', id: 'nuevo' },
    ]);
    // Cualquier otra cosa atras de `r:` es un boton que no salio de aca.
    expect(parseMenuData('r:loquesea')).toBeNull();
  });

  it('los dos botones del plan dicen cosas distintas', () => {
    const [fila] = tecladoDePlan();
    const arrancar = parseMenuData(fila![0]!.data);
    const descartar = parseMenuData(fila![1]!.data);
    expect(arrancar).toEqual({ kind: 'plan', arrancar: true });
    expect(descartar).toEqual({ kind: 'plan', arrancar: false });
  });
});
