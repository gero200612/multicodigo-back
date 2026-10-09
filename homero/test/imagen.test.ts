import { describe, expect, it } from 'vitest';
import { ErrorDePlantilla, imagenDeAnuncio, medir, svgDeAnuncio } from '../src/imagen.js';
import { ANTES_DESPUES, CHAT, PANEL } from './ejemplos.js';

const tamanioDe = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe('las plantillas de anuncio', () => {
  it('chat: el teléfono con mensajes, la flecha y la planilla con checks', () => {
    expect(svgDeAnuncio('chat', CHAT)).toMatchSnapshot();
  });

  it('panel: el stock con barras y estados, el aviso y el destacado', () => {
    expect(svgDeAnuncio('panel', PANEL)).toMatchSnapshot();
  });

  it('antes y después: dos columnas de cuatro', () => {
    expect(svgDeAnuncio('antes_despues', ANTES_DESPUES)).toMatchSnapshot();
  });

  it('el PNG es de 1080x1080, y el del revisor más chico', () => {
    for (const [p, c] of [
      ['chat', CHAT],
      ['panel', PANEL],
      ['antes_despues', ANTES_DESPUES],
    ] as const) {
      const png = imagenDeAnuncio(p, c);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(tamanioDe(png)).toEqual([1080, 1080]);
    }
    expect(tamanioDe(imagenDeAnuncio('chat', CHAT, 720))).toEqual([720, 720]);
  });

  it('el título se corta en dos renglones parejos, o donde dice el agente', () => {
    expect(svgDeAnuncio('chat', CHAT)).toContain('>Las facturas se</text>');
    expect(svgDeAnuncio('chat', { ...CHAT, titulo: 'Las facturas\nse cargan solas.' })).toContain('>Las facturas</text>');
  });

  it('escapa lo que rompería el SVG', () => {
    const svg = svgDeAnuncio('antes_despues', { ...ANTES_DESPUES, titulo: 'Stock & ventas <sin> errores' });
    expect(svg).toContain('Stock &amp; ventas<');
    expect(svg).toContain('&lt;sin&gt; errores<');
  });

  it('mide con la fuente de verdad: una i es más angosta que una m', () => {
    expect(medir('iiiiiiii', 20)).toBeLessThan(medir('mmmmmmmm', 20) / 2);
  });

  it('un texto que no entra se rechaza diciendo qué campo y cuántas letras entran', () => {
    const largo = { ...CHAT, resultado: { ...CHAT.resultado, filas: [...CHAT.resultado.filas] } };
    largo.resultado.filas[2] = { nombre: 'Mayorista Mmmw Wwwm Hermanos', detalle: '$96.800' };
    expect(() => svgDeAnuncio('chat', largo)).toThrow(ErrorDePlantilla);
    expect(() => svgDeAnuncio('chat', largo)).toThrow(/^resultado\.filas\[2\]\.nombre: .*no entra .*Dejalo en \d+ letras o menos/);

    expect(() => svgDeAnuncio('panel', { ...PANEL, aviso: { ...PANEL.aviso, titulo: 'Falta la correa del Volkswagen Gol' } })).toThrow(
      /^aviso\.titulo/,
    );
    expect(() =>
      svgDeAnuncio('antes_despues', {
        ...ANTES_DESPUES,
        titulo: 'Mmmmm wwwww mmmmm wwwww mmmmm wwwww mmmmm wwwww',
      }),
    ).toThrow(/^titulo: .*2 renglones/);
  });

  it('el esquema rechaza campos de más, de menos o demasiado largos', () => {
    expect(() => svgDeAnuncio('chat', { ...CHAT, extra: 1 })).toThrow(/contenido de "chat"/);
    expect(() => svgDeAnuncio('panel', { ...PANEL, destacado: undefined })).toThrow(/destacado/);
    expect(() =>
      svgDeAnuncio('antes_despues', { ...ANTES_DESPUES, antes: { ...ANTES_DESPUES.antes, items: ANTES_DESPUES.antes.items.slice(0, 2) } }),
    ).toThrow(/antes\.items/);
    expect(() => svgDeAnuncio('nada' as 'chat', CHAT)).toThrow(/plantilla desconocida/);
  });

  it('una cifra destacada larga baja de tamaño antes de rechazarse', () => {
    const svg = svgDeAnuncio('panel', { ...PANEL, destacado: { grande: 'Avisos', texto: 'antes de que falte' } });
    expect(svg).toMatch(/font-size="(5\d|6\d|7\d|80)"[^>]*>Avisos</);
    expect(() => svgDeAnuncio('panel', { ...PANEL, destacado: { grande: 'WWWWWWWW', texto: 'x' } })).toThrow(/^destacado\.grande/);
  });
});
