import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aprobarReel,
  cambiarReel,
  descartarReel,
  leerReels,
  problemaDelVideo,
  promocionarReel,
  proponerPublicacion,
  publicarReel,
  recibirVideo,
  reintentarReel,
  retomarReels,
  rinde,
  TOPE_DE_TELEGRAM,
  type DepsDeReels,
  type MedidaDeVideo,
} from '../src/publicar-reel.js';
import { planificarAnuncios, publicarAnuncio } from '../src/anuncios.js';
import { agenteReel, type DepsDeAgentes } from '../src/agentes.js';
import type { Bloque } from '../src/mcp.js';
import { agenteDe, armar, type Guion } from './armar.js';
import { metaFalsa } from './meta-falsa.js';

const VERTICAL: MedidaDeVideo = { ancho: 1080, alto: 1920, duracion: 30 };
const VIDEO = Buffer.from('mp4 de mentira');

let medios: string;
beforeEach(async () => {
  medios = await mkdtemp(join(tmpdir(), 'homero-reels-'));
});
afterEach(async () => {
  await rm(medios, { recursive: true, force: true });
});

function armarReels(o: { medida?: MedidaDeVideo } = {}) {
  const m = metaFalsa();
  const h = armar({ meta: m.meta });
  const videos: { archivo: string; pie: string }[] = [];
  const deps: DepsDeReels = {
    ...h.deps,
    medios,
    medir: async () => o.medida ?? VERTICAL,
    hoja: async () => Buffer.from('png'),
    portada: async () => Buffer.from('png'),
    mandarVideo: async (archivo, pie) => {
      videos.push({ archivo, pie });
    },
    esperar: async () => undefined,
  };
  return { ...h, m, deps, videos };
}

/** Un reel ya escrito por el publicista, esperando el OK de Gero. */
async function propuesto(h: ReturnType<typeof armarReels>) {
  const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
  if (!r.ok) throw new Error(r.motivo);
  await proponerPublicacion(r.id, { caption: 'Las facturas se cargan solas. #pymes #sincro', porQue: 'muestra el producto' }, h.deps);
  return r.id;
}

describe('problemaDelVideo', () => {
  it('vertical 9:16 de 3 a 90 s pasa', () => {
    expect(problemaDelVideo(VERTICAL)).toBeUndefined();
    expect(problemaDelVideo({ ancho: 720, alto: 1280, duracion: 3 })).toBeUndefined();
  });
  it('horizontal, cuadrado, muy corto o muy largo no', () => {
    expect(problemaDelVideo({ ancho: 1920, alto: 1080, duracion: 30 })).toMatch(/9:16/);
    expect(problemaDelVideo({ ancho: 1080, alto: 1080, duracion: 30 })).toMatch(/9:16/);
    expect(problemaDelVideo({ ...VERTICAL, duracion: 2 })).toMatch(/3 a 90/);
    expect(problemaDelVideo({ ...VERTICAL, duracion: 91 })).toMatch(/3 a 90/);
  });
});

describe('recibir un video de Gero', () => {
  it('más de 20 MB: ni lo baja', async () => {
    const h = armarReels();
    let bajado = false;
    const r = await recibirVideo(
      {
        peso: TOPE_DE_TELEGRAM + 1,
        bajar: async () => {
          bajado = true;
          return VIDEO;
        },
      },
      h.deps,
    );
    expect(r).toEqual({ ok: false, motivo: expect.stringMatching(/20 MB/) });
    expect(bajado).toBe(false);
    expect(h.store.reelsGuardados).toEqual([]);
  });

  it('horizontal: lo rechaza y no deja el archivo', async () => {
    const h = armarReels({ medida: { ancho: 1920, alto: 1080, duracion: 30 } });
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    expect(r.ok).toBe(false);
    expect(h.store.reelsGuardados).toEqual([]);
    expect(await readdir(join(medios, 'subidos'))).toEqual([]);
  });

  it('bien: queda guardado, escribiendo, y el publicista arma el texto', async () => {
    const h = armarReels();
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    expect(r.ok).toBe(true);
    const reel = h.store.reelsGuardados[0]!;
    expect(reel).toMatchObject({ origen: 'gero', estado: 'escribiendo', duracion: 30, peso: VIDEO.length, prueba: true });
    expect(existsSync(reel.archivo!)).toBe(true);
    expect(h.store.tareas.map((t) => [t.tipo, t.payload])).toEqual([['agente_reel', { reelId: reel.id }]]);
  });
});

