import { describe, expect, it } from 'vitest';
import { opcionesDeDesarrollo } from '../src/demo-homero.js';

const U = '22222222-2222-4222-8222-222222222222';

describe('desarrollo desde el panel', () => {
  it('arma las opciones de /corrida y descarta nombres raros', () => {
    expect(
      opcionesDeDesarrollo({
        usuarioId: U,
        proyecto: 'vete',
        pliego: 'x',
        repos: ['vete-front', 'vete-back', 'mal nombre', '..'],
        referencia: ['sincro-front'],
        org: 'acme',
      }),
    ).toBe('org=acme repos=vete-front,vete-back referencia=sincro-front');
  });

  it('sin nada, nada: los repos los decide /corrida, privados', () => {
    expect(opcionesDeDesarrollo({ usuarioId: U, proyecto: 'p', pliego: 'x' })).toBe('');
    expect(opcionesDeDesarrollo({ usuarioId: U, proyecto: 'p', pliego: 'x', publico: true })).toBe('publico=si');
  });

  it('una org con espacios no entra en el comando', () => {
    expect(opcionesDeDesarrollo({ usuarioId: U, proyecto: 'p', pliego: 'x', org: 'a b', publico: false })).toBe('');
  });
});
