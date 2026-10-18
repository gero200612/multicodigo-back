import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { GuionInvalido, renderizar, type ReelDeEstudio } from './estudio.js';
import { ErrorParaElAgente, type Bloque, type Herramienta } from './mcp.js';
import { elegirTema, ESTILOS as ESTILOS_DE_MUSICA, leerBanco, urlDelTema, type Estilo as EstiloDeMusica, type TemaDelBanco } from './medios.js';
import { catalogo } from './ofrecemos.js';
import { armarReel, GUION_DE_PRUEBA } from './reel.js';
import type { DepsDeReels } from './publicar-reel.js';

/**
 * Los reels de Homero hechos con el Estudio de Sincro Agents
 * (sincro-agents/estudio, Remotion), en lugar del armado con ffmpeg.
 *
 * El agente escribe lo que cambia de un reel a otro (los bloques, el estilo, la
 * musica por estilo) y Homero pone lo que NO puede cambiar: la marca de Sincro
 * (colores, tipografia, logo real) y la musica del banco CC0, sin voz. Asi un
 * agente que se equivoca de color o inventa una URL de musica no llega al
 * estudio. El estudio valida todo igual y contesta en castellano.
 *
 * Camino de un reel: `agente_reel_estudio` (el agente deja el guion) ->
 * `renderizar_reel` (el estudio lo arma, sin IA) -> el reel queda `escribiendo`
 * y sigue el flujo de siempre (el publicista escribe el texto, Gero aprueba).
 */

/** La marca de Sincro: el azul del logo, fondo azul noche (sincro-videos/src/kit.tsx), Inter. */
export const MARCA_SINCRO = {
  nombre: 'Sincro',
  colores: { fondo: '#050A18', primario: '#0166FE', acento: '#4DA3FF', texto: '#F2F6FF' },
  tipografias: { titulos: 'Inter', cuerpo: 'Inter' },
  // El logo real, el mismo de la web de Sincro.
  logoUrl: 'https://sincro.apps.punchi.dev/logo.png',
} as const;

/**
 * Los bloques que sirven para vender Sincro. Los otros muestran algo real que
 * Homero no tiene (fotos de un lugar, la captura de una app, un cliente que
 * habla) o piden una cifra: inventarlos es lo que Gero no quiere en un anuncio.
 */
export const BLOQUES_PERMITIDOS = ['pregunta_gancho', 'entrada_con_dato', 'pasos', 'beneficios', 'comparacion', 'cierre_cta'] as const;

/** Un reel de 4 a 7 bloques: con menos no hay historia, con mas pasa del minuto. */
const MIN_BLOQUES = 3;
const MAX_BLOQUES = 7;

export const PedidoDeReel = z
  .object({
    bloques: z
      .array(
        z
          .object({
            tipo: z.enum(BLOQUES_PERMITIDOS),
            datos: z.record(z.string(), z.unknown()),
            duracion_s: z.number().positive().max(15).optional(),
          })
          // Sin `locucion`: los reels van sin voz (la voz de Azure no esta contratada).
          .strict(),
      )
      .min(MIN_BLOQUES)
      .max(MAX_BLOQUES),
    // Los valores los valida el estudio (sus estilos cambian sin tocar a Homero).
    estilo: z.string().min(1).max(30).optional(),
    tratamiento: z.string().min(1).max(30).optional(),
    transiciones: z.string().min(1).max(30).optional(),
    musica: z.enum(Object.keys(ESTILOS_DE_MUSICA) as [EstiloDeMusica, ...EstiloDeMusica[]]),
    por_que: z.string().trim().min(5).max(400).optional(),
  })
  .strict();
export type PedidoDeReel = z.infer<typeof PedidoDeReel>;

/** Para mirar cuadros (sin musica): lo que el agente mande de mas se ignora. */
const PedidoParaMirar = PedidoDeReel.omit({ musica: true, por_que: true }).strip();

/** El tema del banco que se usa, en lo que necesita el guion. */
export interface MusicaDeReel {
  url: string;
  licencia: string;
  desde_s: number;
  /** El id del banco: para no repetirlo en los reels de seguido. */
  id: string;
  titulo: string;
}

