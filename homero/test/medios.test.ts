import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { armarBancoDeMusica, buscarEnPixabay, elegirTema, leerBanco, sirveComoMusica, BUSQUEDAS_POR_VUELTA, type TemaDelBanco } from '../src/medios.js';

const tema = (id: string, titulo: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: titulo,
  creator: 'alguien',
  license: 'cc0',
  url: `https://cdn.freesound.org/previews/${id}.mp3`,
  foreign_landing_url: `https://freesound.org/s/${id}`,
  source: 'freesound',
  duration: 45_000,
  filetype: 'mp3',
  filesize: 500_000,
  tags: [{ name: 'loop' }],
  ...extra,
});

/** Un Openverse falso: devuelve `resultados` a cada busqueda y bytes a cada bajada. */
function openverse(resultados: unknown[], o: { bloquear?: boolean } = {}) {
  const busquedas: string[] = [];
  const bajadas: string[] = [];
  const pedir = (async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://api.openverse.org')) {
      busquedas.push(new URL(u).searchParams.get('q')!);
      if (o.bloquear) return new Response('<html>Just a moment...</html>', { status: 429, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify({ results: resultados }), { headers: { 'content-type': 'application/json' } });
    }
    bajadas.push(u);
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  return { pedir, busquedas, bajadas };
}

describe('qué sirve como música de un reel', () => {
  it('un loop musical CC0 de duración razonable sí', () => {
    expect(sirveComoMusica(tema('1', 'Upbeat Piano Loop [87bpm]'))).toBe(true);
    // Los tags de Freesound nombran de todo: "noise" en un tag no lo descarta.
    expect(sirveComoMusica(tema('2', 'Upbeat loop', { tags: [{ name: 'noise' }, { name: 'music' }] }))).toBe(true);
  });

  it('efectos, voces, licencias con condiciones o duraciones raras no', () => {
    expect(sirveComoMusica(tema('3', 'hi speed electronic whoosh'))).toBe(false);
    expect(sirveComoMusica(tema('4', 'Party background chatter'))).toBe(false);
    expect(sirveComoMusica(tema('5', 'Upbeat loop', { license: 'by' }))).toBe(false);
    expect(sirveComoMusica(tema('6', 'Upbeat loop', { duration: 3000 }))).toBe(false);
    expect(sirveComoMusica(tema('7', 'Upbeat loop', { duration: 600_000 }))).toBe(false);
    expect(sirveComoMusica(tema('8', 'Garden Background', { tags: [{ name: 'birds' }] }))).toBe(false);
  });
});

describe('el banco de música', () => {
  it('baja los que sirven, anota de dónde salieron y no repite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medios-'));
    const ov = openverse([tema('a1', 'Upbeat Piano Loop'), tema('a2', 'Electronic whoosh'), tema('a3', 'Funk groove loop')]);
    const ahora = () => new Date('2026-10-13T12:00:00Z');
    const nuevos = await armarBancoDeMusica({ dir, pedir: ov.pedir, ahora, pausaMs: 0 });
    expect(nuevos).toBe(2);
    const banco = await leerBanco(dir);
    expect(banco.map((t) => [t.id, t.licencia, t.pagina])).toEqual([
      ['a1', 'cc0', 'https://freesound.org/s/a1'],
      ['a3', 'cc0', 'https://freesound.org/s/a3'],
    ]);
    expect((await readdir(join(dir, 'musica'))).sort()).toEqual(['a1.mp3', 'a3.mp3', 'banco.json']);

    // La vuelta siguiente no baja de nuevo lo que ya está.
    const otra = openverse([tema('a1', 'Upbeat Piano Loop')]);
    expect(await armarBancoDeMusica({ dir, pedir: otra.pedir, ahora, pausaMs: 0 })).toBe(0);
    expect(otra.bajadas).toEqual([]);
  });

  it('pocas búsquedas por vuelta, y si Openverse frena, corta hasta mañana', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medios-'));
    const normal = openverse([]);
    await armarBancoDeMusica({ dir, pedir: normal.pedir, ahora: () => new Date(), pausaMs: 0 });
    expect(normal.busquedas).toHaveLength(BUSQUEDAS_POR_VUELTA);

    const frenado = openverse([], { bloquear: true });
    await armarBancoDeMusica({ dir, pedir: frenado.pedir, ahora: () => new Date(), pausaMs: 0 });
    expect(frenado.busquedas).toHaveLength(1);
  });

  it('elige un tema del estilo que no se haya usado hace poco', () => {
    const banco = [
      { id: 'x', estilo: 'tech' },
      { id: 'y', estilo: 'tech' },
      { id: 'z', estilo: 'epico' },
      { id: 'v', estilo: 'tech', vetado: true },
    ] as TemaDelBanco[];
    expect(elegirTema(banco, 'tech', ['x'])?.id).toBe('y');
    expect(elegirTema(banco, 'tech', ['x', 'y'])?.id).toBe('x');
    expect(elegirTema(banco, 'ritmo', [])).toBeUndefined();
  });
});

describe('Pixabay', () => {
  it('fotos verticales y la versión de video que entra en 1080x1920', async () => {
    const pedidos: string[] = [];
    const pedir = (async (url: string | URL) => {
      const u = String(url);
      pedidos.push(u);
      if (u.includes('/videos/')) {
        return Response.json({
          hits: [
            {
              id: 9,
              pageURL: 'https://pixabay.com/videos/9',
              tags: 'taller, mecanico',
              user: 'ana',
              videos: {
                large: { url: 'https://v/large.mp4', width: 3840, height: 2160 },
                medium: { url: 'https://v/medium.mp4', width: 1920, height: 1080 },
                small: { url: 'https://v/small.mp4', width: 1280, height: 720 },
              },
            },
          ],
        });
      }
      return Response.json({
        hits: [{ id: 5, pageURL: 'https://pixabay.com/photos/5', tags: 'facturas', largeImageURL: 'https://f/5.jpg', imageWidth: 1080, imageHeight: 1920, user: 'beto' }],
      });
    }) as typeof fetch;
    const fotos = await buscarEnPixabay('facturas', 'foto', { clave: 'k', pedir });
    expect(fotos).toEqual([expect.objectContaining({ id: 5, tipo: 'foto', url: 'https://f/5.jpg', alto: 1920 })]);
    expect(pedidos[0]).toContain('orientation=vertical');
    expect(pedidos[0]).toContain('key=k');
    const videos = await buscarEnPixabay('taller', 'video', { clave: 'k', pedir });
    expect(videos[0]).toMatchObject({ tipo: 'video', url: 'https://v/medium.mp4' });
  });
});
