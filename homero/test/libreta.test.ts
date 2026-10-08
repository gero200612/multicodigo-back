import { describe, expect, it } from 'vitest';
import { escribirLibreta, leerLibreta, libretaComoTexto } from '../src/libreta.js';

describe('libreta como checklist', () => {
  it('ida y vuelta', () => {
    const l = { tenerEnCuenta: ['Directorio X rinde'], evitar: ['OSM en el conurbano'] };
    expect(leerLibreta(escribirLibreta(l))).toEqual(l);
  });

  it('una libreta vieja de texto libre se lee como items, sin viñetas ni markdown', () => {
    expect(leerLibreta('## Notas\n- **OSM** no sirve\n* Probar colegios\n\n1. Uno')).toEqual({
      tenerEnCuenta: ['OSM no sirve', 'Probar colegios', 'Uno'],
      evitar: [],
    });
  });

  it('el agente la ve como dos listas', () => {
    const t = libretaComoTexto({ tenerEnCuenta: ['a'], evitar: ['b'] });
    expect(t).toBe('Tener en cuenta:\n- a\nNo va / evitar:\n- b');
  });
});