/** Un tema largo (no hace falta repetirlo) del estilo, sin los ultimos usados. */
export function temaParaReel(banco: TemaDelBanco[], estilo: EstiloDeMusica, recientes: string[]): TemaDelBanco | undefined {
  const largos = banco.filter((t) => t.duracionMs >= 40_000);
  return elegirTema(largos, estilo, recientes) ?? elegirTema(banco, estilo, recientes);
}

/** Desde un poco adelante, como el armado viejo: los primeros segundos de un loop suelen ser la entrada floja. */
export function desdeDelTema(duracionMs: number): number {
  const s = duracionMs / 1000;
  return Math.max(0, Math.min(Math.round(s * 0.15), s - 40));
}

/** El guion completo para el estudio. Sin musica (`undefined`) el reel sale mudo, solo para mirar cuadros. */
export function armarGuion(p: Pick<PedidoDeReel, 'bloques' | 'estilo' | 'tratamiento' | 'transiciones'>, musica?: MusicaDeReel): Record<string, unknown> {
  return {
    formato: 'reel',
    marca: MARCA_SINCRO,
    bloques: p.bloques,
    ...(p.estilo ? { estilo: p.estilo } : {}),
    ...(p.tratamiento ? { tratamiento: p.tratamiento } : {}),
    ...(p.transiciones ? { transiciones: p.transiciones } : {}),
    ...(musica
      ? { audio: 'musica', musica: { url: musica.url, origen: 'banco', licencia: musica.licencia, desde_s: musica.desde_s } }
      : { audio: 'ninguno' }),
  };
}

/** Elige el tema, le busca la direccion y arma el guion. Tira si el banco no tiene nada. */
export async function guionConMusica(
  p: PedidoDeReel,
  deps: Pick<DepsDeReels, 'medios' | 'pedirMusica'>,
  recientes: string[],
): Promise<{ guion: Record<string, unknown>; musica: MusicaDeReel }> {
  const tema = temaParaReel(await leerBanco(deps.medios), p.musica, recientes);
  if (!tema) throw new Error(`el banco de música no tiene temas de estilo ${p.musica}: se completa de a poco, una vuelta por día`);
  const url = await urlDelTema(tema, deps.pedirMusica);
  if (!url) throw new Error(`no pude conseguir la dirección del tema ${tema.id} (Openverse no contestó)`);
  const musica = { url, licencia: tema.licencia.toUpperCase(), desde_s: desdeDelTema(tema.duracionMs), id: tema.id, titulo: tema.titulo };
  return { guion: armarGuion(p, musica), musica };
}

// ------------------------------------------------------------ las herramientas del agente

/** Estilo y gancho del reel en una linea: lo que ve el agente del siguiente reel para no repetirlos. */
export function resumenDelPedido(p: PedidoDeReel): string {
  const d = p.bloques[0]?.datos ?? {};
  const gancho = [d.pregunta, d.frase, d.dato, d.titulo].find((x): x is string => typeof x === 'string') ?? p.bloques[0]?.tipo ?? '';
  return `estilo ${p.estilo ?? 'por defecto'}, música ${p.musica}, gancho "${gancho.slice(0, 80)}"`;
}

const objeto = (props: Record<string, unknown>, requeridos: string[] = []) => ({ type: 'object', properties: props, required: requeridos, additionalProperties: false });
const texto = (description: string) => ({ type: 'string', description });

const esquemaDelPedido = {
  bloques: {
    type: 'array',
    description: `De ${MIN_BLOQUES} a ${MAX_BLOQUES} bloques. Primero un gancho (pregunta_gancho o entrada_con_dato), al final cierre_cta. Cada uno: { tipo, datos, duracion_s? } con el esquema de ver_bloques`,
    items: { type: 'object' },
  },
  estilo: texto('Estilo visual (reglas.estilos de ver_bloques). Un reel distinto del resto del experimento'),
  tratamiento: texto('base, claro o suave'),
  transiciones: texto('barrido, golpe o fundido'),
  musica: { type: 'string', enum: Object.keys(ESTILOS_DE_MUSICA), description: 'El estilo de la música del banco. Los cortes caen en el golpe del tema' },
};

