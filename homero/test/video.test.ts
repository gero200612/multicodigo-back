import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hojaDeContacto, medirVideo, portadaDe } from '../src/video.js';

// Con ffmpeg de verdad: si la maquina no lo tiene, se saltea (en el contenedor esta).
const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe.skipIf(!hayFfmpeg)('video con ffmpeg', () => {
  let dir: string;
  let video: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'homero-video-'));
    video = join(dir, 'prueba.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30:duration=4', '-pix_fmt', 'yuv420p', video]);
    expect(r.status).toBe(0);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mide ancho, alto y duración', async () => {
    const m = await medirVideo(video);
    expect(m).toMatchObject({ ancho: 540, alto: 960 });
    expect(m.duracion).toBeCloseTo(4, 0);
  });

  it('la hoja de contacto y la portada son PNG', async () => {
    expect((await hojaDeContacto(video)).subarray(0, 4)).toEqual(PNG);
    expect((await portadaDe(video)).subarray(0, 4)).toEqual(PNG);
  });

  it('un archivo que no es video es un error', async () => {
    await expect(medirVideo(join(dir, 'no-existe.mp4'))).rejects.toThrow();
  });
});
