import { describe, it, expect } from 'vitest';
import { conCodigoParaTelegram } from '../src/codigo.js';

/**
 * Los bloques cortos de codigo se muestran como consola.
 *
 * Antes se borraban enteros y quedaba «codigo omitido — 3 lineas»: para un
 * console.log o un mensaje de error eso es esconder justo lo que se venia a
 * leer. Un volcado largo SI se sigue recortando — en la pantalla de un telefono
 * tapa la explicacion, que es la respuesta de verdad.
 */
describe('conCodigoParaTelegram', () => {
  it('deja la prosa intacta', () => {
    const t = 'El servicio de stock valida los lotes.';
    expect(conCodigoParaTelegram(t)).toBe(t);
  });

  it('un bloque corto sale como <pre>', () => {
    const out = conCodigoParaTelegram('Mira:\n```\nconsole.log(x)\n```\nY listo.');
    expect(out).toBe('Mira:\n<pre>console.log(x)</pre>\nY listo.');
  });

  // Lo que hace que se pueda mandar como HTML sin romper el mensaje: un `<` en
  // el codigo cerraria una etiqueta que no existe y Telegram rechaza el envio
  // entero con "can't parse entities".
  it('escapa el HTML de adentro', () => {
    const out = conCodigoParaTelegram('```\nif (a < b && c > d) {}\n```');
    expect(out).toBe('<pre>if (a &lt; b &amp;&amp; c &gt; d) {}</pre>');
  });

  it('el codigo inline de un backtick tambien', () => {
    const out = conCodigoParaTelegram('Toca `src/lote.ts` en la 44.');
    expect(out).toBe('Toca <code>src/lote.ts</code> en la 44.');
  });

  // Un volcado de 200 lineas en el celular tapa la explicacion.
  it('un bloque largo se recorta y dice cuanto falta', () => {
    const largo = Array.from({ length: 40 }, (_, i) => `linea ${i + 1}`).join('\n');
    const out = conCodigoParaTelegram('```\n' + largo + '\n```');

    expect(out).toContain('linea 1');
    expect(out).toContain('linea 20');
    expect(out).not.toContain('linea 21');
    expect(out).toContain('20 lineas mas');
  });

  it('varios bloques se convierten por separado', () => {
    const out = conCodigoParaTelegram('```\na\n```\ntexto\n```\nb\n```');
    expect(out).toBe('<pre>a</pre>\ntexto\n<pre>b</pre>');
  });

  // El agente a veces no cierra el bloque cuando se queda sin tokens.
  it('un bloque sin cerrar se muestra igual', () => {
    const out = conCodigoParaTelegram('texto\n```py\nimport os');
    expect(out).toBe('texto\n<pre>import os</pre>');
  });

  it('un bloque vacio no deja un <pre> hueco', () => {
    expect(conCodigoParaTelegram('```\n```')).toBe('');
  });

  // La prosa se manda como HTML, asi que un `<` suelto en el texto normal
  // rompe el mensaje igual que uno dentro del codigo.
  it('escapa tambien el HTML de la prosa', () => {
    expect(conCodigoParaTelegram('usa <div> ahi')).toBe('usa &lt;div&gt; ahi');
  });

  it('la etiqueta de lenguaje no aparece en la salida', () => {
    expect(conCodigoParaTelegram('```typescript\nconst a = 1;\n```')).toBe(
      '<pre>const a = 1;</pre>',
    );
  });
});
