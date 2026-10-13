import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Los medios de los reels (spec 2026-10-08-homero-reels), sin pagar nada:
 *
 * - MUSICA: un banco propio en el servidor, armado solo desde Openverse
 *   (el buscador de contenido libre de WordPress) con licencia CC0: uso
 *   comercial y sin dar credito. Openverse junta Freesound, Jamendo y
 *   Wikimedia; viene mezclado con efectos y ruidos, asi que se filtra por
 *   duracion y por palabras de musica. Pixabay no tiene API de musica y sus
 *   condiciones no dejan bajarla en masa: por eso no sale de ahi.
 * - FOTOS Y VIDEOS: la API oficial de Pixabay (gratis, uso comercial, sin
 *   credito). No se arma un banco: cada reel busca lo de su tema y lo baja.
 */

export const OPENVERSE = 'https://api.openverse.org/v1/audio/';
export const PIXABAY = 'https://pixabay.com/api/';
/** Openverse frena (Cloudflare) los pedidos anonimos sin identificarse. */
const QUIEN_SOY = 'Homero/1.0 (reels de Sincro; https://sincro.apps.punchi.dev)';

/** Los estilos que pide un guion, y como se buscan. */
export const ESTILOS = {
  energico: ['upbeat music loop', 'energetic beat', 'rock loop', 'pop instrumental'],
  tech: ['electronic music loop', 'synth loop', 'house beat', 'techno loop'],
  tranquilo: ['lofi loop', 'chill music', 'ambient piano', 'acoustic guitar loop'],
  epico: ['cinematic music', 'epic orchestral', 'trailer music', 'inspiring music'],
  ritmo: ['hip hop beat', 'funk loop', 'drum loop bpm', 'groove loop'],
} as const;
export type Estilo = keyof typeof ESTILOS;

/** Cuantos temas por estilo se juntan. Con 12 x 5 hay variedad para meses. */
export const TEMAS_POR_ESTILO = 12;
/**
 * Busquedas por vuelta. Openverse sin cuenta deja pocas por dia y frena con un
 * 429: el banco se arma de a poco (una vuelta por dia) y no de golpe.
 */
export const BUSQUEDAS_POR_VUELTA = 5;
const DURACION_MINIMA_MS = 12_000;
const DURACION_MAXIMA_MS = 240_000;
const PESO_MAXIMO = 15 * 1024 * 1024;

const ES_MUSICA = /(loop|music|beat|bpm|melod|piano|guitar|song|track|synth|chord|groove|instrumental|cinematic|orchestr|lofi|lo-fi|funk|hip ?hop|electro|house|techno|rock|pop|jazz|trailer|inspir)/i;
const NO_ES_MUSICA = /(whoosh|swoosh|snare|kick only|siren|ambien(ce|t noise)|chatter|voice|vocal only|speech|talk|pronunc|scream|crowd|sfx|sound ?effect|impact|footstep|door|bird|rain|wind|noise|glitch|alarm|beep|notification|ringtone|countdown|applause|laugh)/i;

export interface TemaDelBanco {
  /** El id de Openverse: no se baja dos veces. */
  id: string;
  titulo: string;
  autor: string;
  licencia: string;
  /** Donde esta publicado (Freesound, Jamendo...), por si hay que mostrarlo o sacarlo. */
  pagina: string;
  fuente: string;
  estilo: Estilo;
  duracionMs: number;
  archivo: string;
  bajado: string;
  /** Instagram lo marco por derechos: no se usa mas. */
  vetado?: boolean;
}

const ResultadoDeOpenverse = z.object({
  id: z.string(),
  title: z.string().nullish(),
  creator: z.string().nullish(),
  license: z.string(),
  url: z.string().url(),
  foreign_landing_url: z.string().nullish(),
  source: z.string().nullish(),
  duration: z.number().nullish(),
  filetype: z.string().nullish(),
  filesize: z.number().nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
});
type ResultadoDeOpenverse = z.infer<typeof ResultadoDeOpenverse>;

