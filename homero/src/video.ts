import { spawn } from 'node:child_process';
import type { MedidaDeVideo } from './publicar-reel.js';

/**
 * Lo que Homero mira de un video con ffmpeg/ffprobe (vienen en la imagen del
 * contenedor, los usa tambien reel.ts): cuanto mide, una hoja de contacto
 * para el publicista y un cuadro para la portada.
 */

/** Los cuadros de la hoja de contacto: un video de 90 s no entra entero en el contexto. */
const CUADROS_EN_LA_HOJA = 30;
const COLUMNAS_DE_LA_HOJA = 6;
const ANCHO_DEL_CUADRO = 270;

/** Corre un programa y devuelve lo que escribio por stdout. Pocos hilos: corre al lado de los agentes. */
function correr(programa: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, mal) => {
    const p = spawn(programa, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const salida: Buffer[] = [];
    let error = '';
    p.stdout.on('data', (d: Buffer) => salida.push(d));
    p.stderr.on('data', (d: Buffer) => (error = (error + d.toString()).slice(-1000)));
    p.on('error', mal);
    p.on('close', (codigo) => (codigo === 0 ? ok(Buffer.concat(salida)) : mal(new Error(`${programa} salió con ${codigo}: ${error.trim()}`))));
  });
}

export async function medirVideo(archivo: string): Promise<MedidaDeVideo> {
  const json = await correr('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json',
    archivo,
  ]);
  const r = JSON.parse(json.toString()) as {
    streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string };
  };
  const s = r.streams?.[0];
  if (!s?.width || !s.height) throw new Error('no tiene video');
  // Los celulares graban apaisado y marcan la rotacion: lo que se ve es lo rotado.
  const rotado = Math.abs(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  return {
    ancho: rotado ? s.height : s.width,
    alto: rotado ? s.width : s.height,
    duracion: Number(r.format?.duration ?? 0),
  };
}

/** Hasta 30 cuadros repartidos en todo el video, en una sola imagen de 6 columnas. */
export async function hojaDeContacto(archivo: string): Promise<Buffer> {
  const { duracion } = await medirVideo(archivo);
  const cuadros = Math.max(1, Math.min(CUADROS_EN_LA_HOJA, Math.floor(duracion)));
  const filas = Math.ceil(cuadros / COLUMNAS_DE_LA_HOJA);
  const fps = cuadros / Math.max(duracion, 1);
  return correr('ffmpeg', [
    '-v', 'error',
    '-i', archivo,
    '-vf', `fps=${fps.toFixed(4)},scale=${ANCHO_DEL_CUADRO}:-2,tile=${COLUMNAS_DE_LA_HOJA}x${filas}`,
    '-frames:v', '1',
    '-threads', '2',
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ]);
}

/** Un cuadro del primer segundo (o de la mitad, si es mas corto), a 1080 de ancho. */
export async function portadaDe(archivo: string): Promise<Buffer> {
  const { duracion } = await medirVideo(archivo);
  return correr('ffmpeg', [
    '-v', 'error',
    '-ss', String(Math.min(1, duracion / 2)),
    '-i', archivo,
    '-vf', 'scale=1080:-2',
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ]);
}
