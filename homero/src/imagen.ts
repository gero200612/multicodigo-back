import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Las imagenes de los anuncios: tres plantillas que MUESTRAN lo que hace Sincro
 * (un chat que termina en una planilla al dia, un panel con avisos, un antes y
 * despues), no una pantalla con una frase. Gero las aprobo como prototipo el
 * 2026-10-08; el dibujo es ese, con los textos como parametros.
 *
 * El publicista elige la plantilla y escribe los textos; aca se dibuja. Ningun
 * texto puede desbordar su caja: cada uno se MIDE con la fuente de verdad (la
 * misma que dibuja) y si no entra se rechaza diciendo que campo y cuantas
 * letras entran, para que el agente lo acorte. Nada se recorta en silencio.
 *
 * Se rasteriza con resvg: la imagen de Homero no tiene Chromium. La fuente
 * (Inter, licencia OFL) va en el repo y es la UNICA que se carga.
 */

const LADO = 1080;
const FUENTES = ['Inter-Bold.ttf', 'Inter-Regular.ttf'].map((f) =>
  fileURLToPath(new URL(`../assets/fuentes/${f}`, import.meta.url)),
);
const OPCIONES_DE_FUENTE = { fontFiles: FUENTES, loadSystemFonts: false, defaultFontFamily: 'Inter' };

const AZUL = '#0166FE';
const AZUL_OSC = '#0047C2';
const AZUL_CLARO = '#3D8BFF';
const NOCHE = '#0A1633';
const BLANCO = '#FFFFFF';
const VERDE = '#16C784';
const ROJO = '#FF5A5F';
const AMBAR = '#FFB020';
const GRIS = '#E9EEF6';
const TINTA = '#13203D';
const TENUE = '#6B7A99';

// ------------------------------------------------------------ medir

/** Un texto que no entra: lo lee el agente, asi que dice que campo y cuanto entra. */
export class ErrorDePlantilla extends Error {}

const medidas = new Map<string, number>();