/** Lo que cada herramienta le dice al agente cuando el estudio rechaza el guion. */
function textoDeErrores(errores: { ruta: string; mensaje: string }[]): string {
  return errores
    .slice(0, 12)
    .map((e) => `- ${e.ruta}: ${e.mensaje}`)
    .join('\n');
}

export interface ContextoDeReelDeEstudio {
  /** Cual de los reels del experimento es (1 a N). */
  n: number;
  registro: { cerro: boolean; resumen?: string };
  /** Los temas ya usados, para no repetir. */
  recientes: string[];
  /** Lo que hace `crear_reel` con el guion ya validado: encolar el render. */
  encolar: (g: { guion: Record<string, unknown>; musica: MusicaDeReel; porQue?: string; resumen: string }) => Promise<void>;
}

export function herramientasDelReelDeEstudio(deps: DepsDeReels, ctx: ContextoDeReelDeEstudio): Herramienta<any>[] {
  const estudio = deps.estudio;
  if (!estudio) throw new Error('el estudio no está configurado (falta ESTUDIO_URL)');

  const bloques: Herramienta<Record<string, never>> = {
    nombre: 'ver_bloques',
    descripcion:
      'Los bloques del estudio con su esquema y un ejemplo, las reglas de combinación (duraciones, qué bloque va al final) y los estilos visuales. ' +
      `Usá solo: ${BLOQUES_PERMITIDOS.join(', ')}. Llamala primero.`,
    esquema: objeto({}),
    validar: z.object({}).strict() as z.ZodType<Record<string, never>>,
    async correr() {
      const j = (await estudio.bloques()) as { bloques?: { tipo: string }[]; reglas?: Record<string, unknown> };
      const { sonido: _sonido, ...reglas } = (j.reglas ?? {}) as Record<string, unknown>;
      return JSON.stringify({ bloques: (j.bloques ?? []).filter((b) => (BLOQUES_PERMITIDOS as readonly string[]).includes(b.tipo)), reglas });
    },
  };

  const cuadro: Herramienta<{ segundo: number } & Record<string, unknown>> = {
    nombre: 'ver_cuadro',
    descripcion:
      'El cuadro del reel en un segundo (PNG), con la marca de Sincro puesta. Mirá al menos el gancho (segundo 1), un cuadro del medio y el cierre antes de crear el reel: ' +
      'si algo se corta, se amontona o no se lee, corregilo. Mismo pedido que crear_reel, más el segundo.',
    esquema: objeto({ ...esquemaDelPedido, segundo: { type: 'number', description: 'Segundo del reel (0 es el primer cuadro)' } }, ['bloques', 'segundo']),
    validar: z.object({ segundo: z.number().min(0).max(90) }).passthrough() as z.ZodType<{ segundo: number } & Record<string, unknown>>,
    async correr(a) {
      const { segundo, ...resto } = a;
      const p = PedidoParaMirar.safeParse(resto);
      if (!p.success) throw new ErrorParaElAgente(`El pedido no es válido: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      try {
        const png = await estudio.cuadro(armarGuion(p.data), segundo);
        return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Cuadro del segundo ${segundo}.` }] satisfies Bloque[];
      } catch (err) {
        if (err instanceof GuionInvalido) throw new ErrorParaElAgente(`El estudio no acepta el guion:\n${textoDeErrores(err.errores)}`);
        throw err;
      }
    },
  };

  const crear: Herramienta<PedidoDeReel> = {
    nombre: 'crear_reel',
    descripcion:
      'Deja el reel armado: el estudio lo valida y, si pasa, se renderiza (un par de minutos) con la música del banco y le llega a Gero para aprobar. ' +
      'Si el guion tiene errores te los devuelve para corregirlos. Una sola vez por corrida, al final.',
    esquema: objeto({ ...esquemaDelPedido, por_que: texto('En una o dos oraciones: el ángulo del reel y por qué debería frenar el scroll. Lo lee Gero') }, ['bloques', 'musica']),
    validar: PedidoDeReel,
    async correr(p) {
      if (ctx.registro.cerro) throw new ErrorParaElAgente('Ya dejaste el reel. Terminá la corrida.');
      let armado;
      try {
        armado = await guionConMusica(p, deps, ctx.recientes);
      } catch (err) {
        throw new ErrorParaElAgente(err instanceof Error ? err.message : String(err));
      }
      const errores = await estudio.validar(armado.guion);
      if (errores.length) throw new ErrorParaElAgente(`El estudio no acepta el guion, corregilo y volvé a llamar:\n${textoDeErrores(errores)}`);
      await ctx.encolar({ guion: armado.guion, musica: armado.musica, resumen: resumenDelPedido(p), ...(p.por_que ? { porQue: p.por_que } : {}) });
      ctx.registro.cerro = true;
      ctx.registro.resumen = `Escribió el reel ${ctx.n} del experimento (${p.estilo ?? 'estilo por defecto'}, música ${p.musica}): se está renderizando`;
      return 'Listo: el estudio lo está armando. Terminá la corrida.';
    },
  };

  return [bloques, cuadro, crear];
}

