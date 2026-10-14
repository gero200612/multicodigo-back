import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { diarioQueEntraPara, minimoDiario, pausarAnuncio, pesos, type DepsDeAnuncios } from './anuncios.js';
import type { Reel, Store } from './store.js';
import type { Boton } from './ventas.js';

/**
 * Publicar en Instagram y Facebook un reel que manda Gero por Telegram
 * (spec 2026-10-13-homero-subir-reels).
 *
 * Lo que se puede hacer sin preguntar lo decide este archivo, no el agente:
 * - nada se sube a Meta sin el OK de Gero (`aprobarReel`);
 * - sale como reel de prueba; si Instagram no lo deja, NO se publica normal
 *   por su cuenta: se le pregunta a Gero;
 * - si Meta falla no se reintenta solo: Gero tiene el boton Reintentar.
 */

/** Lo mas grande que un bot puede bajar de Telegram (getFile). */
export const TOPE_DE_TELEGRAM = 20 * 1024 * 1024;
/** Lo que acepta Reels por la API. */
const DURACION_MINIMA = 3;
const DURACION_MAXIMA = 90;
/** 9:16, con un poco de margen por los videos que vienen de 1080x1918. */
const PROPORCION = 9 / 16;
const TOLERANCIA = 0.02;
/** Instagram procesa el video: se mira cada 5 s, hasta 5 minutos. */
const ESPERA_DEL_CONTENEDOR_MS = 5_000;
const VUELTAS_DEL_CONTENEDOR = 60;
export const MAXIMO_DE_HASHTAGS = 5;
export const LARGO_MAXIMO_DEL_CAPTION = 2_200;

export interface MedidaDeVideo {
  ancho: number;
  alto: number;
  /** En segundos. */
  duracion: number;
}

export interface DepsDeReels extends DepsDeAnuncios {
  /** El volumen de medios: los videos que manda Gero van a `<medios>/subidos`. */
  medios: string;
  /** ffprobe. */
  medir: (archivo: string) => Promise<MedidaDeVideo>;
  /** La hoja de contacto (un cuadro por segundo) que mira el publicista. */
  hoja: (archivo: string) => Promise<Buffer>;
  /** Un cuadro del video, para la imagen del anuncio cuando se promociona. */
  portada: (archivo: string) => Promise<Buffer>;
  /** Manda el video por Telegram, antes de su tarjeta. */
  mandarVideo?: (archivo: string, pie: string) => Promise<void>;
  /** En los tests no se espera de verdad. */
  esperar?: (ms: number) => Promise<void>;
}

/** Un texto que no se puede publicar: el publicista lo tiene que rehacer. */
export class ErrorDeTexto extends Error {}

export type ResultadoDeReel = { ok: true; reel: Reel } | { ok: false; motivo: string };

/** Por que este video no puede ser un reel, o nada si puede. */
export function problemaDelVideo(m: MedidaDeVideo): string | undefined {
  if (m.duracion < DURACION_MINIMA || m.duracion > DURACION_MAXIMA) {
    return `dura ${m.duracion.toFixed(1)} s y Reels acepta de ${DURACION_MINIMA} a ${DURACION_MAXIMA} s`;
  }
  if (!m.alto || Math.abs(m.ancho / m.alto - PROPORCION) > PROPORCION * TOLERANCIA) {
    return `mide ${m.ancho}×${m.alto} y un reel tiene que ser vertical 9:16 (por ejemplo 1080×1920)`;
  }
  return undefined;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1).replace('.', ',');

/**
 * Gero mando un video. Se controla antes de bajarlo (el tope de Telegram) y
 * despues de medirlo; si sirve, queda `escribiendo` y el publicista arma el texto.
 */
export async function recibirVideo(
  v: { peso: number; bajar: () => Promise<Buffer> },
  deps: DepsDeReels,
): Promise<{ ok: true; id: number } | { ok: false; motivo: string }> {
  if (v.peso > TOPE_DE_TELEGRAM) {
    return { ok: false, motivo: `pesa ${mb(v.peso)} MB y el tope de Telegram para bots es 20 MB` };
  }
  const carpeta = join(deps.medios, 'subidos');
  await mkdir(carpeta, { recursive: true });
  const archivo = join(carpeta, `${deps.ahora().getTime()}.mp4`);
  const video = await v.bajar();
  await writeFile(archivo, video);
  let medida: MedidaDeVideo;
  try {
    medida = await deps.medir(archivo);
  } catch (err) {
    await rm(archivo, { force: true });
    return { ok: false, motivo: `no pude leer el video: ${err instanceof Error ? err.message : String(err)}` };
  }
  const problema = problemaDelVideo(medida);
  if (problema) {
    await rm(archivo, { force: true });
    return { ok: false, motivo: problema };
  }
  const id = await deps.store.crearReel({ origen: 'gero', archivo, duracion: medida.duracion, peso: video.length });
  await deps.store.encolar({ tipo: 'agente_reel', payload: { reelId: id }, requiereIa: true, clave: `reel:escribir:${id}:0` });
  return { ok: true, id };
}

