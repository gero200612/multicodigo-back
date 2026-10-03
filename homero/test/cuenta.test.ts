import { describe, expect, it } from 'vitest';
import { cuentaDeClaude } from '../src/cuenta.js';
import { pedirTexto } from '../src/ia.js';

describe('cuenta de Claude de cada bot', () => {
  it('Homero usa siempre su HOME (ahí el login deja la cedida)', () => {
    expect(cuentaDeClaude({ existe: () => true }).home('homero')).toBeUndefined();
  });

  it('Patán usa la suya si tiene credencial, si no la de Homero', () => {
    expect(cuentaDeClaude({ homePatan: '/home/patan', existe: () => true }).home('patan')).toBe('/home/patan');
    expect(cuentaDeClaude({ homePatan: '/home/patan', existe: () => false }).home('patan')).toBeUndefined();
  });

  it('pedirTexto pasa el HOME al SDK solo si hay uno', async () => {
    let opciones: Record<string, unknown> = {};
    const query = (a: { prompt: string; options: Record<string, unknown> }) => {
      opciones = a.options;
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'hola' };
      })();
    };
    await pedirTexto('x', { sistema: 's', home: '/home/patan', query });
    expect((opciones.env as Record<string, string>).HOME).toBe('/home/patan');
    await pedirTexto('x', { sistema: 's', query });
    expect(opciones.env).toBeUndefined();
  });
});
