import { Resvg } from '@resvg/resvg-js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { escapar, imagenDeAnuncio, medir, OPCIONES_DE_FUENTE, PLANTILLAS, type Plantilla } from './imagen.js';
import { buscarEnPixabay, elegirTema, ESTILOS, leerBanco, type Estilo, type MedioDePixabay } from './medios.js';

/**
 * El armado de un reel (spec 2026-10-08-homero-reels, parte 2), sin navegador:
 * como las imagenes de los anuncios, cada cuadro fijo se dibuja en SVG con
 * resvg, y ffmpeg anima (zoom lento, deslizamientos), une las escenas con
 * transiciones y le pone la musica del banco normalizada a -14 LUFS.
 *
 * Un reel es un GUION: un estilo de musica y de 3 a 10 escenas. Las escenas:
 * - cartel: texto grande sobre el color de la marca (el gancho, una pregunta).
 * - foto / video: de Pixabay, con zoom lento y un texto encima.
 * - plantilla: una de las tres imagenes de los anuncios (chat, panel,
 *   antes_despues) entrando desde abajo: muestra lo que hace Sincro.
 * - cierre: la marca y la invitacion a escribir.
 */

export const ANCHO = 1080;
export const ALTO = 1920;
export const FPS = 30;
/** Lo que dura cada transicion entre escenas, en segundos. */
export const TRANSICION = 0.35;
const TRANSICIONES = ['fade', 'slideup', 'smoothup', 'wipeleft', 'fadeblack', 'slideleft'];

const AZUL = '#0166FE';
const AZUL_OSC = '#0047C2';
const NOCHE = '#0A1633';
const BLANCO = '#FFFFFF';

const Duracion = z.number().min(1.5).max(7);
const Texto = z.string().trim().min(2).max(70);

export const Escena = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('cartel'), texto: Texto, bajada: z.string().trim().max(90).optional(), fondo: z.enum(['azul', 'noche']).default('noche'), duracion: Duracion }),
  z.object({ tipo: z.literal('foto'), busqueda: z.string().trim().min(2).max(60), texto: Texto.optional(), duracion: Duracion }),
  z.object({ tipo: z.literal('video'), busqueda: z.string().trim().min(2).max(60), texto: Texto.optional(), duracion: Duracion }),
  z.object({
    tipo: z.literal('plantilla'),
    plantilla: z.enum(PLANTILLAS as [Plantilla, ...Plantilla[]]),
    contenido: z.record(z.unknown()),
    titulo: Texto.optional(),
    duracion: Duracion,
  }),
  z.object({ tipo: z.literal('cierre'), texto: Texto.default('¿Te lo armamos?'), duracion: Duracion }),
]);
export type Escena = z.infer<typeof Escena>;

export const Guion = z
  .object({
    estilo: z.enum(Object.keys(ESTILOS) as [Estilo, ...Estilo[]]),
    escenas: z.array(Escena).min(3).max(10),
  })
  .refine((g) => {
    const total = duracionTotal(g.escenas);
    return total >= 12 && total <= 35;
  }, 'el reel tiene que durar entre 12 y 35 segundos (sumando las escenas, menos las transiciones)');
export type Guion = z.infer<typeof Guion>;

/** Lo que dura el reel: las escenas se pisan durante cada transicion. */
export function duracionTotal(escenas: readonly { duracion: number }[]): number {
  return escenas.reduce((n, e) => n + e.duracion, 0) - TRANSICION * Math.max(0, escenas.length - 1);
}

// ------------------------------------------------------------ dibujo (SVG -> PNG)

/** Parte un texto en renglones que entren en `ancho` px con Inter Bold a `tamanio`. */
export function renglones(texto: string, tamanio: number, ancho: number): string[] {
  const salida: string[] = [];
  for (const parrafo of texto.split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (medir(prueba, tamanio) <= ancho || !actual) actual = prueba;
      else {
        salida.push(actual);
        actual = palabra;
      }
    }
    if (actual) salida.push(actual);
  }
  return salida;
}

/** El tamaño mas grande (de `max` para abajo) con el que el texto entra en `lineas` renglones. */
export function tamanioQueEntra(texto: string, ancho: number, lineas: number, max: number, min = 44): number {
  for (let t = max; t >= min; t -= 4) {
    const r = renglones(texto, t, ancho);
    if (r.length <= lineas && r.every((x) => medir(x, t) <= ancho)) return t;
  }
  return min;
}

