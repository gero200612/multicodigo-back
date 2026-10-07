import { describe, expect, it } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import { CONFIG_DEL_BUSCADOR } from '../src/agentes.js';
import { armarTablero } from '../src/tablero.js';
import { agenteDe, armar } from './armar.js';

const tablero = (h: ReturnType<typeof armar>) =>
  armarTablero({ store: h.store, ahora: h.deps.ahora, enCurso: () => h.sesiones.enCurso() });

describe('el tablero de los agentes', () => {
  it('sin nada que hacer, cada uno esta libre y dice que espera', async () => {
    const t = await tablero(armar());
    expect(t.agentes.buscador.estado).toBe('libre');
    expect(t.agentes.vendedor.detalle).toContain('espera a que el buscador');
    expect(t.agentes.atencion.detalle).toContain('bandejas');
  });

  it('mientras trabaja se ve en vivo que herramienta usa y con que', async () => {
    let enVivo: Awaited<ReturnType<typeof tablero>> | undefined;
    const h = armar({
      paginas: { 'https://imprentanorte.com.ar': '<p>Imprenta Norte</p>' },
      agente: agenteDe({
        buscador: async (usar) => {
          await usar('leer_pagina', { url: 'https://imprentanorte.com.ar' });
          enVivo = await tablero(h);
        },
      }),
    });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    await correrSiguiente(h.deps);

    expect(enVivo!.agentes.buscador.estado).toBe('trabajando');
    expect(enVivo!.agentes.buscador.detalle).toBe('Leyendo https://imprentanorte.com.ar');
    expect(enVivo!.agentes.buscador.ahora!.pasos.map((p) => p.herramienta)).toEqual(['leer_pagina']);
    // Terminada la corrida, deja de figurar como trabajando.
    expect((await tablero(h)).agentes.buscador.estado).not.toBe('trabajando');
  });

  it('esperando una cuenta libre lo dice con todas las letras', async () => {
    const h = armar();
    await h.store.encolar({ tipo: 'agente_vender', payload: { leadId: 1 }, requiereIa: true });
    await h.store.reprogramar(1, new Date(h.ahora().getTime() + 600_000), { contarIntento: false, error: 'sin cuenta libre' });
    const t = await tablero(h);
    expect(t.agentes.vendedor).toMatchObject({ estado: 'esperando', enCola: 1 });
    expect(t.agentes.vendedor.detalle).toContain('cuenta de Claude libre');
  });

  it('con la pausa manual, los agentes figuran en pausa', async () => {
    const h = armar();
    await h.store.guardarEstado('pausa_manual', { desde: new Date().toISOString() });
    expect((await tablero(h)).agentes.buscador.estado).toBe('pausado');
  });

  it('lo que Gero configura del buscador le llega en el objetivo', async () => {
    const h = armar({ agente: agenteDe({ buscador: async () => {} }) });
    await h.store.guardarEstado(CONFIG_DEL_BUSCADOR, { zonas: 'San Isidro y Tigre', rubrosAEvitar: 'gastronomía' });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
    await correrSiguiente(h.deps);
    expect(h.corridas[0]!.objetivo).toContain('Zonas donde buscar: San Isidro y Tigre');
    expect(h.corridas[0]!.objetivo).toContain('Rubros a NO buscar: gastronomía');
  });
});