export const ROL_REEL_ESTUDIO = `Tu rol: sos el GUIONISTA de reels de Homero. Escribís el guion de un reel vertical de 15 a 30 segundos para la cuenta de Sincro en Instagram, que el estudio de Sincro Agents renderiza con Remotion. Sin voz: el reel se sostiene con texto en pantalla y música con los cortes en el golpe.
- Empezá con ver_bloques. Armá el reel con los bloques permitidos y mirá cuadros con ver_cuadro (el gancho, uno del medio y el cierre) ANTES de crear_reel; si algo se corta o no se lee, corregilo. Terminá con crear_reel, una sola vez.
- Gancho en el primer segundo: un dolor concreto o una pregunta de dueño de pyme ("¿Cuántas horas por semana se te van cargando facturas?"), no "¿Sabías que...?". Después qué resuelve Sincro, en pasos o beneficios cortos, y cierre_cta con "Escribinos" y contacto "@sincro_ar".
- Textos cortos de reel: títulos de hasta 8 palabras, ítems de 2 a 5. Español rioplatense, de vos.
- NUNCA inventes cifras de resultado ("-30%", "3 horas menos", "el doble"), ni clientes, ni testimonios. Una cifra solo como pregunta o con un dato que sea real y verificable. Solo prometé lo que está en la lista de abajo.
- Cada reel del experimento es DISTINTO: otro dolor, otro gancho y otro estilo visual que los anteriores (te los paso en el objetivo). Gero los compara por costo por consulta.
- No uses locucion (no hay voz). No pongas fotos ni capturas: no las tenés.
- Si el estudio rechaza el guion, el mensaje dice la ruta del campo: corregí ESE campo.

${catalogo()}`;

// ------------------------------------------------------------ renderizar

/** Lo que el render devuelve: el MP4 ya guardado en el volumen y lo que dijo la revision tecnica. */
export interface ReelRenderizado {
  archivo: string;
  duracion: number;
  peso: number;
  revision?: ReelDeEstudio['revision'];
}

/**
 * Renderiza un guion en el estudio y deja el MP4 en `<medios>/estudio`. La
 * clave es la del trabajo: un reintento de la cola retoma el mismo render.
 */
export async function renderizarEnElEstudio(
  guion: unknown,
  clave: string,
  deps: Pick<DepsDeReels, 'estudio' | 'medios' | 'medir' | 'ahora' | 'esperar'>,
): Promise<ReelRenderizado> {
  if (!deps.estudio) throw new Error('el estudio no está configurado (falta ESTUDIO_URL)');
  const r = await renderizar(deps.estudio, guion, { clave, ...(deps.esperar ? { esperar: deps.esperar } : {}) });
  const carpeta = join(deps.medios, 'estudio');
  await mkdir(carpeta, { recursive: true });
  const archivo = join(carpeta, `${clave.replace(/[^\w.-]+/g, '_')}-${deps.ahora().getTime()}.mp4`);
  await writeFile(archivo, r.video);
  const medida = await deps.medir(archivo);
  return { archivo, duracion: medida.duracion || r.duracion || 0, peso: r.video.length, ...(r.revision ? { revision: r.revision } : {}) };
}

/** Las fallas de la revision tecnica del estudio, en una linea por falla. */
export function textoDeFallas(f: { regla: string; detalle: string }[]): string {
  return f.map((x) => `- ${x.regla}: ${x.detalle}`).join('\n');
}