describe('la tarjeta para Gero', () => {
  it('manda el video y la tarjeta con los cuatro botones', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    const reel = (await h.store.reel(id))!;
    expect(reel.estado).toBe('propuesto');
    expect(reel.telegramMsg).toBe(1001);
    expect(h.videos).toHaveLength(1);
    expect(h.tarjetas[0]!.texto).toContain('Las facturas se cargan solas');
    expect(h.tarjetas[0]!.datos).toEqual([`rp:${id}`, `rq:${id}`, `rc:${id}`, `rd:${id}`]);
  });

  it('más de 5 hashtags o un link: el publicista lo tiene que rehacer', async () => {
    const h = armarReels();
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    await expect(proponerPublicacion(r.id, { caption: 'x #a #b #c #d #e #f', porQue: 'porque si' }, h.deps)).rejects.toThrow(/5 hashtags/);
    await expect(proponerPublicacion(r.id, { caption: 'mirá https://x.com', porQue: 'porque si' }, h.deps)).rejects.toThrow(/link/);
    expect((await h.store.reel(r.id))!.estado).toBe('escribiendo');
  });
});

describe('publicar', () => {
  it('nada se sube sin el OK de Gero', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await publicarReel({ reelId: id }, h.deps);
    expect(h.m.llamadas).toEqual([]);
  });

  it('✅ Publicar: reel de prueba en IG (espera FINISHED), después FB, y borra el archivo', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    const archivo = (await h.store.reel(id))!.archivo!;
    h.m.datos.estadosDelContenedor.push({ estado: 'IN_PROGRESS' }, { estado: 'IN_PROGRESS' });
    expect(await aprobarReel(id, { promocionar: false }, h.deps)).toMatchObject({ ok: true });
    expect(h.store.tareas.at(-1)).toMatchObject({ tipo: 'publicar_reel', payload: { reelId: id } });
    await publicarReel({ reelId: id }, h.deps);

    expect(h.m.llamadas.map((l) => l.metodo)).toEqual([
      'subirReelInstagram',
      'estadoDelContenedor',
      'estadoDelContenedor',
      'estadoDelContenedor',
      'publicarEnInstagram',
      'subirReelFacebook',
    ]);
    expect(h.m.de('subirReelInstagram')[0]!.args[1]).toEqual({ caption: 'Las facturas se cargan solas. #pymes #sincro', prueba: true });
    const reel = (await h.store.reel(id))!;
    expect(reel).toMatchObject({ estado: 'publicado', igMedia: 'media2', fbVideo: 'fbv3', prueba: true, promocionar: false });
    expect(reel.archivo).toBeUndefined();
    expect(existsSync(archivo)).toBe(false);
    expect(h.avisos.at(-1)).toMatch(/de prueba/);
  });

  it('📣: queda marcado para promocionar', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: true }, h.deps);
    expect((await h.store.reel(id))!.promocionar).toBe(true);
  });

  it('aprobar dos veces no publica dos veces', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    expect(await aprobarReel(id, { promocionar: false }, h.deps)).toMatchObject({ ok: false });
    expect(h.store.tareas.filter((t) => t.tipo === 'publicar_reel')).toHaveLength(1);
  });

  it('Instagram no deja reels de prueba: no publica nada y ofrece publicarlo normal', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: true }, h.deps);
    h.m.datos.fallar = 'subirReelInstagram';
    h.m.datos.mensaje = 'Meta: Trial reels are not available for this account';
    await publicarReel({ reelId: id }, h.deps);

    expect(h.m.de('subirReelFacebook')).toEqual([]);
    const reel = (await h.store.reel(id))!;
    expect(reel).toMatchObject({ estado: 'propuesto', prueba: false, promocionar: true });
    expect(h.tarjetas.at(-1)!.datos).toEqual([`rn:${id}`, `rd:${id}`]);

    // Publicar normal: sale sin trial_params.
    await aprobarReel(id, { promocionar: true }, h.deps);
    await publicarReel({ reelId: id }, h.deps);
    expect(h.m.de('subirReelInstagram').at(-1)!.args[1]).toEqual({ caption: expect.any(String), prueba: false });
    expect((await h.store.reel(id))!.estado).toBe('publicado');
  });

  it('el contenedor da ERROR: fallido, sin FB, con Reintentar', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    h.m.datos.estadosDelContenedor.push({ estado: 'ERROR', detalle: 'video codec not supported' });
    await publicarReel({ reelId: id }, h.deps);

    expect(h.m.de('subirReelFacebook')).toEqual([]);
    const reel = (await h.store.reel(id))!;
    expect(reel.estado).toBe('fallido');
    expect(reel.motivo).toMatch(/codec/);
    expect(reel.archivo).toBeDefined();
    expect(h.tarjetas.at(-1)!.datos).toEqual([`rr:${id}`, `rd:${id}`]);

    expect(await reintentarReel(id, h.deps)).toMatchObject({ ok: true });
    await publicarReel({ reelId: id }, h.deps);
    expect((await h.store.reel(id))!.estado).toBe('publicado');
  });

  it('Instagram tarda más de 5 minutos: fallido', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    for (let i = 0; i < 100; i++) h.m.datos.estadosDelContenedor.push({ estado: 'IN_PROGRESS' });
    await publicarReel({ reelId: id }, h.deps);
    expect((await h.store.reel(id))!).toMatchObject({ estado: 'fallido', motivo: expect.stringMatching(/5 minutos/) });
  });

  it('FB falla: el reel queda publicado en IG con el motivo', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    h.m.datos.fallar = 'subirReelFacebook';
    await publicarReel({ reelId: id }, h.deps);
    const reel = (await h.store.reel(id))!;
    expect(reel).toMatchObject({ estado: 'publicado', igMedia: expect.any(String) });
    expect(reel.fbVideo).toBeUndefined();
    expect(reel.motivo).toMatch(/Facebook/);
    expect(h.avisos.at(-1)).toMatch(/Facebook no pude/);
  });

  it('se cortó a mitad (ya había contenedor): sigue desde ahí sin subir de nuevo', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    await h.store.actualizarReel(id, { igContenedor: 'cont9' });
    expect(await retomarReels(h.deps)).toBe(1);
    await publicarReel({ reelId: id }, h.deps);
    expect(h.m.de('subirReelInstagram')).toEqual([]);
    expect(h.m.de('publicarEnInstagram')[0]!.args).toEqual(['cont9']);
  });
});