/** Hasta donde llega un texto (en px, desde su x) con Inter a ese tamaño y peso. */
export function medir(texto: string, tamanio: number, peso = 700, espaciado = 0): number {
  if (!texto.trim()) return 0;
  const clave = `${tamanio}|${peso}|${espaciado}|${texto}`;
  const hecha = medidas.get(clave);
  if (hecha !== undefined) return hecha;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="${tamanio * 3}">` +
    `<text x="0" y="${tamanio * 2}" font-family="Inter" font-weight="${peso}" font-size="${tamanio}" letter-spacing="${espaciado}">${escapar(texto)}</text></svg>`;
  const caja = new Resvg(svg, { font: OPCIONES_DE_FUENTE }).getBBox();
  const ancho = caja ? caja.x + caja.width : 0;
  medidas.set(clave, ancho);
  return ancho;
}

/** Tira el error del campo si el texto no entra en `max` px. */
function cabe(campo: string, texto: string, tamanio: number, max: number, peso = 700, espaciado = 0): number {
  const ancho = medir(texto, tamanio, peso, espaciado);
  if (ancho > max) {
    const entran = Math.max(1, Math.floor((texto.length * max) / ancho));
    throw new ErrorDePlantilla(
      `${campo}: "${texto}" no entra (mide ${Math.ceil(ancho)} px y el lugar es de ${max} px). Dejalo en ${entran} letras o menos.`,
    );
  }
  return ancho;
}

/** Corta en renglones que entran en `max` px; `undefined` si una palabra sola no entra. */
function renglones(texto: string, tamanio: number, max: number, peso = 700, espaciado = 0): string[] | undefined {
  const salida: string[] = [];
  for (const parrafo of texto.split('\n')) {
    let actual = '';
    for (const palabra of parrafo.trim().split(/\s+/).filter(Boolean)) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (medir(prueba, tamanio, peso, espaciado) <= max) actual = prueba;
      else {
        if (!actual) return undefined;
        salida.push(actual);
        actual = palabra;
        if (medir(actual, tamanio, peso, espaciado) > max) return undefined;
      }
    }
    if (actual) salida.push(actual);
  }
  return salida;
}

/** Un texto en hasta `lineas` renglones, o el error del campo. */
function enRenglones(campo: string, texto: string, tamanio: number, max: number, lineas: number, peso = 700, espaciado = 0): string[] {
  const r = renglones(texto, tamanio, max, peso, espaciado);
  if (r && r.length <= lineas) return r;
  const entran = Math.max(1, Math.floor((texto.length * max * lineas) / Math.max(1, medir(texto, tamanio, peso, espaciado))) - 2);
  throw new ErrorDePlantilla(
    `${campo}: "${texto}" no entra en ${lineas === 1 ? 'un renglón' : `${lineas} renglones`} de ${max} px. Dejalo en unas ${entran} letras o menos (o con palabras más cortas).`,
  );
}

// ------------------------------------------------------------ dibujo

function escapar(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Estilo {
  peso?: number;
  color?: string;
  ancla?: 'middle' | 'end';
  espaciado?: number;
  opacidad?: number;
}

function T(x: number, y: number, tamanio: number, texto: string, o: Estilo = {}): string {
  return (
    `<text x="${x}" y="${y}" font-family="Inter" font-weight="${o.peso ?? 700}" font-size="${tamanio}" fill="${o.color ?? BLANCO}"` +
    `${o.ancla ? ` text-anchor="${o.ancla}"` : ''}${o.espaciado != null ? ` letter-spacing="${o.espaciado}"` : ''}` +
    `${o.opacidad ? ` opacity="${o.opacidad}"` : ''}>${escapar(texto)}</text>`
  );
}

/** La S de Sincro: dos medias lunas. El arco grande sale de (a0 - a1 + 360) % 360. */
function ese(cx: number, cy: number, r: number, color: string, grosor: number): string {
  const arco = (x: number, y: number, a0: number, a1: number) => {
    const p = (a: number) => [x + r * Math.cos((a * Math.PI) / 180), y + r * Math.sin((a * Math.PI) / 180)] as const;
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    const grande = (a0 - a1 + 360) % 360 > 180 ? 1 : 0;
    return `<path d="M${x0} ${y0} A${r} ${r} 0 ${grande} 0 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${grosor}"/>`;
  };
  return arco(cx, cy - r * 0.55, -30, 97) + arco(cx, cy + r * 0.55, 150, 277);
}

const marca = (x: number, y: number) => `<g>${ese(x + 22, y - 14, 15, BLANCO, 9)}${T(x + 50, y, 34, 'Sincro', { espaciado: -0.5 })}</g>`;

const fondo = () =>
  `<rect width="${LADO}" height="${LADO}" fill="${AZUL}"/>` +
  `<circle cx="1010" cy="70" r="300" fill="${AZUL_CLARO}" opacity="0.35"/>` +
  `<circle cx="40" cy="1060" r="260" fill="${AZUL_OSC}" opacity="0.5"/>`;

const SOMBRA =
  '<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#001a4d" flood-opacity="0.35"/></filter>';

const CTA = 'Quiero verlo';
function cta(): string {
  const ancho = Math.round(medir(`${CTA}  →`, 28)) + 76;
  return `<rect x="80" y="958" width="${ancho}" height="70" rx="35" fill="${BLANCO}"/>` + T(118, 1003, 28, `${CTA}  →`, { color: AZUL }) + marca(830, 1004);
}

const check = (x: number, y: number) =>
  `<circle cx="${x}" cy="${y}" r="16" fill="${VERDE}"/><path d="M${x - 7} ${y} l5 5 l9 -10" stroke="${BLANCO}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
const cruz = (x: number, y: number) =>
  `<circle cx="${x}" cy="${y}" r="16" fill="${ROJO}"/><path d="M${x - 6} ${y - 6} l12 12 M${x + 6} ${y - 6} l-12 12" stroke="${BLANCO}" stroke-width="4" stroke-linecap="round"/>`;
const pdf = (x: number, y: number) =>
  `<rect x="${x}" y="${y}" width="34" height="42" rx="5" fill="${ROJO}"/><text x="${x + 17}" y="${y + 28}" font-family="Inter" font-weight="700" font-size="11" fill="${BLANCO}" text-anchor="middle">PDF</text>`;

const ANCHO_UTIL = 920;

const ANCHO_TITULO = 880;

/**
 * El titulo en uno o dos renglones parejos: de todos los cortes posibles, el
 * que deja el renglon mas largo mas corto. Un salto de linea del agente manda.
 */
function dosRenglones(titulo: string, tamanio: number): string[] | undefined {
  const ancho = (t: string) => medir(t, tamanio, 700, -1.5);
  if (titulo.includes('\n')) {
    const l = titulo.split('\n').map((x) => x.trim()).filter(Boolean);
    return l.length <= 2 && l.every((x) => ancho(x) <= ANCHO_TITULO) ? l : undefined;
  }
  const palabras = titulo.trim().split(/\s+/);
  if (ancho(palabras.join(' ')) <= ANCHO_TITULO) return [palabras.join(' ')];
  let mejor: { l: string[]; max: number } | undefined;
  for (let i = 1; i < palabras.length; i++) {
    const l = [palabras.slice(0, i).join(' '), palabras.slice(i).join(' ')];
    const max = Math.max(...l.map(ancho));
    if (max <= ANCHO_TITULO && (!mejor || max < mejor.max)) mejor = { l, max };
  }
  return mejor?.l;
}

/** Arriba de todo: para quien es, el titulo en dos renglones y, si hay, la bajada. */
function encabezado(c: { publico: string; titulo: string; bajada?: string }, anchoBajada = ANCHO_UTIL): string {
  const publico = c.publico.toUpperCase();
  cabe('publico', publico, 22, ANCHO_UTIL, 700, 3);
  // A 72 px como el prototipo; si no entra en dos renglones, a 64 antes de rechazar.
  let tamanio = 72;
  let lineas = dosRenglones(c.titulo, tamanio);
  if (!lineas) {
    tamanio = 64;
    lineas = dosRenglones(c.titulo, tamanio) ?? enRenglones('titulo', c.titulo, tamanio, ANCHO_TITULO, 2, 700, -1.5);
  }
  const titulo = lineas.map((l, i) => T(80, 180 + i * Math.round(tamanio * 1.1), tamanio, l, { espaciado: -1.5 })).join('');
  if (c.bajada) cabe('bajada', c.bajada, 26, anchoBajada, 400);
  return (
    T(80, 100, 22, publico, { espaciado: 3, opacidad: 0.8 }) +
    titulo +
    (c.bajada ? T(80, 316, 26, c.bajada, { peso: 400, opacidad: 0.9 }) : '')
  );
}

const lienzo = (cuerpo: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${LADO}" height="${LADO}" viewBox="0 0 ${LADO} ${LADO}"><defs>${SOMBRA}</defs>${cuerpo}</svg>`;

// ------------------------------------------------------------ los contenidos

const corto = (max: number) => z.string().trim().min(1).max(max);
const Marco = {
  /** Para quien es: "estudios contables", "talleres". Va en mayusculas arriba. */
  publico: corto(40),
  /** El titulo grande, en dos renglones como mucho. */
  titulo: corto(60),
};

export const ContenidoChat = z
  .object({
    ...Marco,
    bajada: corto(70).optional(),
    chat: z
      .object({
        nombre: corto(24),
        estado: corto(30),
        mensajes: z
          .array(z.union([z.object({ texto: corto(34) }).strict(), z.object({ archivo: corto(28) }).strict()]))
          .min(3)
          .max(5),
      })
      .strict(),
    resultado: z
      .object({
        titulo: corto(26),
        etiqueta: corto(12),
        filas: z.array(z.object({ nombre: corto(28), detalle: corto(30) }).strict()).min(3).max(4),
      })
      .strict(),
  })
  .strict();

export const ContenidoPanel = z
  .object({
    ...Marco,
    panel: z
      .object({
        titulo: corto(30),
        subtitulo: corto(40),
        filas: z
          .array(
            z
              .object({
                nombre: corto(30),
                valor: corto(8),
                /** Cuanto se llena la barra, de 0 a 1. */
                nivel: z.number().min(0).max(1),
                estado: z.enum(['ok', 'bajo', 'alerta']),
                etiqueta: corto(8),
              })
              .strict(),
          )
          .min(3)
          .max(4),
      })
      .strict(),
    aviso: z.object({ titulo: corto(34), detalle: corto(36), pie: corto(32) }).strict(),
    destacado: z.object({ grande: corto(8), texto: corto(40) }).strict(),
  })
  .strict();

const Columna = z
  .object({
    etiqueta: corto(14),
    items: z.array(z.object({ fuerte: corto(28), suave: corto(32) }).strict()).min(3).max(4),
  })
  .strict();

export const ContenidoAntesDespues = z
  .object({ ...Marco, bajada: corto(70).optional(), antes: Columna, despues: Columna })
  .strict();

export const CONTENIDOS = {
  chat: ContenidoChat,
  panel: ContenidoPanel,
  antes_despues: ContenidoAntesDespues,
} as const;
export type Plantilla = keyof typeof CONTENIDOS;
export const PLANTILLAS = Object.keys(CONTENIDOS) as Plantilla[];

export type ContenidoChat = z.infer<typeof ContenidoChat>;
export type ContenidoPanel = z.infer<typeof ContenidoPanel>;
export type ContenidoAntesDespues = z.infer<typeof ContenidoAntesDespues>;

// ------------------------------------------------------------ 1. chat -> planilla

function chat(c: ContenidoChat): string {
  const ch = c.chat;
  cabe('chat.nombre', ch.nombre, 22, 276);
  cabe('chat.estado', ch.estado, 16, 276, 400);
  let y = 476;
  const burbujas = ch.mensajes
    .map((m, i) => {
      const campo = `chat.mensajes[${i}]`;
      let svg: string;
      if ('texto' in m) {
        const w = Math.max(120, Math.round(cabe(`${campo}.texto`, m.texto, 20, 294, 400)) + 40);
        svg = `<rect x="116" y="${y}" width="${w}" height="66" rx="18" fill="${BLANCO}"/>` + T(134, y + 40, 20, m.texto, { peso: 400, color: TINTA });
        y += 66 + 14;
      } else {
        const w = Math.round(cabe(`${campo}.archivo`, m.archivo, 18, 238, 400)) + 92;
        svg = `<rect x="116" y="${y}" width="${w}" height="70" rx="18" fill="${BLANCO}"/>` + pdf(134, y + 14) + T(180, y + 42, 18, m.archivo, { peso: 400, color: TINTA });
        y += 70 + 14;
      }
      return svg;
    })
    .join('');
  const telefono =
    `<g filter="url(#s)"><rect x="80" y="360" width="400" height="560" rx="46" fill="${NOCHE}"/>` +
    `<rect x="96" y="376" width="368" height="528" rx="34" fill="#EFE7DE"/>` +
    `<rect x="96" y="376" width="368" height="78" rx="34" fill="#075E54"/><rect x="96" y="420" width="368" height="34" fill="#075E54"/>` +
    `<circle cx="140" cy="415" r="20" fill="#25D366"/>` +
    T(172, 410, 22, ch.nombre) +
    T(172, 436, 16, ch.estado, { peso: 400, opacidad: 0.85 }) +
    burbujas +
    '</g>';
  const flecha =
    `<path d="M500 640 C 540 600, 560 600, 590 620" stroke="${BLANCO}" stroke-width="7" fill="none" stroke-linecap="round"/>` +
    `<path d="M578 600 L596 624 L568 634" stroke="${BLANCO}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

  const r = c.resultado;
  const anchoEtiqueta = Math.round(cabe('resultado.etiqueta', r.etiqueta, 17, 110)) + 40;
  cabe('resultado.titulo', r.titulo, 24, 984 - anchoEtiqueta - 16 - 640);
  // La tarjeta crece con las filas y queda centrada donde la del prototipo.
  const alto = 208 + (r.filas.length - 1) * 74;
  const y0 = Math.round(645 - alto / 2);
  const d = y0 - 430;
  const tabla =
    `<g filter="url(#s)"><rect x="610" y="${y0}" width="400" height="${alto}" rx="28" fill="${BLANCO}"/>` +
    T(640, 482 + d, 24, r.titulo, { color: TINTA }) +
    `<rect x="${984 - anchoEtiqueta}" y="${458 + d}" width="${anchoEtiqueta}" height="34" rx="17" fill="#E3F9EF"/>` +
    T(984 - anchoEtiqueta / 2, 481 + d, 17, r.etiqueta, { color: VERDE, ancla: 'middle' }) +
    `<line x1="640" y1="${510 + d}" x2="980" y2="${510 + d}" stroke="${GRIS}" stroke-width="2"/>` +
    r.filas
      .map((f, i) => {
        const fy = 556 + d + i * 74;
        cabe(`resultado.filas[${i}].nombre`, f.nombre, 20, 290);
        cabe(`resultado.filas[${i}].detalle`, f.detalle, 17, 290, 400);
        return (
          T(640, fy, 20, f.nombre, { color: TINTA }) +
          T(640, fy + 26, 17, f.detalle, { peso: 400, color: TENUE }) +
          check(962, fy - 4) +
          (i < r.filas.length - 1 ? `<line x1="640" y1="${fy + 44}" x2="980" y2="${fy + 44}" stroke="${GRIS}" stroke-width="2"/>` : '')
        );
      })
      .join('') +
    '</g>';
  return lienzo(fondo() + encabezado(c) + telefono + flecha + tabla + cta());
}

// ------------------------------------------------------------ 2. panel

const COLOR_DE_ESTADO = { ok: VERDE, bajo: AMBAR, alerta: ROJO } as const;

function panel(c: ContenidoPanel): string {
  const p = c.panel;
  // El aviso tapa la esquina de arriba a la derecha del panel: el titulo no llega ahi.
  cabe('panel.titulo', p.titulo, 26, 428);
  cabe('panel.subtitulo', p.subtitulo, 18, 544, 400);
  const alto = 520 - (4 - p.filas.length) * 92;
  const filas = p.filas
    .map((f, i) => {
      const y = 530 + i * 92;
      const color = COLOR_DE_ESTADO[f.estado];
      const anchoValor = cabe(`panel.filas[${i}].valor`, f.valor, 21, 120);
      cabe(`panel.filas[${i}].nombre`, f.nombre, 21, Math.floor(544 - anchoValor - 16));
      cabe(`panel.filas[${i}].etiqueta`, f.etiqueta, 16, 68);
      const lleno = Math.max(10, Math.round(f.nivel * 440));
      return (
        T(116, y, 21, f.nombre, { color: TINTA }) +
        T(660, y, 21, f.valor, { color: TINTA, ancla: 'end' }) +
        `<rect x="116" y="${y + 18}" width="440" height="14" rx="7" fill="${GRIS}"/>` +
        `<rect x="116" y="${y + 18}" width="${lleno}" height="14" rx="7" fill="${color}"/>` +
        `<rect x="576" y="${y + 8}" width="84" height="32" rx="16" fill="${color}" opacity="0.15"/>` +
        T(618, y + 30, 16, f.etiqueta, { color, ancla: 'middle' })
      );
    })
    .join('');
  const tarjeta =
    `<g filter="url(#s)"><rect x="80" y="380" width="620" height="${alto}" rx="30" fill="${BLANCO}"/>` +
    T(116, 438, 26, p.titulo, { color: TINTA }) +
    T(116, 468, 18, p.subtitulo, { peso: 400, color: TENUE }) +
    filas +
    '</g>';

  const a = c.aviso;
  cabe('aviso.titulo', a.titulo, 21, 318);
  cabe('aviso.detalle', a.detalle, 18, 318, 400);
  cabe('aviso.pie', a.pie, 16, 286, 400);
  const aviso =
    `<g filter="url(#s)"><rect x="560" y="300" width="440" height="150" rx="26" fill="${NOCHE}"/>` +
    `<circle cx="616" cy="352" r="26" fill="${AMBAR}"/>` +
    `<path d="M606 360 h20 l-4 -5 v-9 a6 6 0 0 0 -12 0 v9 z M613 364 a3 3 0 0 0 6 0" fill="${NOCHE}"/>` +
    T(658, 346, 21, a.titulo) +
    T(658, 376, 18, a.detalle, { peso: 400, opacidad: 0.8 }) +
    check(970, 410) +
    T(658, 420, 16, a.pie, { peso: 400, opacidad: 0.6 }) +
    '</g>';

  const dst = c.destacado;
  // La cifra grande baja de tamaño antes de rechazarse: "24/7" entra a 84, "Al día" no.
  let tamanio = 84;
  while (tamanio > 56 && medir(dst.grande, tamanio, 700, -2) > 220) tamanio -= 4;
  cabe('destacado.grande', dst.grande, tamanio, 220, 700, -2);
  const texto = enRenglones('destacado.texto', dst.texto, 20, 220, 2, 400);
  const destacado =
    `<g filter="url(#s)"><rect x="740" y="560" width="260" height="300" rx="30" fill="${AZUL_OSC}"/>` +
    T(870, 660, tamanio, dst.grande, { ancla: 'middle', espaciado: -2 }) +
    texto.map((l, i) => T(870, 706 + i * 26, 20, l, { peso: 400, ancla: 'middle', opacidad: 0.85 })).join('') +
    `<path d="M800 800 l40 -24 l30 14 l60 -46" stroke="${VERDE}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  return lienzo(fondo() + encabezado(c) + tarjeta + destacado + aviso + cta());
}

// ------------------------------------------------------------ 3. antes / despues

function antesDespues(c: ContenidoAntesDespues): string {
  const columna = (x: number, campo: 'antes' | 'despues', col: z.infer<typeof Columna>, oscura: boolean) => {
    const anchoEtiqueta = Math.round(cabe(`${campo}.etiqueta`, col.etiqueta, 20, 300)) + 50;
    return (
      `<g filter="url(#s)"><rect x="${x}" y="360" width="440" height="540" rx="30" fill="${oscura ? NOCHE : BLANCO}"/>` +
      `<rect x="${x + 36}" y="396" width="${anchoEtiqueta}" height="42" rx="21" fill="${oscura ? ROJO : VERDE}" opacity="0.18"/>` +
      T(x + 36 + anchoEtiqueta / 2, 425, 20, col.etiqueta, { color: oscura ? ROJO : VERDE, ancla: 'middle' }) +
      col.items
        .map((it, i) => {
          const y = 500 + i * 96;
          cabe(`${campo}.items[${i}].fuerte`, it.fuerte, 22, 326);
          cabe(`${campo}.items[${i}].suave`, it.suave, 22, 326, 400);
          return (
            (oscura ? cruz(x + 52, y - 7) : check(x + 52, y - 7)) +
            T(x + 84, y, 22, it.fuerte, { color: oscura ? BLANCO : TINTA }) +
            T(x + 84, y + 28, 22, it.suave, { peso: 400, color: oscura ? BLANCO : TINTA, opacidad: oscura ? 0.7 : undefined })
          );
        })
        .join('') +
      '</g>'
    );
  };
  return lienzo(
    fondo() + encabezado(c) + columna(80, 'antes', c.antes, true) + columna(560, 'despues', c.despues, false) + cta(),
  );
}

// ------------------------------------------------------------ entrada

/**
 * Valida el contenido de la plantilla y arma el SVG. Si algo no va (falta un
 * campo, sobra uno, un texto no entra en su caja) tira `ErrorDePlantilla` con
 * el detalle para el agente.
 */
export function svgDeAnuncio(plantilla: Plantilla, contenido: unknown): string {
  const esquema = CONTENIDOS[plantilla];
  if (!esquema) throw new ErrorDePlantilla(`plantilla desconocida: usá una de ${PLANTILLAS.join(', ')}`);
  const r = esquema.safeParse(contenido);
  if (!r.success) {
    throw new ErrorDePlantilla(
      `contenido de "${plantilla}": ${r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')}`,
    );
  }
  if (plantilla === 'chat') return chat(r.data as ContenidoChat);
  if (plantilla === 'panel') return panel(r.data as ContenidoPanel);
  return antesDespues(r.data as ContenidoAntesDespues);
}

/** El PNG del anuncio: 1080x1080 para Meta y Telegram; mas chico para que lo mire el revisor. */
export function imagenDeAnuncio(plantilla: Plantilla, contenido: unknown, ancho = LADO): Buffer {
  const r = new Resvg(svgDeAnuncio(plantilla, contenido), {
    font: OPCIONES_DE_FUENTE,
    fitTo: { mode: 'width', value: ancho },
  });
  return Buffer.from(r.render().asPng());
}