export const PayloadDeReel = z.object({ reelId: z.number().int(), pedido: z.string().optional() });

export const botonesDeReel = (id: number): Boton[] => [
  { texto: '✅ Publicar', datos: `rp:${id}` },
  { texto: '📣 Publicar y promocionar', datos: `rq:${id}` },
  { texto: '✏️ Cambiar', datos: `rc:${id}` },
  { texto: '🗑 Descartar', datos: `rd:${id}` },
];

export function tarjetaDeReel(r: Pick<Reel, 'id' | 'duracion' | 'caption' | 'porQue'>): string {
  return [
    `🎬 Reel para publicar (#${r.id}, ${Math.round(r.duracion)} s)`,
    '',
    r.caption,
    '',
    `Por qué: ${r.porQue}`,
    '',
    '✅ Publicar: reel de prueba en Instagram (lo ven los que no te siguen; si rinde, Instagram lo pasa a tus seguidores) y reel en la página de Facebook.',
    '📣 Además, cuando rinda lo promociono con formulario, dentro del presupuesto del mes.',
    'Con ✏️ Cambiar me escribís qué cambiar del texto.',
  ].join('\n');
}

/** Lo que escribio el publicista: se controla y le llega a Gero con el video. */
export async function proponerPublicacion(id: number, p: { caption: string; porQue: string }, deps: DepsDeReels): Promise<void> {
  const caption = p.caption.trim();
  if (!caption) throw new ErrorDeTexto('el texto está vacío');
  if (caption.length > LARGO_MAXIMO_DEL_CAPTION) {
    throw new ErrorDeTexto(`el texto tiene ${caption.length} caracteres y el máximo es ${LARGO_MAXIMO_DEL_CAPTION}`);
  }
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > MAXIMO_DE_HASHTAGS) {
    throw new ErrorDeTexto(`tiene ${hashtags.length} hashtags: como máximo ${MAXIMO_DE_HASHTAGS} hashtags`);
  }
  if (/https?:\/\/|www\./i.test(caption)) throw new ErrorDeTexto('sin links: en Instagram no se pueden tocar');
  const r = await deps.store.reel(id);
  if (r?.estado !== 'escribiendo') throw new ErrorDeTexto(`el reel #${id} ya no espera texto`);
  await deps.store.actualizarReel(id, { caption, porQue: p.porQue.trim(), estado: 'propuesto' });
  await presentarReel((await deps.store.reel(id))!, deps);
}

/**
 * El video y la tarjeta a Gero. Va aparte porque un corte entre que el reel
 * queda `propuesto` y que sale la tarjeta (un deploy mientras sube el video)
 * lo dejaba trabado: `retomarReels` la vuelve a mandar.
 */
async function presentarReel(r: Reel, deps: DepsDeReels): Promise<void> {
  if (r.archivo) {
    await deps.mandarVideo?.(r.archivo, `#${r.id}`).catch((e) => console.error('[homero] no pude mandar el video:', e));
  }
  const msg = await deps.proponer(tarjetaDeReel(r), botonesDeReel(r.id));
  if (msg) await deps.store.actualizarReel(r.id, { telegramMsg: msg });
}

async function encolarPublicacion(id: number, deps: DepsDeReels): Promise<void> {
  await deps.store.encolar({
    tipo: 'publicar_reel',
    payload: { reelId: id },
    requiereIa: false,
    clave: `reel:publicar:${id}:${deps.ahora().getTime()}`,
  });
}