function bloqueDeTexto(texto: string, o: { y: number; max: number; lineas: number; color?: string; centro?: boolean }): string {
  const ancho = ANCHO - 160;
  const tam = tamanioQueEntra(texto, ancho, o.lineas, o.max);
  const r = renglones(texto, tam, ancho);
  const alto = tam * 1.12;
  const x = o.centro ? ANCHO / 2 : 80;
  return r
    .map(
      (linea, i) =>
        `<text x="${x}" y="${o.y + i * alto}" font-family="Inter" font-weight="700" font-size="${tam}" fill="${o.color ?? BLANCO}"${
          o.centro ? ' text-anchor="middle"' : ''
        } letter-spacing="-1">${escapar(linea)}</text>`,
    )
    .join('');
}

function png(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { font: OPCIONES_DE_FUENTE }).render().asPng());
}

const marca = (y: number, color = BLANCO) =>
  `<g transform="translate(80 ${y})"><rect width="56" height="56" rx="14" fill="${color === BLANCO ? AZUL : BLANCO}"/>` +
  `<text x="28" y="40" font-family="Inter" font-weight="700" font-size="34" fill="${color === BLANCO ? BLANCO : AZUL}" text-anchor="middle">S</text>` +
  `<text x="72" y="40" font-family="Inter" font-weight="700" font-size="34" fill="${color}">Sincro</text></g>`;

const svg = (contenido: string, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${ALTO}" viewBox="0 0 ${ANCHO} ${ALTO}"><defs>${defs}</defs>${contenido}</svg>`;

/** Cartel: texto grande sobre el color de la marca. */
export function cuadroDeCartel(texto: string, bajada: string | undefined, fondo: 'azul' | 'noche'): Buffer {
  const [a, b] = fondo === 'azul' ? [AZUL, AZUL_OSC] : [NOCHE, '#13203D'];
  const defs = `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  return png(
    svg(
      `<rect width="${ANCHO}" height="${ALTO}" fill="url(#f)"/>` +
        `<circle cx="${ANCHO - 60}" cy="260" r="340" fill="${fondo === 'azul' ? BLANCO : AZUL}" opacity="0.08"/>` +
        bloqueDeTexto(texto, { y: 820, max: 120, lineas: 4 }) +
        (bajada ? bloqueDeTexto(bajada, { y: 1380, max: 52, lineas: 3, color: fondo === 'azul' ? '#D6E6FF' : '#9DB4D8' }) : '') +
        marca(ALTO - 180),
      defs,
    ),
  );
}

/** La capa que va sobre una foto o un video: degradado abajo y el texto. Transparente arriba. */
export function capaDeTexto(texto: string | undefined): Buffer {
  const defs = `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="${NOCHE}" stop-opacity="0"/><stop offset="1" stop-color="${NOCHE}" stop-opacity="0.92"/></linearGradient>`;
  return png(
    svg(`<rect width="${ANCHO}" height="${ALTO}" fill="url(#g)"/>` + (texto ? bloqueDeTexto(texto, { y: 1400, max: 96, lineas: 3 }) : '') + marca(ALTO - 160), defs),
  );
}

/** El fondo de una escena de plantilla: el titulo arriba; la imagen entra despues, animada. */
export function fondoDePlantilla(titulo: string | undefined): Buffer {
  const defs = `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${NOCHE}"/><stop offset="1" stop-color="#0E2350"/></linearGradient>`;
  return png(svg(`<rect width="${ANCHO}" height="${ALTO}" fill="url(#f)"/>` + (titulo ? bloqueDeTexto(titulo, { y: 300, max: 84, lineas: 2 }) : '') + marca(ALTO - 180), defs));
}

/** El cierre: la invitacion a escribir, en azul. */
export function cuadroDeCierre(texto: string): Buffer {
  return png(
    svg(
      `<rect width="${ANCHO}" height="${ALTO}" fill="${AZUL}"/>` +
        bloqueDeTexto(texto, { y: 780, max: 112, lineas: 3, centro: true }) +
        `<rect x="${ANCHO / 2 - 300}" y="1180" width="600" height="130" rx="65" fill="${BLANCO}"/>` +
        `<text x="${ANCHO / 2}" y="1265" font-family="Inter" font-weight="700" font-size="54" fill="${AZUL}" text-anchor="middle">Escribinos</text>` +
        `<text x="${ANCHO / 2}" y="1420" font-family="Inter" font-weight="400" font-size="44" fill="#D6E6FF" text-anchor="middle">@sincro_ar</text>` +
        `<text x="${ANCHO / 2}" y="${ALTO - 140}" font-family="Inter" font-weight="700" font-size="40" fill="${BLANCO}" text-anchor="middle">Sincro</text>`,
    ),
  );
}

// ------------------------------------------------------------ ffmpeg

export type CorrerFfmpeg = (args: string[]) => Promise<void>;

/** ffmpeg con pocos hilos: corre al lado de los agentes en la Toshiba. */
export const ffmpegReal: CorrerFfmpeg = (args) =>
  new Promise((ok, mal) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    p.stderr.on('data', (d: Buffer) => (error = (error + d.toString()).slice(-2000)));
    p.on('error', mal);
    p.on('close', (codigo) => (codigo === 0 ? ok() : mal(new Error(`ffmpeg salió con ${codigo}: ${error.trim()}`))));
  });