describe('cambiar y descartar', () => {
  it('✏️ Cambiar: vuelve al publicista con el pedido', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    expect(await cambiarReel(id, 'más corto y sin emojis', h.deps)).toMatchObject({ ok: true });
    expect((await h.store.reel(id))!.estado).toBe('escribiendo');
    expect(h.store.tareas.at(-1)).toMatchObject({ tipo: 'agente_reel', payload: { reelId: id, pedido: 'más corto y sin emojis' } });
  });

  it('🗑 Descartar: borra el video', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    const archivo = (await h.store.reel(id))!.archivo!;
    await descartarReel(id, h.deps);
    expect((await h.store.reel(id))!.estado).toBe('descartado');
    expect(existsSync(archivo)).toBe(false);
  });

  it('un publicado no se descarta', async () => {
    const h = armarReels();
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: false }, h.deps);
    await publicarReel({ reelId: id }, h.deps);
    expect(await descartarReel(id, h.deps)).toMatchObject({ ok: false });
  });
});

describe('rinde', () => {
  const base = { estado: 'publicado' as const, publicadoEn: new Date('2026-10-01T12:00:00Z') };
  const con = (alcance: number, guardados = 0, compartidos = 0) => ({
    ...base,
    metricas: { alcance, vistas: alcance * 2, guardados, compartidos, likes: 0, comentarios: 0, promedioMs: 0, leido: '' },
  });
  const despues = new Date('2026-10-04T13:00:00Z');

  it('antes de las 72 h no se decide', () => {
    expect(rinde(con(5000, 100), [], new Date('2026-10-04T11:00:00Z')).rinde).toBe(false);
  });
  it('sin historia: 500 de alcance y 1% de guardados más compartidos', () => {
    expect(rinde(con(500, 3, 2), [], despues).rinde).toBe(true);
    expect(rinde(con(499, 3, 2), [], despues).rinde).toBe(false);
    expect(rinde(con(600, 3, 3), [], despues).rinde).toBe(true);
    expect(rinde(con(600, 2, 3), [], despues).rinde).toBe(false);
  });
  it('con 3 o más anteriores: el doble de la mediana', () => {
    const anteriores = [con(300), con(400), con(1000)];
    expect(rinde(con(799, 20), anteriores, despues).rinde).toBe(false);
    expect(rinde(con(800, 20), anteriores, despues).rinde).toBe(true);
  });
});

