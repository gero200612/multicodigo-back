import { describe, expect, it } from 'vitest';
import { carpetaDeAnalisis, guardarAnalisis, guardarCapturas, type DepsDeAnalisis } from '../src/analisis.js';
import type { FilaDeDocumento } from '../src/store.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PROYECTO = '11111111-1111-4111-8111-111111111111';
const USUARIO = '22222222-2222-4222-8222-222222222222';
const AHORA = new Date('2026-10-03T15:00:00Z');

function deps() {
  const disco = new Map<string, Uint8Array>();
  const filas: FilaDeDocumento[] = [];
  const d: DepsDeAnalisis = {
    supabaseUrl: '',
    serviceKey: '',
    docsRaiz: '/srv/docs',
    crearDir: async () => {},
    escribir: async (ruta, datos) => {
      disco.set(ruta, datos);
    },
    guardarFila: async (f) => {
      filas.push(f);
    },
    leer: async (ruta) => {
      const v = disco.get(`/srv/docs/${ruta}`);
      if (!v) throw new Error('no existe');
      return v;
    },
  };
  return { d, disco, filas };
}

describe('análisis funcional', () => {
  it('la carpeta lleva el nombre del proyecto, limpio', () => {
    expect(carpetaDeAnalisis('Sincro Resto')).toBe('Análisis funcional (Sincro Resto)');
    expect(carpetaDeAnalisis('a/b<script>')).toBe('Análisis funcional (abscript)');
  });

  it('guarda las capturas PNG en la carpeta de capturas, como del agente', async () => {
    const { d, filas, disco } = deps();
    const nombres = await guardarCapturas(
      { proyectoId: PROYECTO, usuarioId: USUARIO, proyecto: 'Sincro Resto', ahora: AHORA, capturas: [{ nombre: 'ventas antes', png: PNG_1X1 }] },
      d,
    );
    expect(nombres).toEqual(['ventas-antes-20261003150000.png']);
    expect(filas[0]).toMatchObject({ tipo: 'png', origen: 'agente', carpeta: 'Análisis funcional (Sincro Resto)/capturas' });
    expect(disco.has(`/srv/docs/${PROYECTO}/ventas-antes-20261003150000.png`)).toBe(true);
  });

  it('lo que no es PNG se descarta', async () => {
    const { d, filas } = deps();
    const nombres = await guardarCapturas(
      { proyectoId: PROYECTO, usuarioId: USUARIO, proyecto: 'x', capturas: [{ nombre: 'malo', png: Buffer.from('<svg/>').toString('base64') }] },
      d,
    );
    expect(nombres).toEqual([]);
    expect(filas).toEqual([]);
  });

  it('arma un PDF con las capturas y lo deja en la carpeta del análisis', async () => {
    const { d, filas, disco } = deps();
    const [captura] = await guardarCapturas(
      { proyectoId: PROYECTO, usuarioId: USUARIO, proyecto: 'Sincro Resto', ahora: AHORA, capturas: [{ nombre: 'ventas', png: PNG_1X1 }] },
      d,
    );
    const r = await guardarAnalisis(
      {
        proyectoId: PROYECTO,
        usuarioId: USUARIO,
        proyecto: 'Sincro Resto',
        ahora: AHORA,
        titulo: 'Exportar ventas a Excel',
        resumen: 'Se agregó un botón para bajar las ventas.',
        secciones: [{ titulo: 'Lista de ventas', texto: 'El botón está arriba a la derecha.', capturas: [captura!, 'no-existe.png'] }],
      },
      d,
    );
    expect(r.nombre).toMatch(/^analisis-funcional-Exportar-ventas-a-Excel-\d+\.pdf$/);
    const conJob = await guardarAnalisis(
      { proyectoId: PROYECTO, usuarioId: USUARIO, proyecto: 'x', titulo: 'T', resumen: 'r', jobId: 'abcd1234-5678-4abc-8def-111111111111', secciones: [{ titulo: 's', texto: 't' }] },
      d,
    );
    expect(conJob.nombre).toMatch(/^analisis-funcional-jabcd1234-T-\d+\.pdf$/);
    expect(r.faltantes).toEqual(['no-existe.png']);
    const pdf = disco.get(`/srv/docs/${PROYECTO}/${r.nombre}`)!;
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    expect(filas.find((f) => f.nombre === r.nombre)).toMatchObject({ tipo: 'pdf', origen: 'agente', carpeta: 'Análisis funcional (Sincro Resto)' });
    expect(disco.has(`/srv/docs/${PROYECTO}/${r.nombre}.md`)).toBe(true);
  });

  it('no lee capturas con rutas raras', async () => {
    const { d } = deps();
    const r = await guardarAnalisis(
      {
        proyectoId: PROYECTO,
        usuarioId: USUARIO,
        proyecto: 'x',
        titulo: 't',
        resumen: 'r',
        secciones: [{ titulo: 's', texto: 'x', capturas: ['../otro/secreto.png', 'a/b.png'] }],
      },
      d,
    );
    expect(r.faltantes).toEqual(['../otro/secreto.png', 'a/b.png']);
  });
});
