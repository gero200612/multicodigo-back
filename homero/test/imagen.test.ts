import { describe, expect, it } from 'vitest';
import { acomodar, imagenDeAnuncio, svgDeAnuncio } from '../src/imagen.js';

describe('la imagen del anuncio', () => {
  it('la plantilla: azul de Sincro, la frase cortada en renglones y la marca', () => {
    expect(svgDeAnuncio('¿Tu estudio contable todavía carga facturas a mano?')).toMatchSnapshot();
  });

  it('escapa lo que rompería el SVG', () => {
    const svg = svgDeAnuncio('Stock & ventas <sin> errores');
    expect(svg).toContain('Stock &amp;');
    expect(svg).toContain('ventas &lt;sin&gt;');
  });

  it('una frase larga baja de tamaño y nunca pasa de cinco renglones', () => {
    const corta = acomodar('Cero turnos perdidos');
    const larga = acomodar('Los pedidos que hoy entran por WhatsApp y por teléfono quedan cargados solos, sin errores');
    expect(larga.tamanio).toBeLessThan(corta.tamanio);
    expect(larga.renglones.length).toBeLessThanOrEqual(5);
  });

  it('el PNG es de 1080x1080', () => {
    const png = imagenDeAnuncio('Cero turnos perdidos');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    // IHDR: ancho y alto en los bytes 16 a 23.
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1080);
  });
});