describe('números y promoción', () => {
  /** Un reel publicado, con lo que va a leer de Meta. */
  async function publicado(h: ReturnType<typeof armarReels>, o: { promocionar?: boolean } = {}) {
    const id = await propuesto(h);
    await aprobarReel(id, { promocionar: o.promocionar ?? false }, h.deps);
    await publicarReel({ reelId: id }, h.deps);
    return (await h.store.reel(id))!;
  }
  const BUENO = { alcance: 900, vistas: 2000, guardados: 12, compartidos: 4, likes: 50, comentarios: 3, promedioMs: 7000 };
  const tresDiasDespues = (h: ReturnType<typeof armarReels>) => h.mover(new Date(h.ahora().getTime() + 73 * 3_600_000));

  it('guarda los números de los publicados de la última semana', async () => {
    const h = armarReels();
    const r = await publicado(h);
    h.m.datos.metricas.set(r.igMedia!, BUENO);
    await leerReels(h.deps);
    expect((await h.store.reel(r.id))!.metricas).toMatchObject({ alcance: 900, guardados: 12 });

    h.mover(new Date(h.ahora().getTime() + 8 * 86_400_000));
    const antes = h.m.de('metricasDeReel').length;
    await leerReels(h.deps);
    expect(h.m.de('metricasDeReel')).toHaveLength(antes);
  });

  it('la portada del reel se guarda al publicar (el video se borra)', async () => {
    const h = armarReels();
    const r = await publicado(h);
    expect(existsSync(join(medios, 'portadas', `reel-${r.id}.png`))).toBe(true);
  });

  it('sin 📣: si rinde, propone promocionarlo una sola vez', async () => {
    const h = armarReels();
    const r = await publicado(h);
    h.m.datos.metricas.set(r.igMedia!, BUENO);
    tresDiasDespues(h);
    await leerReels(h.deps);
    await leerReels(h.deps);
    const propuestas = h.tarjetas.filter((t) => t.datos.includes(`rs:${r.id}`));
    expect(propuestas).toHaveLength(1);
    expect(propuestas[0]!.datos).toEqual([`rs:${r.id}`, `rx:${r.id}`]);
    expect(propuestas[0]!.texto).toMatch(/alcance 900/);
    expect(h.store.anunciosGuardados).toEqual([]);
  });

  it('no rinde: no propone nada', async () => {
    const h = armarReels();
    const r = await publicado(h);
    h.m.datos.metricas.set(r.igMedia!, { ...BUENO, alcance: 100 });
    tresDiasDespues(h);
    await leerReels(h.deps);
    expect(h.tarjetas.filter((t) => t.datos.includes(`rs:${r.id}`))).toEqual([]);
  });

  it('con 📣: cuando rinde crea el anuncio con el reel, sin volver a preguntar', async () => {
    const h = armarReels();
    const r = await publicado(h, { promocionar: true });
    h.m.datos.metricas.set(r.igMedia!, BUENO);
    tresDiasDespues(h);
    await leerReels(h.deps);

    const a = h.store.anunciosGuardados[0]!;
    expect(a).toMatchObject({ reelId: r.id, estado: 'aprobado', rubro: 'reel' });
    expect(a.imagen).toEqual(Buffer.from('png'));
    expect((await h.store.reel(r.id))!.anuncioId).toBe(a.id);
    expect(h.store.tareas.at(-1)).toMatchObject({ tipo: 'publicar_anuncio', payload: { anuncioId: a.id } });
    expect(h.tarjetas.filter((t) => t.datos.includes(`rs:${r.id}`))).toEqual([]);

    // La siguiente lectura no crea otro.
    await leerReels(h.deps);
    expect(h.store.anunciosGuardados).toHaveLength(1);
  });

  it('Meta no deja promocionarlo: avisa el motivo y no crea nada', async () => {
    const h = armarReels();
    const r = await publicado(h);
    h.m.datos.noPromocionables.set(r.igMedia!, 'Contains copyrighted music');
    expect(await promocionarReel(r.id, h.deps)).toMatchObject({ ok: false, motivo: expect.stringMatching(/copyrighted/) });
    expect(h.store.anunciosGuardados).toEqual([]);
  });

  it('no entra en el presupuesto del mes: no crea nada', async () => {
    const h = armarReels();
    const r = await publicado(h);
    await h.store.guardarEstado('presupuesto_mes', 500);
    expect(await promocionarReel(r.id, h.deps)).toMatchObject({ ok: false, motivo: expect.stringMatching(/presupuesto/) });
    expect(h.store.anunciosGuardados).toEqual([]);
  });

  it('el anuncio de un reel usa el reel publicado como creativo, sin subir imagen', async () => {
    const h = armarReels();
    const r = await publicado(h);
    const p = await promocionarReel(r.id, h.deps);
    if (!p.ok) throw new Error(p.motivo);
    await publicarAnuncio({ anuncioId: p.anuncioId }, h.deps);
    expect(h.m.de('subirImagen')).toEqual([]);
    expect(h.m.de('crearCreativo')).toEqual([]);
    expect(h.m.de('crearCreativoDeReel')[0]!.args[0]).toMatchObject({ media: r.igMedia, formulario: expect.any(String) });
    expect((await h.store.anuncio(p.anuncioId))!.estado).toBe('activo');
  });

  it('a los 5 días el anuncio del reel se pausa', async () => {
    const h = armarReels();
    const r = await publicado(h);
    const p = await promocionarReel(r.id, h.deps);
    if (!p.ok) throw new Error(p.motivo);
    await publicarAnuncio({ anuncioId: p.anuncioId }, h.deps);
    h.mover(new Date(h.ahora().getTime() + 4 * 86_400_000));
    await leerReels(h.deps);
    expect((await h.store.anuncio(p.anuncioId))!.estado).toBe('activo');
    h.mover(new Date(h.ahora().getTime() + 1.1 * 86_400_000));
    await leerReels(h.deps);
    expect((await h.store.anuncio(p.anuncioId))!.estado).toBe('pausado');
  });
});