/** Si un resultado de Openverse sirve como musica de fondo para un reel. */
export function sirveComoMusica(r: ResultadoDeOpenverse): boolean {
  if (r.license !== 'cc0' && r.license !== 'pdm') return false;
  if (!r.duration || r.duration < DURACION_MINIMA_MS || r.duration > DURACION_MAXIMA_MS) return false;
  if (r.filesize && r.filesize > PESO_MAXIMO) return false;
  if (!['mp3', 'ogg', 'wav', 'flac', 'm4a'].includes((r.filetype ?? '').toLowerCase())) return false;
  // Lo que NO es musica se mira solo en el titulo: los tags de Freesound
  // nombran de todo ("noise", "effect") aunque sea un loop musical.
  const titulo = r.title ?? '';
  const texto = `${titulo} ${(r.tags ?? []).map((t) => t.name).join(' ')}`;
  return ES_MUSICA.test(texto) && !NO_ES_MUSICA.test(titulo);
}

type Pedir = typeof fetch;

export interface DepsDeMedios {
  /** Donde viven los medios (volumen del contenedor). */
  dir: string;
  pedir?: Pedir;
  ahora: () => Date;
  /** Espera entre bajadas, para no castigar a Openverse. En los tests, 0. */
  pausaMs?: number;
}

const BANCO = 'banco.json';

export async function leerBanco(dir: string): Promise<TemaDelBanco[]> {
  try {
    return JSON.parse(await readFile(join(dir, 'musica', BANCO), 'utf8')) as TemaDelBanco[];
  } catch {
    return [];
  }
}

async function guardarBanco(dir: string, banco: TemaDelBanco[]): Promise<void> {
  const ruta = join(dir, 'musica', BANCO);
  // Escribir y renombrar: un corte a mitad no deja un banco.json roto.
  await writeFile(`${ruta}.tmp`, JSON.stringify(banco, null, 2));
  await rename(`${ruta}.tmp`, ruta);
}

