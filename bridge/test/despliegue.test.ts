import { describe, it, expect } from 'vitest';
import { bloqueDeDespliegue, conDespliegue } from '../src/despliegue.js';

/**
 * El link tiene que poder preguntarse hablando.
 *
 * Salia una sola vez, en el informe del cierre. Si ese mensaje se cortaba —o el
 * deploy salia en un reintento— "no me diste el link" no tenia respuesta: el
 * agente no lo sabia y lo inventaba.
 */
describe('bloqueDeDespliegue', () => {
  it('nombra cada repo con su URL', () => {
    const b = bloqueDeDespliegue([
      { nombre: 'turnos-front', render_url: 'https://turnos-front.onrender.com' },
      { nombre: 'turnos-back', render_url: 'https://turnos-back.onrender.com' },
    ])!;
    expect(b).toMatch('turnos-front: https://turnos-front.onrender.com');
    expect(b).toMatch('turnos-back: https://turnos-back.onrender.com');
    expect(b).toMatch(/no inventes/i);
  });

  it('dice cual falta cuando solo uno esta publicado', () => {
    const b = bloqueDeDespliegue([
      { nombre: 'x-front', render_url: 'https://x-front.onrender.com' },
      { nombre: 'x-back', render_url: null },
    ])!;
    expect(b).toMatch('x-back: sin publicar');
  });

  // Sin esta linea el agente no distingue "no se desplego" de "no me lo
  // contaron", y lo segundo se contesta con una URL con pinta de real.
  it('sin nada publicado lo dice igual', () => {
    const b = bloqueDeDespliegue([{ nombre: 'y-front' }, { nombre: 'y-back' }])!;
    expect(b).toMatch(/NO hay nada publicado/);
    expect(b).toMatch(/no inventes una url/i);
  });

  // Los de referencia no se despliegan: listarlos como "sin publicar" se leeria
  // como que falta hacerlo.
  it('deja afuera los repos de referencia', () => {
    const b = bloqueDeDespliegue([
      { nombre: 'z-front', render_url: 'https://z.onrender.com' },
      { nombre: 'referencia-algo', solo_lectura: true },
    ])!;
    expect(b).not.toMatch('referencia-algo');
  });

  it('un proyecto sin repos propios no genera bloque', () => {
    expect(bloqueDeDespliegue([])).toBeUndefined();
    expect(bloqueDeDespliegue(undefined)).toBeUndefined();
    expect(bloqueDeDespliegue([{ nombre: 'ref', solo_lectura: true }])).toBeUndefined();
  });
});

describe('conDespliegue', () => {
  it('deja el mensaje de la persona al final', () => {
    const p = conDespliegue('no me diste el link', [
      { nombre: 'turnos-front', render_url: 'https://turnos-front.onrender.com' },
    ]);
    expect(p.endsWith('no me diste el link')).toBe(true);
    expect(p).toMatch('turnos-front.onrender.com');
  });

  it('sin repos, el prompt viaja intacto', () => {
    expect(conDespliegue('hola', undefined)).toBe('hola');
  });
});
