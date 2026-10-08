import { huellaDe, type ReporteDeError } from '@multicodigo/shared';
import { describe, expect, it } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import { agenteDe, armar, type Opciones } from './armar.js';

/**
 * Lo que Homero le manda al registro de errores del bridge (spec
 * 2026-10-08-registro-de-errores): corridas fallidas y buscadores que se
 * cortan sin anotar. Lo esperable (sin cuenta libre, sin uso) no se reporta.
 */

async function vaciar(deps: Parameters<typeof correrSiguiente>[0]) {
  for (let i = 0; i < 50 && (await correrSiguiente(deps)); i++);
}

function conReportes(o: Opciones, reportar?: (r: ReporteDeError) => Promise<unknown>) {
  const h = armar(o);
  const reportes: ReporteDeError[] = [];
  h.deps.reportar =
    reportar ??
    (async (r) => {
      reportes.push(r);
    });
  return { ...h, reportes };
}

const laDistri = {
  nombre: 'La Distri',
  rubro: 'distribuidora',
  zona: 'Rosario',
  web: 'https://ladistri.com.ar',
  por_que: 'Toma pedidos por WhatsApp y tiene volumen',
};

const anotaYNoCierra = agenteDe({
  buscador: async (usar) => {
    await usar('anotar_negocio', laDistri);
  },
  // El vendedor no cierra: la corrida queda fallida.
  vendedor: async () => {},
});

describe('reportes al registro de errores', () => {
  it('un vendedor que termina sin cerrar reporta corrida_fallida', async () => {
    const h = conReportes({ agente: anotaYNoCierra });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    // Buscador y una vuelta del vendedor (la tarea queda reprogramada).
    await correrSiguiente(h.deps);
    await correrSiguiente(h.deps);

    const corrida = h.store.corridasGuardadas.find((c) => c.agente === 'vendedor')!;
    expect(corrida.estado).toBe('fallida');
    expect(h.reportes).toHaveLength(1);
    expect(h.reportes[0]).toMatchObject({
      servicio: 'homero',
      codigo: 'corrida_fallida',
      huella: huellaDe('homero', 'corrida_fallida', 'vendedor:terminó sin cerrar'),
      detalle: { agente: 'vendedor', corridaId: corrida.id, error: 'terminó sin cerrar', turnos: 1 },
    });
  });

  it('un error inesperado del gateway reporta, con los numeros fuera de la huella', async () => {
    const h = conReportes({
      agente: async () => {
        throw new Error('el gateway devolvio 502 tras 40 s');
      },
    });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    await correrSiguiente(h.deps);
    expect(h.reportes).toHaveLength(1);
    expect(h.reportes[0]).toMatchObject({
      codigo: 'corrida_fallida',
      huella: huellaDe('homero', 'corrida_fallida', 'buscador:el gateway devolvio # tras # s'),
      detalle: { agente: 'buscador', error: 'el gateway devolvio 502 tras 40 s' },
    });
  });

  it('el buscador cortado sin anotar reporta buscador_cortado', async () => {
    const h = conReportes({ agente: async () => ({ texto: '', slot: 'c3', cortada: 'turnos' as const }) });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 30 }, requiereIa: true });
    await vaciar(h.deps);
    expect(h.reportes).toHaveLength(1);
    expect(h.reportes[0]).toMatchObject({
      servicio: 'homero',
      codigo: 'buscador_cortado',
      huella: huellaDe('homero', 'buscador_cortado', 'turnos'),
      detalle: { corridaId: h.store.corridasGuardadas[0]!.id, cantidad: 30, cortada: 'turnos' },
    });
  });

  it('el buscador que anota no reporta, aunque se corte', async () => {
    const h = conReportes({
      agente: async (p, sesiones) => {
        await sesiones.usar(p.corrida, p.tokenCorrida, 'anotar_negocio', laDistri);
        return { texto: '', slot: 'c3', cortada: 'turnos' as const };
      },
    });
    // Solo la corrida del buscador.
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    await correrSiguiente(h.deps);
    expect(h.store.leads).toHaveLength(1);
    expect(h.reportes).toEqual([]);
  });

  it('un reportar que tira no rompe la corrida ni cambia como termina', async () => {
    const h = conReportes({ agente: async () => ({ texto: '', slot: 'c3', cortada: 'turnos' as const }) }, async () => {
      throw new Error('el bridge no esta');
    });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 2 }, requiereIa: true });
    await vaciar(h.deps);
    expect(h.store.corridasGuardadas[0]).toMatchObject({ agente: 'buscador', estado: 'lista' });
    expect(h.store.tareas[0]).toMatchObject({ estado: 'lista' });
    expect(h.avisos.some((a) => a.includes('se cortó por tope de turnos'))).toBe(true);

    // En una corrida fallida tampoco, aunque tire sincronico: la tarea se
    // reintenta como siempre.
    const v = conReportes({ agente: anotaYNoCierra }, () => {
      throw new Error('tira sincronico');
    });
    await v.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    await correrSiguiente(v.deps);
    await correrSiguiente(v.deps);
    expect(v.store.corridasGuardadas.find((c) => c.agente === 'vendedor')).toMatchObject({ estado: 'fallida' });
    expect(v.store.tareas.find((t) => t.tipo === 'agente_vender')).toMatchObject({ estado: 'pendiente', intentos: 1 });
  });
});