/** ✅ o 📣 (o Publicar normal): recien aca se sube algo a Meta, por la cola. */
export async function aprobarReel(id: number, o: { promocionar: boolean }, deps: DepsDeReels): Promise<ResultadoDeReel> {
  if (!deps.meta) return { ok: false, motivo: 'Meta no está configurado (falta META_TOKEN)' };
  const r = await deps.store.reel(id);
  if (!r) return { ok: false, motivo: 'ese reel no existe' };
  if (r.estado !== 'propuesto') return { ok: false, motivo: `ya estaba decidido (${r.estado})` };
  await deps.store.actualizarReel(id, { estado: 'subiendo', promocionar: o.promocionar, aprobadoEn: deps.ahora(), motivo: null });
  await encolarPublicacion(id, deps);
  return { ok: true, reel: (await deps.store.reel(id))! };
}

/** Reintentar uno que fallo: sigue desde lo que ya se habia hecho en Meta. */
export async function reintentarReel(id: number, deps: DepsDeReels): Promise<ResultadoDeReel> {
  const r = await deps.store.reel(id);
  if (!r) return { ok: false, motivo: 'ese reel no existe' };
  if (r.estado !== 'fallido') return { ok: false, motivo: `no estaba fallido (${r.estado})` };
  if (!r.archivo) return { ok: false, motivo: 'ya no tengo el video: mandámelo de nuevo' };
  await deps.store.actualizarReel(id, { estado: 'subiendo', motivo: null });
  await encolarPublicacion(id, deps);
  return { ok: true, reel: (await deps.store.reel(id))! };
}

/** ✏️ Cambiar: vuelve al publicista con lo que pidio Gero. */
export async function cambiarReel(id: number, pedido: string, deps: DepsDeReels): Promise<ResultadoDeReel> {
  const r = await deps.store.reel(id);
  if (!r) return { ok: false, motivo: 'ese reel no existe' };
  if (r.estado !== 'propuesto') return { ok: false, motivo: `ya estaba decidido (${r.estado})` };
  await deps.store.actualizarReel(id, { estado: 'escribiendo' });
  await deps.store.encolar({
    tipo: 'agente_reel',
    payload: { reelId: id, pedido },
    requiereIa: true,
    clave: `reel:escribir:${id}:${deps.ahora().getTime()}`,
  });
  return { ok: true, reel: (await deps.store.reel(id))! };
}

/** 🗑: el video se borra. Uno ya publicado no se toca desde aca. */
export async function descartarReel(id: number, deps: DepsDeReels): Promise<ResultadoDeReel> {
  const r = await deps.store.reel(id);
  if (!r) return { ok: false, motivo: 'ese reel no existe' };
  if (r.estado === 'publicado' || r.estado === 'subiendo') {
    return { ok: false, motivo: r.estado === 'publicado' ? 'ya está publicado: se borra desde Instagram' : 'se está subiendo' };
  }
  if (r.archivo) await rm(r.archivo, { force: true });
  await deps.store.actualizarReel(id, { estado: 'descartado', archivo: null });
  return { ok: true, reel: (await deps.store.reel(id))! };
}

/**
 * Al arrancar: los que quedaron subiendo siguen desde lo que ya se hizo en
 * Meta, y a los propuestos cuya tarjeta no llego a salir se les manda.
 */
export async function retomarReels(deps: DepsDeReels): Promise<number> {
  let n = 0;
  for (const r of await deps.store.reels(['subiendo'])) {
    await encolarPublicacion(r.id, deps);
    n++;
  }
  for (const r of await deps.store.reels(['propuesto'])) {
    if (r.telegramMsg !== undefined) continue;
    await presentarReel(r, deps);
    n++;
  }
  return n;
}

/** Meta no deja reels de prueba en esta cuenta (todavia): lo dice en el error. */
const esRechazoDePrueba = (mensaje: string) => /trial/i.test(mensaje);

/**
 * Sube y publica un reel aprobado: IG primero (contenedor resumable, esperar
 * FINISHED, publicar) y despues FB. Cada id se anota apenas existe, asi un
 * corte a mitad sigue desde ahi. No tira: lo que falla queda en el reel y le
 * llega a Gero (la cola no lo reintenta sola).
 */
