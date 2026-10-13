import { beforeEach, describe, expect, it } from 'vitest';
import { ENTRE_ARREGLOS_MS, pliegoDeArreglo, reiniciarVigia, verificarPublicado, type DepsDelVigia, type Problema } from '../src/vigia.js';

const P = { usuarioId: 'u1', proyectoId: 'p1', proyecto: 'TallerPro', desde: new Date('2026-10-13T11:30:00Z') };
const ROTO: Problema[] = [
  { resumen: 'GET /api/inicio/resumen da 500', tarea: 'Arreglar el 500 de inicio...' },
  { resumen: 'Configuracion: "Error interno del servidor"', tarea: 'Arreglar configuracion...' },
];

function armar(o: { problemas?: Problema[]; listo?: boolean; abrir?: { ok: boolean; motivo?: string } } = {}) {
  const avisos: string[] = [];
  const abiertos: string[] = [];
  let reloj = 1_000_000;
  const deps: DepsDelVigia = {
    esperarDespliegues: async () => ({ listo: o.listo ?? true, fallados: [] }),
    verificar: async () => o.problemas ?? [],
    avisar: async (_u, html) => void avisos.push(html),
    abrirArreglo: async (_u, _id, pliego) => {
      abiertos.push(pliego);
      return o.abrir ?? { ok: true };
    },
    ahora: () => reloj,
    dormir: async () => undefined,
  };
  return { deps, avisos, abiertos, avanzar: (ms: number) => (reloj += ms) };
}

beforeEach(() => reiniciarVigia());

describe('el vigía de lo publicado', () => {
  it('si todo anda, solo avisa que está bien', async () => {
    const v = armar();
    expect(await verificarPublicado(P, v.deps)).toBe('ok');
    expect(v.avisos[0]).toContain('✅ Revisé <b>TallerPro</b>');
    expect(v.abiertos).toEqual([]);
  });

  it('si algo falla, avisa la lista y abre una corrida de arreglo con un pliego que pide arreglar la causa', async () => {
    const v = armar({ problemas: ROTO });
    expect(await verificarPublicado(P, v.deps)).toBe('problemas');
    expect(v.avisos[0]).toContain('encontré 2 problema(s)');
    expect(v.avisos[0]).toContain('GET /api/inicio/resumen da 500');
    expect(v.abiertos).toHaveLength(1);
    expect(v.abiertos[0]).toContain('# Arreglar TallerPro publicado');
    expect(v.abiertos[0]).toContain('Arregla la CAUSA');
  });

  it('no abre otra corrida sola antes de 6 horas: avisa y nada más', async () => {
    const v = armar({ problemas: ROTO });
    await verificarPublicado(P, v.deps);
    v.avanzar(ENTRE_ARREGLOS_MS - 1);
    await verificarPublicado(P, v.deps);
    expect(v.abiertos).toHaveLength(1);
    expect(v.avisos[1]).toContain('no abro otra sola');
    v.avanzar(2);
    await verificarPublicado(P, v.deps);
    expect(v.abiertos).toHaveLength(2);
  });

  it('si no pudo abrir la corrida (ya hay una abierta), lo dice', async () => {
    const v = armar({ problemas: ROTO, abrir: { ok: false, motivo: 'ya hay una corrida abierta' } });
    await verificarPublicado(P, v.deps);
    expect(v.avisos[0]).toContain('No pude abrir la corrida de arreglo (ya hay una corrida abierta)');
  });

  it('si el despliegue no termina, no mira la versión vieja', async () => {
    const v = armar({ listo: false, problemas: ROTO });
    expect(await verificarPublicado(P, v.deps)).toBe('sin_terminar');
    expect(v.abiertos).toEqual([]);
  });

  it('dos despliegues del mismo proyecto seguidos (back y front): una sola revisión', async () => {
    const v = armar();
    let soltar!: () => void;
    v.deps.esperarDespliegues = () => new Promise((ok) => (soltar = () => ok({ listo: true, fallados: [] })));
    const primera = verificarPublicado(P, v.deps);
    expect(await verificarPublicado(P, v.deps)).toBe('ya_en_curso');
    soltar();
    expect(await primera).toBe('ok');
  });

  it('el pliego trae el detalle de cada problema', () => {
    const t = pliegoDeArreglo('TallerPro', ROTO);
    expect(t).toContain('### 1. GET /api/inicio/resumen da 500');
    expect(t).toContain('Arreglar configuracion...');
  });
});