// ------------------------------------------------------------ el reel de muestra (/reel_prueba)

/** Un reel de muestra en el esquema del estudio: facturas que se cargan solas. */
export const PEDIDO_DE_PRUEBA: PedidoDeReel = {
  bloques: [
    { tipo: 'pregunta_gancho', datos: { pregunta: '¿Cuántas horas por semana se van cargando facturas a mano?' }, duracion_s: 3 },
    {
      tipo: 'pasos',
      datos: {
        titulo: 'Así lo resolvemos',
        pasos: [
          { titulo: 'Te llegan por WhatsApp', detalle: 'Foto o PDF' },
          { titulo: 'Se cargan solas', detalle: 'Sin tipear nada' },
          { titulo: 'Quedan ordenadas', detalle: 'Listas para tu contador' },
        ],
      },
    },
    { tipo: 'cierre_cta', datos: { titulo: '¿Te lo armamos para tu negocio?', boton: 'Escribinos', contacto: '@sincro_ar' } },
  ],
  musica: 'tech',
};

export interface DepsDeReelDePrueba extends Pick<DepsDeReels, 'estudio' | 'medios' | 'medir' | 'ahora' | 'esperar' | 'pedirMusica'> {
  /** Si el estudio no contesta (o no esta configurado), se arma con ffmpeg como antes y se dice. */
  ffmpegDeRespaldo: boolean;
  pixabay?: string;
}

export interface ReelDePrueba {
  archivo: string;
  duracion: number;
  /** Lo que se le dice a Gero junto al video. */
  pie: string;
}

/** /reel_prueba: con el estudio; si no esta, el armado viejo (ffmpeg) solo si el flag lo deja, y avisando. */
export async function reelDePrueba(deps: DepsDeReelDePrueba): Promise<ReelDePrueba> {
  const inicio = deps.ahora().getTime();
  const segundos = () => Math.round((deps.ahora().getTime() - inicio) / 1000);
  if (deps.estudio && (await deps.estudio.salud())) {
    let musica: MusicaDeReel | undefined;
    let guion: Record<string, unknown>;
    let sinMusica: string | undefined;
    try {
      ({ guion, musica } = await guionConMusica(PEDIDO_DE_PRUEBA, deps, []));
    } catch (err) {
      sinMusica = err instanceof Error ? err.message : String(err);
      guion = armarGuion(PEDIDO_DE_PRUEBA);
    }
    const r = await renderizarEnElEstudio(guion, `prueba-${inicio}`, deps);
    const revision = r.revision && !r.revision.ok ? `⚠️ La revisión técnica del estudio marcó:\n${textoDeFallas(r.revision.fallas)}` : undefined;
    return {
      archivo: r.archivo,
      duracion: r.duracion,
      pie: [
        `Reel de muestra del estudio · ${r.duracion.toFixed(1)} s · armado en ${segundos()} s`,
        musica ? `🎵 ${musica.titulo} (${musica.licencia})` : `🔇 Sin música: ${sinMusica}`,
        revision,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  const motivo = deps.estudio ? 'el estudio no contesta' : 'el estudio no está configurado (falta ESTUDIO_URL)';
  if (!deps.ffmpegDeRespaldo) throw new Error(`${motivo} y el armado con ffmpeg está apagado (HOMERO_FFMPEG_DE_RESPALDO=0)`);
  const r = await armarReel(GUION_DE_PRUEBA, `prueba-${inicio}`, { dir: deps.medios, ...(deps.pixabay ? { pixabay: deps.pixabay } : {}) });
  const musicaVieja = r.tema ? `🎵 ${r.tema.titulo}${r.tema.autor ? ` · ${r.tema.autor}` : ''} (CC0)` : '🔇 Sin música todavía: el banco se completa de a poco.';
  return {
    archivo: r.archivo,
    duracion: r.duracion,
    pie: [`⚠️ ${motivo}: este lo armé con ffmpeg, el armado de antes (no es el que usa el experimento).`, `Reel de muestra · ${r.duracion.toFixed(1)} s · armado en ${segundos()} s`, musicaVieja].join('\n'),
  };
}