export async function publicarReel(payload: unknown, deps: DepsDeReels): Promise<void> {
  const { reelId: id } = PayloadDeReel.parse(payload);
  if (!deps.meta) throw new Error('Meta no está configurado (falta META_TOKEN)');
  const meta = deps.meta;
  const r = await deps.store.reel(id);
  if (!r || r.estado !== 'subiendo') return;
  if (!r.archivo) {
    await fallo(r, 'ya no tengo el video: mandámelo de nuevo', deps);
    return;
  }
  const video = await readFile(r.archivo);
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));

  let media = r.igMedia;
  try {
    let contenedor = r.igContenedor;
    if (!media) {
      if (!contenedor) {
        contenedor = await meta.subirReelInstagram(video, { caption: r.caption, prueba: r.prueba });
        await deps.store.actualizarReel(id, { igContenedor: contenedor });
      }
      let listo = false;
      for (let i = 0; i < VUELTAS_DEL_CONTENEDOR && !listo; i++) {
        const e = await meta.estadoDelContenedor(contenedor);
        if (e.estado === 'FINISHED') listo = true;
        else if (e.estado === 'ERROR' || e.estado === 'EXPIRED') throw new Error(`Instagram no pudo procesar el video: ${e.detalle ?? e.estado}`);
        else await esperar(ESPERA_DEL_CONTENEDOR_MS);
      }
      if (!listo) throw new Error('Instagram tardó más de 5 minutos en procesar el video');
      media = await meta.publicarEnInstagram(contenedor);
      await deps.store.actualizarReel(id, { igMedia: media });
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    // El contenedor que fallo no sirve mas: el proximo intento crea otro.
    await deps.store.actualizarReel(id, { igContenedor: null });
    if (r.prueba && esRechazoDePrueba(mensaje)) {
      await deps.store.actualizarReel(id, { estado: 'propuesto', prueba: false, motivo: mensaje });
      const msg = await deps.proponer(
        [
          `⚠️ Instagram no deja reels de prueba en esta cuenta todavía (reel #${id}). No publiqué nada.`,
          '',
          `Meta dijo: ${mensaje.slice(0, 300)}`,
          '',
          '¿Lo publico como reel normal? Lo ven también tus seguidores desde el primer momento.',
        ].join('\n'),
        [
          { texto: '✅ Publicar normal', datos: `rn:${id}` },
          { texto: '🗑 Descartar', datos: `rd:${id}` },
        ],
      );
      if (msg) await deps.store.actualizarReel(id, { telegramMsg: msg });
      return;
    }
    await fallo(r, mensaje, deps);
    return;
  }

  // Facebook solo despues de Instagram. Si falla, el reel ya esta publicado.
  let fbVideo = r.fbVideo;
  let motivoFb: string | undefined;
  if (!fbVideo) {
    try {
      fbVideo = await meta.subirReelFacebook(video, r.caption);
    } catch (err) {
      motivoFb = `Facebook: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // El video se borra; la portada queda para el anuncio si despues se promociona.
  try {
    await mkdir(join(deps.medios, 'portadas'), { recursive: true });
    await writeFile(rutaDePortada(id, deps), await deps.portada(r.archivo));
  } catch (err) {
    console.warn(`[homero] no pude sacar la portada del reel #${id}:`, err instanceof Error ? err.message : err);
  }
  await rm(r.archivo, { force: true });
  await deps.store.actualizarReel(id, {
    estado: 'publicado',
    publicadoEn: deps.ahora(),
    archivo: null,
    ...(fbVideo ? { fbVideo } : {}),
    ...(motivoFb ? { motivo: motivoFb } : {}),
  });
  await deps.avisar(
    [
      `🚀 Publiqué el reel #${id} en Instagram${
        r.prueba ? ' como reel de prueba: lo ven los que no te siguen y, si rinde, Instagram lo pasa a tus seguidores' : ''
      }.`,
      fbVideo ? 'También está en la página de Facebook.' : `En Facebook no pude: ${motivoFb?.slice(0, 300)}`,
      r.promocionar ? '📣 Cuando rinda, lo promociono con formulario.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

const rutaDePortada = (id: number, deps: Pick<DepsDeReels, 'medios'>) => join(deps.medios, 'portadas', `reel-${id}.png`);

// ------------------------------------------------------------ numeros y promocion

/** Los numeros se leen la primera semana. */
const VENTANA_DE_NUMEROS_MS = 7 * 86_400_000;
/** Antes de esto es muy pronto para decir si rinde. */
const DECIDIR_DESDE_MS = 72 * 3_600_000;
/** Sin historia para comparar, lo minimo de alcance para decir que rinde. */
const ALCANCE_SIN_HISTORIA = 500;
/** Con historia, cuantas veces la mediana de los anteriores. */
const VECES_LA_MEDIANA = 2;
/** Guardados + compartidos sobre alcance: que no solo se haya visto. */
const INTERES_MINIMO = 0.01;
/** Lo que dura la promocion de un reel; despues se pausa sola. */
export const DIAS_DE_PROMOCION = 5;

function mediana(xs: number[]): number {
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
}

/**
 * Si un reel rinde: desde las 72 h, alcance de al menos el doble de la
 * mediana de los anteriores (500 si hay menos de 3) y guardados + compartidos
 * de al menos el 1 % del alcance.
 */
export function rinde(
  r: Pick<Reel, 'publicadoEn' | 'metricas'>,
  anteriores: Pick<Reel, 'metricas'>[],
  ahora: Date,
): { rinde: boolean; umbral: number } {
  const alcances = anteriores.flatMap((a) => (a.metricas ? [a.metricas.alcance] : []));
  const umbral = alcances.length >= 3 ? VECES_LA_MEDIANA * mediana(alcances) : ALCANCE_SIN_HISTORIA;
  const m = r.metricas;
  if (!m || !r.publicadoEn || ahora.getTime() - r.publicadoEn.getTime() < DECIDIR_DESDE_MS) return { rinde: false, umbral };
  const interes = m.guardados + m.compartidos >= INTERES_MINIMO * m.alcance;
  return { rinde: m.alcance >= umbral && interes, umbral };
}

const lineaDeNumeros = (m: NonNullable<Reel['metricas']>) =>
  `alcance ${m.alcance}, reproducciones ${m.vistas}, guardados ${m.guardados}, compartidos ${m.compartidos}`;

/**
 * Cada 6 horas: los numeros de los reels de la ultima semana. El que rinde se
 * promociona solo si Gero toco 📣; si no, se le propone una vez. Y el anuncio
 * de un reel se pausa a los {@link DIAS_DE_PROMOCION} dias.
 */
export async function leerReels(deps: DepsDeReels): Promise<void> {
  if (!deps.meta) return;
  const ahora = deps.ahora();
  const publicados = await deps.store.reels(['publicado']);
  for (const r of publicados) {
    if (!r.igMedia || !r.publicadoEn || ahora.getTime() - r.publicadoEn.getTime() > VENTANA_DE_NUMEROS_MS) continue;
    try {
      const m = await deps.meta.metricasDeReel(r.igMedia);
      const metricas = { ...m, leido: ahora.toISOString() };
      await deps.store.actualizarReel(r.id, { metricas });
      if (r.anuncioId !== undefined || r.propuestaPromoEn) continue;
      const anteriores = publicados.filter((x) => x.id !== r.id && x.publicadoEn && x.publicadoEn < r.publicadoEn!);
      const v = rinde({ ...r, metricas }, anteriores, ahora);
      if (!v.rinde) continue;
      if (r.promocionar) {
        const p = await promocionarReel(r.id, deps);
        if (!p.ok) {
          await deps.store.actualizarReel(r.id, { promocionar: false, propuestaPromoEn: ahora });
          await deps.avisar(`📣 El reel #${r.id} rinde pero no lo pude promocionar: ${p.motivo}`);
        }
        continue;
      }
      await deps.store.actualizarReel(r.id, { propuestaPromoEn: ahora });
      const diario = await minimoDiario(deps);
      const msg = await deps.proponer(
        [
          `📈 El reel #${r.id} rinde: ${lineaDeNumeros(metricas)} (el piso era ${Math.round(v.umbral)} de alcance).`,
          '',
          `¿Lo promociono con formulario? ${pesos(diario)} por día durante ${DIAS_DE_PROMOCION} días, dentro del presupuesto del mes.`,
        ].join('\n'),
        [
          { texto: '📣 Promocionar', datos: `rs:${r.id}` },
          { texto: 'No', datos: `rx:${r.id}` },
        ],
      );
      if (msg) await deps.store.actualizarReel(r.id, { telegramMsg: msg });
    } catch (err) {
      console.warn(`[homero] no pude leer los números del reel #${r.id}:`, err instanceof Error ? err.message : err);
    }
  }
  // La promocion de un reel dura unos dias: despues se pausa.
  for (const r of publicados) {
    if (r.anuncioId === undefined) continue;
    const a = await deps.store.anuncio(r.anuncioId);
    if (a?.estado !== 'activo' || !a.aprobadoEn) continue;
    if (ahora.getTime() - a.aprobadoEn.getTime() >= DIAS_DE_PROMOCION * 86_400_000) {
      await pausarAnuncio(a.id, `terminaron los ${DIAS_DE_PROMOCION} días de promoción del reel #${r.id}`, deps);
      await deps.avisar(`⏹ Terminó la promoción del reel #${r.id} (${DIAS_DE_PROMOCION} días): pausé el anuncio #${a.id}.`);
    }
  }
}

/**
 * El reel de `/promocionar [n]`: el que nombra, o el ultimo publicado que
 * todavia no se promociona (Gero, 2026-10-14: "que promocione el reel subido").
 */
export async function reelParaPromocionar(
  store: Pick<Store, 'reels'>,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; motivo: string }> {
  if (id !== undefined) return { ok: true, id };
  const libres = (await store.reels(['publicado']))
    .filter((r) => r.anuncioId === undefined && r.publicadoEn)
    .sort((a, b) => b.publicadoEn!.getTime() - a.publicadoEn!.getTime());
  if (!libres[0]) return { ok: false, motivo: 'no hay ningún reel publicado sin promocionar' };
  return { ok: true, id: libres[0].id };
}

/**
 * Crea el anuncio con formulario de un reel publicado: ya aprobado (el OK fue
 * el 📣 o el boton de la propuesta), con el minimo diario y dentro del mes.
 * La creacion en Meta va por la cola, como cualquier anuncio.
 */
export async function promocionarReel(
  id: number,
  deps: DepsDeReels,
): Promise<{ ok: true; anuncioId: number } | { ok: false; motivo: string }> {
  if (!deps.meta) return { ok: false, motivo: 'Meta no está configurado (falta META_TOKEN)' };
  const r = await deps.store.reel(id);
  if (!r?.igMedia || r.estado !== 'publicado') return { ok: false, motivo: 'ese reel no está publicado' };
  if (r.anuncioId !== undefined) {
    // Aprobado pero nunca llego a Meta (la tarea fallo): se vuelve a publicar
    // el mismo anuncio, que reusa lo que ya se creo alla.
    const a = await deps.store.anuncio(r.anuncioId);
    if (a?.estado !== 'aprobado') return { ok: false, motivo: `ya se promociona (anuncio #${r.anuncioId})` };
    await deps.store.encolar({
      tipo: 'publicar_anuncio',
      payload: { anuncioId: a.id },
      requiereIa: false,
      clave: `publicar:${a.id}:${deps.ahora().getTime()}`,
    });
    return { ok: true, anuncioId: a.id };
  }
  const elegible = await deps.meta.promocionable(r.igMedia);
  if (!elegible.ok) return { ok: false, motivo: `Meta no deja promocionarlo: ${elegible.motivo}` };
  const diario = await minimoDiario(deps);
  const entra = await diarioQueEntraPara(-1, deps);
  if (entra < diario) {
    return { ok: false, motivo: `no entra en el presupuesto del mes (quedan ${pesos(entra)} y Meta pide ${pesos(diario)} por día)` };
  }
  const titulo = tituloDelCaption(r.caption);
  const imagen = await readFile(rutaDePortada(id, deps)).catch(() => Buffer.alloc(0));
  const anuncioId = await deps.store.crearAnuncio({
    rubro: 'reel',
    titulo,
    texto: r.caption,
    frase: titulo,
    preguntas: [],
    porQue: r.metricas ? `El reel #${id} rinde: ${lineaDeNumeros(r.metricas)}.` : `Gero pidió promocionar el reel #${id}.`,
    diario,
    imagen,
    reelId: id,
  });
  await deps.store.actualizarAnuncio(anuncioId, { estado: 'aprobado', aprobadoEn: deps.ahora() });
  await deps.store.actualizarReel(id, { anuncioId, promocionar: true });
  await deps.store.encolar({ tipo: 'publicar_anuncio', payload: { anuncioId }, requiereIa: false, clave: `publicar:${anuncioId}` });
  return { ok: true, anuncioId };
}

/** El primer renglon del caption sin hashtags, para nombrar el anuncio. */
function tituloDelCaption(caption: string): string {
  const linea = (caption.split('\n').find((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').trim()) ?? 'Reel de Sincro')
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .trim();
  return linea.length > 40 ? `${linea.slice(0, 39).trimEnd()}…` : linea;
}

async function fallo(r: Reel, mensaje: string, deps: DepsDeReels): Promise<void> {
  await deps.store.actualizarReel(r.id, { estado: 'fallido', motivo: mensaje });
  const msg = await deps.proponer(`❌ No pude publicar el reel #${r.id}: ${mensaje.slice(0, 500)}`, [
    { texto: '🔁 Reintentar', datos: `rr:${r.id}` },
    { texto: '🗑 Descartar', datos: `rd:${r.id}` },
  ]);
  if (msg) await deps.store.actualizarReel(r.id, { telegramMsg: msg });
}