const SALIDA_DE_SEGMENTO = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '2', '-an'];

/** Zoom lento (Ken Burns) sobre una imagen, hacia adentro o hacia afuera. */
function zoomLento(cuadros: number, hacia: 'adentro' | 'afuera'): string {
  const z = hacia === 'adentro' ? `min(1+0.10*on/${cuadros},1.10)` : `max(1.10-0.10*on/${cuadros},1)`;
  return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${cuadros}:s=${ANCHO}x${ALTO}:fps=${FPS}`;
}

/** Los argumentos de ffmpeg para el segmento de una escena (sin audio). */
export function argsDeSegmento(
  e: Escena,
  archivos: { cuadro?: string; capa?: string; medio?: string; tarjeta?: string },
  salida: string,
  i: number,
): string[] {
  const cuadros = Math.round(e.duracion * FPS);
  const t = String(e.duracion);
  switch (e.tipo) {
    case 'cartel':
    case 'cierre':
      return ['-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.cuadro!, '-vf', `scale=${ANCHO * 1.1}:-2,${zoomLento(cuadros, i % 2 ? 'afuera' : 'adentro')}`, '-t', t, ...SALIDA_DE_SEGMENTO, salida];
    case 'foto':
      return [
        '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.medio!,
        '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.capa!,
        '-filter_complex',
        `[0]scale=${ANCHO * 1.15}:${ALTO * 1.15}:force_original_aspect_ratio=increase,crop=${ANCHO * 1.15}:${ALTO * 1.15},${zoomLento(cuadros, i % 2 ? 'afuera' : 'adentro')}[f];[f][1]overlay=0:0,format=yuv420p`,
        '-t', t, ...SALIDA_DE_SEGMENTO, salida,
      ];
    case 'video':
      return [
        '-stream_loop', '-1', '-t', t, '-i', archivos.medio!,
        '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.capa!,
        '-filter_complex',
        `[0]scale=${ANCHO}:${ALTO}:force_original_aspect_ratio=increase,crop=${ANCHO}:${ALTO},fps=${FPS},setpts=PTS-STARTPTS[v];[v][1]overlay=0:0,format=yuv420p`,
        '-t', t, ...SALIDA_DE_SEGMENTO, salida,
      ];
    case 'plantilla': {
      // La tarjeta entra desde abajo en medio segundo, y despues respira.
      const y0 = 560;
      return [
        '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.cuadro!,
        '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', archivos.tarjeta!,
        '-filter_complex',
        `[1]scale=960:-2,format=rgba,fade=t=in:st=0:d=0.45:alpha=1[c];[0][c]overlay=x=60:y='${y0}+180*max(0\\,1-t/0.5)-6*sin(t*2)':shortest=1,format=yuv420p`,
        '-t', t, ...SALIDA_DE_SEGMENTO, salida,
      ];
    }
  }
}

/** Une los segmentos con transiciones y pone la musica (o silencio). */
export function argsDeUnion(segmentos: string[], duraciones: number[], musica: { archivo: string; desde: number } | undefined, salida: string): string[] {
  const total = duracionTotal(duraciones.map((duracion) => ({ duracion })));
  const entradas = segmentos.flatMap((s) => ['-i', s]);
  const partes: string[] = [];
  let anterior = '[0:v]';
  let offset = 0;
  for (let k = 1; k < segmentos.length; k++) {
    offset += duraciones[k - 1]! - TRANSICION;
    const sale = k === segmentos.length - 1 ? '[v]' : `[v${k}]`;
    partes.push(`${anterior}[${k}:v]xfade=transition=${TRANSICIONES[(k - 1) % TRANSICIONES.length]}:duration=${TRANSICION}:offset=${offset.toFixed(3)}${sale}`);
    anterior = sale;
  }
  const n = segmentos.length;
  const audio = musica
    ? ['-ss', String(musica.desde), '-t', String(total), '-i', musica.archivo]
    : ['-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo'];
  const filtroDeAudio = musica
    ? `[${n}:a]afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]`
    : `[${n}:a]anull[a]`;
  return [
    ...entradas,
    ...audio,
    '-filter_complex', [...partes, filtroDeAudio].join(';'),
    '-map', n > 1 ? '[v]' : '0:v', '-map', '[a]',
    '-t', total.toFixed(3),
    '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    salida,
  ];
}

// ------------------------------------------------------------ armado

export interface DepsDeReel {
  /** Donde viven los medios (/srv/medios): el banco de musica y los reels armados. */
  dir: string;
  /** La clave de Pixabay. Sin clave, las escenas de foto o video salen como cartel con el mismo texto. */
  pixabay?: string;
  pedir?: typeof fetch;
  ffmpeg?: CorrerFfmpeg;
  /** Los ids de los temas usados en los ultimos reels: no se repiten. */
  temasRecientes?: string[];
  /** Los medios de Pixabay ya usados: no se repiten. */
  mediosRecientes?: number[];
  azar?: () => number;
}

export interface ReelArmado {
  archivo: string;
  duracion: number;
  tema?: { id: string; titulo: string; autor: string; pagina: string };
  medios: { id: number; pagina: string; autor: string }[];
}

async function bajar(url: string, destino: string, pedir: typeof fetch): Promise<void> {
  const r = await pedir(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`no pude bajar ${url}: ${r.status}`);
  await writeFile(destino, Buffer.from(await r.arrayBuffer()));
}

/**
 * Arma el reel de un guion y lo deja en `<dir>/reels/<nombre>.mp4`. Todo lo
 * intermedio va a una carpeta temporal que se borra al final.
 */
export async function armarReel(guion: Guion, nombre: string, deps: DepsDeReel): Promise<ReelArmado> {
  const g = Guion.parse(guion);
  const ffmpeg = deps.ffmpeg ?? ffmpegReal;
  const pedir = deps.pedir ?? fetch;
  const azar = deps.azar ?? Math.random;
  const tmp = await mkdtemp(join(deps.dir, 'tmp-reel-'));
  const medios: ReelArmado['medios'] = [];
  const usados = new Set(deps.mediosRecientes ?? []);
  try {
    const segmentos: string[] = [];
    for (const [i, original] of g.escenas.entries()) {
      let e: Escena = original;
      const salida = join(tmp, `seg${i}.mp4`);
      const archivos: { cuadro?: string; capa?: string; medio?: string; tarjeta?: string } = {};
      if (e.tipo === 'foto' || e.tipo === 'video') {
        let elegido: MedioDePixabay | undefined;
        if (deps.pixabay) {
          const encontrados = await buscarEnPixabay(e.busqueda, e.tipo, { clave: deps.pixabay, pedir, cantidad: 20 }).catch(() => []);
          const libres = encontrados.filter((m) => !usados.has(m.id)).slice(0, 8);
          elegido = libres[Math.floor(azar() * libres.length)] ?? encontrados[0];
        }
        if (elegido) {
          usados.add(elegido.id);
          medios.push({ id: elegido.id, pagina: elegido.pagina, autor: elegido.autor });
          archivos.medio = join(tmp, `medio${i}.${e.tipo === 'video' ? 'mp4' : 'jpg'}`);
          await bajar(elegido.url, archivos.medio, pedir);
          archivos.capa = join(tmp, `capa${i}.png`);
          await writeFile(archivos.capa, capaDeTexto(e.texto));
        } else {
          // Sin Pixabay (o sin resultados) la escena no se cae: va como cartel.
          e = { tipo: 'cartel', texto: e.texto ?? e.busqueda, fondo: 'noche', duracion: e.duracion };
        }
      }
      if (e.tipo === 'cartel') {
        archivos.cuadro = join(tmp, `cuadro${i}.png`);
        await writeFile(archivos.cuadro, cuadroDeCartel(e.texto, e.bajada, e.fondo));
      } else if (e.tipo === 'cierre') {
        archivos.cuadro = join(tmp, `cuadro${i}.png`);
        await writeFile(archivos.cuadro, cuadroDeCierre(e.texto));
      } else if (e.tipo === 'plantilla') {
        archivos.cuadro = join(tmp, `cuadro${i}.png`);
        await writeFile(archivos.cuadro, fondoDePlantilla(e.titulo));
        archivos.tarjeta = join(tmp, `tarjeta${i}.png`);
        await writeFile(archivos.tarjeta, imagenDeAnuncio(e.plantilla, e.contenido));
      }
      await ffmpeg(argsDeSegmento(e, archivos, salida, i));
      segmentos.push(salida);
    }

    const banco = await leerBanco(deps.dir);
    const tema = elegirTema(banco, g.estilo, deps.temasRecientes ?? []);
    const total = duracionTotal(g.escenas);
    // Desde un poco adelante: los primeros segundos de un loop suelen ser la entrada floja.
    const desde = tema ? Math.max(0, Math.min(tema.duracionMs / 1000 - total, (tema.duracionMs / 1000) * 0.15)) : 0;
    await mkdir(join(deps.dir, 'reels'), { recursive: true });
    const archivo = join(deps.dir, 'reels', `${nombre}.mp4`);
    await ffmpeg(
      argsDeUnion(
        segmentos,
        g.escenas.map((x) => x.duracion),
        tema ? { archivo: join(deps.dir, 'musica', tema.archivo), desde: Math.round(desde * 10) / 10 } : undefined,
        archivo,
      ),
    );
    return {
      archivo,
      duracion: total,
      ...(tema ? { tema: { id: tema.id, titulo: tema.titulo, autor: tema.autor, pagina: tema.pagina } } : {}),
      medios,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Un guion de muestra para probar el armado (/reel_prueba): facturas que se cargan solas. */
export const GUION_DE_PRUEBA: Guion = {
  estilo: 'tech',
  escenas: [
    { tipo: 'cartel', texto: '¿Cuántas horas por semana se van en cargar facturas?', fondo: 'noche', duracion: 3.2 },
    { tipo: 'foto', busqueda: 'paperwork office desk', texto: 'Papeles, fotos por WhatsApp, planillas a mano…', duracion: 3.4 },
    {
      tipo: 'plantilla',
      plantilla: 'chat',
      titulo: 'Te llegan por WhatsApp',
      contenido: {
        publico: 'Para estudios contables',
        titulo: 'Las facturas se cargan solas',
        bajada: 'Llegan por WhatsApp y quedan ordenadas.',
        chat: {
          nombre: 'Clientes',
          estado: '12 mensajes nuevos',
          mensajes: [{ texto: 'Te paso la de octubre' }, { archivo: 'factura_0912.pdf' }, { archivo: 'factura_0913.pdf' }, { texto: '¿Llegaron bien?' }],
        },
        resultado: {
          titulo: 'Facturas cargadas',
          etiqueta: 'al día',
          filas: [
            { nombre: 'Distribuidora Sur', detalle: '$184.500' },
            { nombre: 'Ferretería Mitre', detalle: '$62.300' },
            { nombre: 'Transporte Norte', detalle: '$97.800' },
          ],
        },
      },
      duracion: 4.5,
    },
    { tipo: 'cartel', texto: 'Y quedan cargadas solas.', bajada: 'Sin tipear nada.', fondo: 'azul', duracion: 2.8 },
    { tipo: 'cierre', texto: '¿Te lo armamos para tu negocio?', duracion: 3 },
  ],
};
