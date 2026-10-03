import { describe, expect, it, vi } from 'vitest';
import { cuentaDeClaude } from '../src/cuenta.js';
import { pedirTexto } from '../src/ia.js';

describe('cuenta de Claude asignada', () => {
  it('usa el HOME del slot asignado si tiene credencial', async () => {
    const c = cuentaDeClaude(async () => 'c3', { dir: '/srv/slots', existe: () => true });
    expect((await c.home('homero'))?.split('\\').join('/')).toBe('/srv/slots/c3');
  });

  it('sin asignar, o sin credencial, sigue con la propia', async () => {
    expect(await cuentaDeClaude(async () => undefined, { existe: () => true }).home('homero')).toBeUndefined();
    expect(await cuentaDeClaude(async () => 'c3', { existe: () => false }).home('homero')).toBeUndefined();
  });

  it('si la base falla, sigue con la propia', async () => {
    const c = cuentaDeClaude(async () => { throw new Error('caida'); }, { existe: () => true });
    expect(await c.home('homero')).toBeUndefined();
  });

  it('no arma rutas con un slot raro', async () => {
    const existe = vi.fn(() => true);
    expect(await cuentaDeClaude(async () => '../homero', { existe }).home('homero')).toBeUndefined();
    expect(existe).not.toHaveBeenCalled();
  });

  it('pregunta a la base una vez por minuto como mucho', async () => {
    let t = 0;
    const buscar = vi.fn(async () => 'c3');
    const c = cuentaDeClaude(buscar, { existe: () => true, ahora: () => t });
    await c.home('homero');
    t = 30_000;
    await c.home('homero');
    expect(buscar).toHaveBeenCalledTimes(1);
    t = 61_000;
    await c.home('homero');
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it('pedirTexto pasa el HOME al SDK', async () => {
    let opciones: Record<string, unknown> = {};
    const query = (a: { prompt: string; options: Record<string, unknown> }) => {
      opciones = a.options;
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'hola' };
      })();
    };
    await pedirTexto('x', { sistema: 's', home: '/srv/slots/c3', query });
    expect((opciones.env as Record<string, string>).HOME).toBe('/srv/slots/c3');
    await pedirTexto('x', { sistema: 's', query });
    expect(opciones.env).toBeUndefined();
  });
});
