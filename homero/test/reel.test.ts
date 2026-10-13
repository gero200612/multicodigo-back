import { execFileSync } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  argsDeSegmento,
  argsDeUnion,
  armarReel,
  cuadroDeCartel,
  duracionTotal,
  Guion,
  GUION_DE_PRUEBA,
  renglones,
  TRANSICION,
  type CorrerFfmpeg,
} from '../src/reel.js';

const hayFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('el guion de un reel', () => {
  it('el de muestra es válido y dura lo que dice', () => {
    expect(Guion.safeParse(GUION_DE_PRUEBA).success).toBe(true);
    expect(duracionTotal(GUION_DE_PRUEBA.escenas)).toBeCloseTo(16.9 - 4 * TRANSICION);
  });

  it('muy corto, muy largo o con pocas escenas no pasa', () => {
    const cartel = (duracion: number) => ({ tipo: 'cartel' as const, texto: 'Hola', fondo: 'noche' as const, duracion });
    expect(Guion.safeParse({ estilo: 'tech', escenas: [cartel(2), cartel(2), cartel(2)] }).success).toBe(false);
    expect(Guion.safeParse({ estilo: 'tech', escenas: Array.from({ length: 8 }, () => cartel(6)) }).success).toBe(false);
    expect(Guion.safeParse({ estilo: 'tech', escenas: [cartel(6), cartel(6)] }).success).toBe(false);
  });
});

describe('el dibujo', () => {
  it('parte el texto en renglones que entran', () => {
    const r = renglones('¿Cuántas horas por semana se van en cargar facturas?', 120, 920);
    expect(r.length).toBeGreaterThan(1);
    expect(r.join(' ')).toBe('¿Cuántas horas por semana se van en cargar facturas?');
  });

  it('el cartel es un PNG vertical de 1080x1920', () => {
    const p = cuadroDeCartel('Y quedan cargadas solas.', 'Sin tipear nada.', 'azul');
    expect(p.subarray(1, 4).toString()).toBe('PNG');
    expect(p.readUInt32BE(16)).toBe(1080);
    expect(p.readUInt32BE(20)).toBe(1920);
  });
});

describe('los comandos de ffmpeg', () => {
  it('cada segmento sale a 30 fps, 1080x1920, sin audio y con pocos hilos', () => {
    const a = argsDeSegmento({ tipo: 'cartel', texto: 'Hola', fondo: 'noche', duracion: 3 }, { cuadro: 'c.png' }, 's.mp4', 0);
    expect(a).toEqual(expect.arrayContaining(['-r', '30', '-an', '-threads', '2']));
    expect(a.join(' ')).toContain('zoompan');
    expect(a.join(' ')).toContain('s=1080x1920');
  });

  it('la unión encadena las transiciones con el offset correcto y normaliza la música a -14 LUFS', () => {
    const a = argsDeUnion(['a.mp4', 'b.mp4', 'c.mp4'], [3, 4, 3], { archivo: 'm.mp3', desde: 5 }, 'r.mp4');
    const filtro = a[a.indexOf('-filter_complex') + 1]!;
    expect(filtro).toContain('[0:v][1:v]xfade=transition=fade:duration=0.35:offset=2.650[v1]');
    expect(filtro).toContain('[v1][2:v]xfade=transition=slideup:duration=0.35:offset=6.300[v]');
    expect(filtro).toContain('loudnorm=I=-14');
    expect(a).toEqual(expect.arrayContaining(['-ss', '5', '-i', 'm.mp3', '-movflags', '+faststart']));
  });

  it('sin música va un silencio, para que el video tenga audio igual', () => {
    const a = argsDeUnion(['a.mp4', 'b.mp4', 'c.mp4'], [5, 5, 5], undefined, 'r.mp4');
    expect(a.join(' ')).toContain('anullsrc');
  });
});

describe('el armado', () => {
  it('sin clave de Pixabay la escena de foto sale como cartel, y se corre un ffmpeg por escena más la unión', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reel-'));
    const corridas: string[][] = [];
    const ffmpeg: CorrerFfmpeg = async (args) => void corridas.push(args);
    const r = await armarReel(GUION_DE_PRUEBA, 'x', { dir, ffmpeg });
    expect(corridas).toHaveLength(GUION_DE_PRUEBA.escenas.length + 1);
    // La escena 2 era una foto: sin Pixabay se dibujó como cartel (un solo -i).
    expect(corridas[1]!.filter((x) => x === '-i')).toHaveLength(1);
    expect(r).toMatchObject({ archivo: join(dir, 'reels', 'x.mp4'), medios: [] });
  });

  // Pesado (arma un video de verdad): solo con REEL_REAL=1, para no trabar el resto de la suite.
  it.skipIf(!hayFfmpeg || !process.env.REEL_REAL)(
    'con ffmpeg de verdad sale un mp4 vertical',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'reel-real-'));
      const r = await armarReel(GUION_DE_PRUEBA, 'real', { dir });
      expect((await stat(r.archivo)).size).toBeGreaterThan(100_000);
      const info = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.archivo]).toString().trim();
      expect(info).toBe('1080,1920');
    },
    120_000,
  );
});
