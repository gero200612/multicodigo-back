import { describe, it, expect } from 'vitest';
import { conCodigoParaTelegram, partirParaTelegram, TOPE_DE_MENSAJE } from '../src/codigo.js';

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

describe('el Markdown que escribe el agente', () => {
  // El caso que lo motivo: la respuesta de un turno real llegaba al telefono
  // con los asteriscos y los guiones a la vista.
  it('la negrita se ve en negrita y no con asteriscos', () => {
    expect(conCodigoParaTelegram('quedan **6 bugs pendientes** sin resolver')).toBe(
      'quedan <b>6 bugs pendientes</b> sin resolver',
    );
  });

  it('una lista se ve con vinetas y no con guiones', () => {
    expect(conCodigoParaTelegram('- Login: la sesion expira\n- Stock: redirige mal')).toBe(
      '• Login: la sesion expira\n• Stock: redirige mal',
    );
  });

  it('un titulo va en negrita, sin los numerales', () => {
    expect(conCodigoParaTelegram('## Debug')).toBe('<b>Debug</b>');
  });

  it('la cursiva con asterisco si, la del guion bajo no', () => {
    expect(conCodigoParaTelegram('esto es *importante*')).toBe('esto es <i>importante</i>');
    // `mi_variable_larga` es texto normal en este producto: convertirlo en
    // cursiva por la mitad seria peor que no tener cursivas.
    expect(conCodigoParaTelegram('mira mi_variable_larga')).toBe('mira mi_variable_larga');
  });

  it('un link se puede tocar', () => {
    expect(conCodigoParaTelegram('[el panel](https://punchi.dev/archivos)')).toBe(
      '<a href="https://punchi.dev/archivos">el panel</a>',
    );
  });

  // Lo que ya andaba y no se puede romper.
  it('el codigo inline sigue siendo codigo, y lo de adentro no se toca', () => {
    expect(conCodigoParaTelegram('corre `npm **test**` ahora')).toBe(
      'corre <code>npm **test**</code> ahora',
    );
  });

  it('el escapado sigue primero: un tag mencionado no rompe el mensaje', () => {
    expect(conCodigoParaTelegram('usa **<div>** ahi')).toBe('usa <b>&lt;div&gt;</b> ahi');
  });

  it('un asterisco suelto no abre nada', () => {
    expect(conCodigoParaTelegram('2 * 3 = 6')).toBe('2 * 3 = 6');
  });
});

describe('partirParaTelegram', () => {
  // El caso real: el plan de `despacho2` medía 5300 caracteres y Telegram lo
  // rechazó entero, con lo que la corrida quedó esperando un botón que nunca
  // se dibujó. Ver `partirParaTelegram`.
  it('parte un mensaje que se pasa del tope', () => {
    const linea = 'Back (despacho2-back): implementar el modulo y los endpoints de pedidos. ';
    const texto = Array.from({ length: 80 }, (_, i) => `${i + 1}. ${linea.repeat(3)}`).join('\n');
    expect(texto.length).toBeGreaterThan(TOPE_DE_MENSAJE);

    const partes = partirParaTelegram(texto);
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(TOPE_DE_MENSAJE);
    // Nada se pierde por el camino: es lo unico que el arreglo tiene que
    // garantizar de verdad.
    expect(partes.join('\n')).toBe(texto);
  });

  it('un mensaje que entra vuelve tal cual, en una sola parte', () => {
    expect(partirParaTelegram('📋 <b>El plan</b>\n\n1. una cosa')).toEqual([
      '📋 <b>El plan</b>\n\n1. una cosa',
    ]);
  });

  // Cortar por caracteres partiria `<b>algo</b>` al medio y Telegram rechazaria
  // el pedazo con las etiquetas desbalanceadas: el arreglo tendria el mismo
  // sintoma que el bug.
  it('corta en los saltos de linea, sin partir las etiquetas', () => {
    const l = `<b>${'x'.repeat(300)}</b>`;
    const partes = partirParaTelegram(Array.from({ length: 40 }, () => l).join('\n'));
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) {
      // Cada parte tiene tantas aperturas como cierres.
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
    }
  });

  // No pasa hoy —la tarea mas larga medida son 1251 caracteres— pero el texto
  // lo escribe un modelo, y "no deberia" no alcanza para el mensaje que no se
  // puede perder.
  it('una sola linea mas larga que el tope se parte igual', () => {
    const partes = partirParaTelegram('y'.repeat(TOPE_DE_MENSAJE * 2 + 15));
    expect(partes).toHaveLength(3);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(TOPE_DE_MENSAJE);
    expect(partes.join('')).toHaveLength(TOPE_DE_MENSAJE * 2 + 15);
  });

  it('nunca devuelve cero partes, que seria el mismo silencio', () => {
    expect(partirParaTelegram('\n'.repeat(TOPE_DE_MENSAJE + 10)).length).toBeGreaterThan(0);
  });
});