describe('el publicista escribe el texto del reel', () => {
  function conAgente(guion: Guion['reel']) {
    const m = metaFalsa();
    const h = armar({ meta: m.meta, agente: agenteDe({ reel: guion }) });
    const deps: DepsDeReels & DepsDeAgentes = { ...h.deps, medios, esperar: async () => undefined };
    return { ...h, m, deps };
  }

  it('ve la hoja de cuadros y deja el texto: le llega a Gero', async () => {
    let vio: Bloque[] = [];
    const h = conAgente(async (usar) => {
      vio = (await usar('ver_reel')).bloques;
      const r = await usar('proponer_publicacion_de_reel', { caption: 'Las facturas se cargan solas. #pymes', por_que: 'muestra el dolor del estudio' });
      expect(r.error).toBe(false);
    });
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    await agenteReel({ reelId: r.id }, h.deps);
    expect(vio[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from('hoja').toString('base64') });
    expect((await h.store.reel(r.id))!).toMatchObject({ estado: 'propuesto', caption: 'Las facturas se cargan solas. #pymes' });
    expect(h.tarjetas.at(-1)!.datos).toContain(`rp:${r.id}`);
  });

  it('un texto que no se puede publicar vuelve al agente como error y puede corregirlo', async () => {
    const h = conAgente(async (usar) => {
      const mal = await usar('proponer_publicacion_de_reel', { caption: 'mirá www.sincro.com', por_que: 'porque sí, es bueno' });
      expect(mal.error).toBe(true);
      expect(mal.texto).toMatch(/link/);
      await usar('proponer_publicacion_de_reel', { caption: 'Sin links ahora.', por_que: 'porque sí, es bueno' });
    });
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    await agenteReel({ reelId: r.id }, h.deps);
    expect((await h.store.reel(r.id))!.caption).toBe('Sin links ahora.');
  });

  it('✏️ Cambiar: el objetivo lleva lo que pidió Gero y el texto que tenía', async () => {
    const h = conAgente(async (usar) => {
      await usar('proponer_publicacion_de_reel', { caption: 'Más corto.', por_que: 'lo pidió Gero' });
    });
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    await proponerPublicacion(r.id, { caption: 'Un texto larguísimo de antes', porQue: 'primera versión' }, h.deps);
    await cambiarReel(r.id, 'más corto', h.deps);
    await agenteReel({ reelId: r.id, pedido: 'más corto' }, h.deps);
    const objetivo = h.corridas.at(-1)!.objetivo;
    expect(objetivo).toContain('más corto');
    expect(objetivo).toContain('Un texto larguísimo de antes');
    expect((await h.store.reel(r.id))!.caption).toBe('Más corto.');
  });

  it('un reel que ya no espera texto no corre al agente', async () => {
    const h = conAgente(async () => {
      throw new Error('no tenía que correr');
    });
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    await descartarReel(r.id, h.deps);
    await agenteReel({ reelId: r.id }, h.deps);
    expect(h.corridas).toEqual([]);
  });
});

