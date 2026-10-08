import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

/**
 * La imagen de un anuncio: 1080x1080, el azul de Sincro, la frase grande en
 * blanco y la marca chica abajo.
 *
 * Sale de una plantilla SVG que se rasteriza con resvg: la imagen de Homero no
 * tiene Chromium, y para una frase y una marca no hace falta. La fuente (Inter,
 * licencia OFL) va en el repo y es la UNICA que se carga: sin fuentes del
 * sistema, la misma frase da la misma imagen en Windows y en la Toshiba.
 *
 * El SVG no corta renglones solo: el corte se hace aca, midiendo con el ancho
 * promedio de las letras de Inter.
 */

const LADO = 1080;
const MARGEN = 96;
const AZUL = '#0166FE';
const BLANCO = '#FFFFFF';
const NEGRO = '#000000';

const FUENTES = ['Inter-Bold.ttf', 'Inter-Regular.ttf'].map((f) =>
  fileURLToPath(new URL(`../assets/fuentes/${f}`, import.meta.url)),
);

/**
 * Ancho de cada letra de Inter Bold en "ems". No es exacto letra por letra: es
 * para no pasarse del margen, y por eso redondea para arriba.
 */
function anchoEnEms(t: string): number {
  let w = 0;
  for (const c of t) {
    if (c === ' ') w += 0.26;
    else if ('iljtfI.,:;!|\''.includes(c)) w += 0.32;
    else if ('mwMW'.includes(c)) w += 0.92;
    else if (c >= 'A' && c <= 'Z') w += 0.7;
    else if (/[0-9]/.test(c)) w += 0.62;
    else w += 0.58;
  }
  return w;
}

/** Corta la frase en renglones que entran en `ancho` a ese tamaño. Una palabra sola nunca se parte. */
export function cortarRenglones(frase: string, tamanio: number, ancho: number): string[] {
  const renglones: string[] = [];
  let actual = '';
  for (const palabra of frase.trim().split(/\s+/).filter(Boolean)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (actual && anchoEnEms(prueba) * tamanio > ancho) {
      renglones.push(actual);
      actual = palabra;
    } else {
      actual = prueba;
    }
  }
  if (actual) renglones.push(actual);
  return renglones;
}

/** El tamaño mas grande en que la frase entra en cinco renglones sin pasarse de ancho. */
export function acomodar(frase: string): { tamanio: number; renglones: string[] } {
  const ancho = LADO - 2 * MARGEN;
  for (let tamanio = 132; tamanio > 56; tamanio -= 4) {
    const renglones = cortarRenglones(frase, tamanio, ancho);
    const entra = renglones.every((r) => anchoEnEms(r) * tamanio <= ancho);
    if (renglones.length <= 5 && entra) return { tamanio, renglones };
  }
  return { tamanio: 56, renglones: cortarRenglones(frase, 56, ancho) };
}

const escapar = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** La plantilla. Aparte del PNG para poder testearla sin rasterizar. */
export function svgDeAnuncio(frase: string): string {
  const { tamanio, renglones } = acomodar(frase);
  const interlineado = Math.round(tamanio * 1.12);
  // El bloque de texto queda centrado un poco arriba del medio (abajo va la
  // marca), y nunca encima de la rayita de arriba.
  const alto = interlineado * renglones.length;
  const arriba = Math.round(Math.max(MARGEN + 56 + tamanio * 0.8, (LADO - 160 - alto) / 2 + tamanio * 0.8));
  const lineas = renglones
    .map((r, i) => `<tspan x="${MARGEN}" y="${arriba + i * interlineado}">${escapar(r)}</tspan>`)
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LADO}" height="${LADO}" viewBox="0 0 ${LADO} ${LADO}">`,
    `<rect width="${LADO}" height="${LADO}" fill="${AZUL}"/>`,
    `<rect x="${MARGEN}" y="${MARGEN}" width="120" height="14" rx="7" fill="${BLANCO}"/>`,
    `<text font-family="Inter" font-weight="700" font-size="${tamanio}" fill="${BLANCO}" letter-spacing="-1">${lineas}</text>`,
    `<rect x="${MARGEN}" y="${LADO - MARGEN - 64}" width="208" height="64" rx="32" fill="${NEGRO}"/>`,
    `<text x="${MARGEN + 104}" y="${LADO - MARGEN - 21}" text-anchor="middle" font-family="Inter" font-weight="700" font-size="36" fill="${BLANCO}">Sincro</text>`,
    `<text x="${LADO - MARGEN}" y="${LADO - MARGEN - 21}" text-anchor="end" font-family="Inter" font-weight="400" font-size="30" fill="${BLANCO}">sincroresto.com</text>`,
    '</svg>',
  ].join('');
}

/** El PNG de 1080x1080 listo para subir a Meta y mandar por Telegram. */
export function imagenDeAnuncio(frase: string): Buffer {
  const r = new Resvg(svgDeAnuncio(frase), {
    font: { fontFiles: FUENTES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: LADO },
  });
  return Buffer.from(r.render().asPng());
}