async function buscarEnOpenverse(q: string, pedir: Pedir): Promise<ResultadoDeOpenverse[]> {
  const url = `${OPENVERSE}?${new URLSearchParams({ q, license: 'cc0,pdm', page_size: '50' })}`;
  const r = await pedir(url, { headers: { accept: 'application/json', 'user-agent': QUIEN_SOY }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Openverse contestó ${r.status}`);
  if (!(r.headers.get('content-type') ?? '').includes('json')) throw new Error('Openverse pidió verificación (Cloudflare): se reintenta mañana');
  const json = (await r.json()) as { results?: unknown[] };
  return (json.results ?? []).flatMap((x) => {
    const p = ResultadoDeOpenverse.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

/**
 * Completa el banco hasta {@link TEMAS_POR_ESTILO} temas por estilo. Lo que ya
 * esta no se vuelve a bajar. Devuelve cuantos temas nuevos entraron.
 */
export async function armarBancoDeMusica(deps: DepsDeMedios): Promise<number> {
  const pedir = deps.pedir ?? fetch;
  const carpeta = join(deps.dir, 'musica');
  await mkdir(carpeta, { recursive: true });
  const banco = await leerBanco(deps.dir);
  const vistos = new Set(banco.map((t) => t.id));
  let nuevos = 0;
  let busquedas = 0;
  // Primero los estilos con menos temas: si la vuelta se corta, avanzan parejo.
  const estilos = (Object.keys(ESTILOS) as Estilo[]).sort(
    (a, b) => banco.filter((t) => t.estilo === a).length - banco.filter((t) => t.estilo === b).length,
  );
  for (const estilo of estilos) {
    let tiene = banco.filter((t) => t.estilo === estilo && !t.vetado).length;
    for (const q of ESTILOS[estilo]) {
      if (tiene >= TEMAS_POR_ESTILO) break;
      if (busquedas >= BUSQUEDAS_POR_VUELTA) return nuevos;
      busquedas++;
      let resultados: ResultadoDeOpenverse[];
      try {
        if (deps.pausaMs !== 0) await new Promise((ok) => setTimeout(ok, deps.pausaMs ?? 3000));
        resultados = await buscarEnOpenverse(q, pedir);
      } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err);
        console.warn(`[homero] musica: no pude buscar "${q}":`, motivo);
        // Frenado por Openverse: se sigue en la vuelta de mañana.
        if (/429|Cloudflare/.test(motivo)) return nuevos;
        continue;
      }
      for (const r of resultados) {
        if (tiene >= TEMAS_POR_ESTILO) break;
        if (vistos.has(r.id) || !sirveComoMusica(r)) continue;
        vistos.add(r.id);
        try {
          const res = await pedir(r.url, { headers: { 'user-agent': QUIEN_SOY }, signal: AbortSignal.timeout(60_000) });
          if (!res.ok) continue;
          const datos = Buffer.from(await res.arrayBuffer());
          if (datos.length === 0 || datos.length > PESO_MAXIMO) continue;
          const archivo = `${r.id}.${(r.filetype ?? 'mp3').toLowerCase()}`;
          await writeFile(join(carpeta, archivo), datos);
          banco.push({
            id: r.id,
            titulo: (r.title ?? 'sin título').slice(0, 120),
            autor: (r.creator ?? '').slice(0, 80),
            licencia: r.license,
            pagina: r.foreign_landing_url ?? r.url,
            fuente: r.source ?? 'openverse',
            estilo,
            duracionMs: r.duration!,
            archivo,
            bajado: deps.ahora().toISOString(),
          });
          tiene++;
          nuevos++;
          // Se guarda cada tema: si se corta a mitad, lo bajado no se pierde.
          await guardarBanco(deps.dir, banco);
          if (deps.pausaMs !== 0) await new Promise((ok) => setTimeout(ok, deps.pausaMs ?? 1500));
        } catch (err) {
          console.warn(`[homero] musica: no pude bajar ${r.id}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }
  return nuevos;
}

/** Un tema del estilo pedido que no se haya usado en los ultimos usos. */
export function elegirTema(banco: TemaDelBanco[], estilo: Estilo, recientes: string[]): TemaDelBanco | undefined {
  const delEstilo = banco.filter((t) => t.estilo === estilo && !t.vetado);
  return delEstilo.find((t) => !recientes.includes(t.id)) ?? delEstilo[0];
}

// ------------------------------------------------------------ Pixabay

export interface MedioDePixabay {
  id: number;
  tipo: 'foto' | 'video';
  url: string;
  ancho: number;
  alto: number;
  autor: string;
  pagina: string;
  etiquetas: string;
}

const FotoDePixabay = z.object({
  id: z.number(),
  pageURL: z.string(),
  tags: z.string(),
  largeImageURL: z.string(),
  imageWidth: z.number(),
  imageHeight: z.number(),
  user: z.string(),
});

const VideoDePixabay = z.object({
  id: z.number(),
  pageURL: z.string(),
  tags: z.string(),
  user: z.string(),
  videos: z.record(z.object({ url: z.string(), width: z.number(), height: z.number() })),
});

/**
 * Fotos (o videos cortos) de Pixabay para un tema, en vertical si hay. Las
 * condiciones de Pixabay piden bajarlas al servidor propio antes de usarlas
 * (no enlazarlas): el render las baja.
 */
export async function buscarEnPixabay(
  q: string,
  tipo: 'foto' | 'video',
  cfg: { clave: string; pedir?: Pedir; cantidad?: number },
): Promise<MedioDePixabay[]> {
  const pedir = cfg.pedir ?? fetch;
  const params = new URLSearchParams({
    key: cfg.clave,
    q: q.slice(0, 100),
    safesearch: 'true',
    per_page: String(Math.min(Math.max(cfg.cantidad ?? 20, 3), 200)),
    ...(tipo === 'foto' ? { image_type: 'photo', orientation: 'vertical' } : {}),
  });
  const r = await pedir(`${PIXABAY}${tipo === 'video' ? 'videos/' : ''}?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Pixabay contestó ${r.status}`);
  const hits = ((await r.json()) as { hits?: unknown[] }).hits ?? [];
  return hits.flatMap((h): MedioDePixabay[] => {
    if (tipo === 'foto') {
      const f = FotoDePixabay.safeParse(h);
      return f.success
        ? [{ id: f.data.id, tipo, url: f.data.largeImageURL, ancho: f.data.imageWidth, alto: f.data.imageHeight, autor: f.data.user, pagina: f.data.pageURL, etiquetas: f.data.tags }]
        : [];
    }
    const v = VideoDePixabay.safeParse(h);
    if (!v.success) return [];
    // La version mas grande que no pase de 1920 de alto: alcanza para 1080x1920.
    const version = Object.values(v.data.videos)
      .filter((x) => x.url && x.height <= 1920)
      .sort((a, b) => b.height - a.height)[0];
    return version
      ? [{ id: v.data.id, tipo, url: version.url, ancho: version.width, alto: version.height, autor: v.data.user, pagina: v.data.pageURL, etiquetas: v.data.tags }]
      : [];
  });
}