describe('el planificador', () => {
  it('encola leer los números de los reels una vez cada 6 horas', async () => {
    const h = armarReels();
    await planificarAnuncios(h.deps);
    await planificarAnuncios(h.deps);
    expect(h.store.tareas.filter((t) => t.tipo === 'leer_reels')).toHaveLength(1);
    h.mover(new Date(h.ahora().getTime() + 6 * 3_600_000));
    await planificarAnuncios(h.deps);
    expect(h.store.tareas.filter((t) => t.tipo === 'leer_reels')).toHaveLength(2);
  });
});

describe('cortes a mitad', () => {
  it('Homero se reinició antes de mandar la tarjeta: al arrancar la manda, sin volver a escribir', async () => {
    const h = armarReels();
    const r = await recibirVideo({ peso: VIDEO.length, bajar: async () => VIDEO }, h.deps);
    if (!r.ok) throw new Error(r.motivo);
    // Lo que quedó en la base: texto escrito, propuesto, pero sin tarjeta.
    await h.store.actualizarReel(r.id, { caption: 'Texto ya escrito', porQue: 'escrito antes del corte', estado: 'propuesto' });

    await retomarReels(h.deps);

    expect(h.videos).toHaveLength(1);
    expect(h.tarjetas.at(-1)!.texto).toContain('Texto ya escrito');
    expect(h.tarjetas.at(-1)!.datos).toEqual([`rp:${r.id}`, `rq:${r.id}`, `rc:${r.id}`, `rd:${r.id}`]);
    expect((await h.store.reel(r.id))!.telegramMsg).toBe(1001);

    // Y no la repite si ya tiene.
    await retomarReels(h.deps);
    expect(h.tarjetas).toHaveLength(1);
  });
});
