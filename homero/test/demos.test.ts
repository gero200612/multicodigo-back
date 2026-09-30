import { describe, expect, it, vi } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import {
  armarDemo,
  cancelarDemo,
  editarPliego,
  enviarDemo,
  proyectoDeDemo,
  seguirDemos,
  type ClienteDePunchi,
} from '../src/demos.js';
import { armar } from './armar.js';

const PLIEGO = '# Turnero — demo para Estudio Pérez\n## Para qué es\nTurnos online y recordatorios.';

function conReunion(punchi?: Partial<ClienteDePunchi>) {
  const h = armar({ pedirIa: async () => PLIEGO });
  const cliente: ClienteDePunchi = {
    abrir: vi.fn(async () => ({ ok: true as const, corridaId: 'c-1' })),
    estado: vi.fn(async () => ({ estado: 'abierta' as const })),
    ...punchi,
  };
  const deps = { ...h.deps, punchi: cliente };
  return { ...h, deps, cliente };
}

async function sembrar(h: ReturnType<typeof conReunion>) {
  const leadId = (await h.store.crearLead({
    nombre: 'Estudio Pérez & Asoc.',
    rubro: 'contable',
    ciudad: 'Rosario',
    email: 'info@perez.com',
    fuente: 'osm',
  }))!;
  await h.store.actualizarLead(leadId, {
    estado: 'reunion',
    investigacion: { resumen_empresa: 'Estudio contable', dolor: 'cargan facturas a mano', idea: 'facturas por WhatsApp' },
  });
  const inicio = new Date('2026-10-02T15:00:00Z');
  const reunionId = (await h.store.crearReunion({ leadId, inicio, fin: new Date(inicio.getTime() + 1_800_000), link: 'https://meet.jit.si/x' }))!;
  return { leadId, reunionId };
}

describe('proyectoDeDemo', () => {
  it('saca acentos y simbolos, y termina en -demo', () => {
    expect(proyectoDeDemo('Estudio Pérez & Asoc.')).toBe('estudio-perez-asoc-demo');
    expect(proyectoDeDemo('!!!')).toBe('empresa-demo');
  });
});

describe('el camino de una demo', () => {
  it('armar -> pliego con tarjeta -> enviar a Punchi -> lista con la url', async () => {
    const h = conReunion();
    const { reunionId } = await sembrar(h);

    const r = await armarDemo(reunionId, h.deps);
    expect(r.ok).toBe(true);
    await correrSiguiente(h.deps);

    const demo = (await h.store.demoDeReunion(reunionId))!;
    expect(demo.estado).toBe('pliego');
    expect(demo.pliego).toBe(PLIEGO);
    expect(demo.proyecto).toBe('estudio-perez-asoc-demo');
    // El prompt lleva lo que sabemos de la empresa.
    expect(h.prompts.at(-1)).toContain('cargan facturas a mano');
    const tarjeta = h.tarjetas.at(-1)!;
    expect(tarjeta.texto).toContain('PLIEGO DE DEMO');
    expect(tarjeta.datos).toEqual([`dp:${demo.id}`, `dc:${demo.id}`]);
    expect(demo.telegramMsg).toBeDefined();

    const e = await enviarDemo(demo.id, h.deps);
    expect(e.ok).toBe(true);
    expect(h.cliente.abrir).toHaveBeenCalledWith('estudio-perez-asoc-demo', PLIEGO);
    expect((await h.store.demo(demo.id))!.estado).toBe('enviada');

    // Mientras la corrida sigue abierta, no cambia ni avisa.
    await seguirDemos(h.deps);
    expect((await h.store.demo(demo.id))!.estado).toBe('enviada');

    h.cliente.estado = vi.fn(async () => ({ estado: 'cerrada' as const, url: 'https://perez-front.onrender.com' }));
    await seguirDemos(h.deps);
    const lista = (await h.store.demo(demo.id))!;
    expect(lista.estado).toBe('lista');
    expect(lista.url).toBe('https://perez-front.onrender.com');
    expect(h.avisos.at(-1)).toContain('https://perez-front.onrender.com');

    // Ya no se pregunta mas por ella.
    await seguirDemos(h.deps);
    expect(h.avisos.filter((a) => a.includes('publicada'))).toHaveLength(1);
  });

  it('una sola demo por reunion, salvo que la anterior haya fallado', async () => {
    const h = conReunion();
    const { reunionId } = await sembrar(h);
    await armarDemo(reunionId, h.deps);
    expect(await armarDemo(reunionId, h.deps)).toEqual({ ok: false, motivo: expect.stringContaining('ya hay una demo') });

    const demo = (await h.store.demoDeReunion(reunionId))!;
    await cancelarDemo(demo.id, h.deps);
    const otra = await armarDemo(reunionId, h.deps);
    expect(otra.ok && otra.demo.estado).toBe('redactando');
    expect(otra.ok && otra.demo.id).toBe(demo.id);
  });

  it('si Punchi esta ocupado queda el pliego con el motivo, para reintentar', async () => {
    const h = conReunion({ abrir: vi.fn(async () => ({ ok: false as const, motivo: 'Punchi esta ocupado con x' })) });
    const { reunionId } = await sembrar(h);
    await armarDemo(reunionId, h.deps);
    await correrSiguiente(h.deps);
    const demo = (await h.store.demoDeReunion(reunionId))!;

    const r = await enviarDemo(demo.id, h.deps);
    expect(r).toEqual({ ok: false, motivo: 'Punchi esta ocupado con x' });
    const despues = (await h.store.demo(demo.id))!;
    expect(despues.estado).toBe('pliego');
    expect(despues.error).toContain('ocupado');
  });

  it('una corrida que cierra sin url queda fallida y avisa', async () => {
    const h = conReunion({ estado: vi.fn(async () => ({ estado: 'cerrada' as const, motivoDeCierre: 'techo' })) });
    const { reunionId } = await sembrar(h);
    await armarDemo(reunionId, h.deps);
    await correrSiguiente(h.deps);
    const demo = (await h.store.demoDeReunion(reunionId))!;
    await enviarDemo(demo.id, h.deps);
    await seguirDemos(h.deps);
    expect((await h.store.demo(demo.id))!.estado).toBe('fallida');
    expect(h.avisos.at(-1)).toContain('techo');
  });

  it('el pliego se puede editar antes de enviar, no despues', async () => {
    const h = conReunion();
    const { reunionId } = await sembrar(h);
    await armarDemo(reunionId, h.deps);
    await correrSiguiente(h.deps);
    const demo = (await h.store.demoDeReunion(reunionId))!;

    expect((await editarPliego(demo.id, `${PLIEGO}\nCon login admin/admin.`, h.deps)).ok).toBe(true);
    await enviarDemo(demo.id, h.deps);
    expect(h.cliente.abrir).toHaveBeenCalledWith(demo.proyecto, `${PLIEGO}\nCon login admin/admin.`);
    expect(await editarPliego(demo.id, `${PLIEGO} otra vez`, h.deps)).toEqual({ ok: false, motivo: expect.any(String) });
  });

  it('sin bridge configurado no se arma', async () => {
    const h = conReunion();
    const { reunionId } = await sembrar(h);
    const r = await armarDemo(reunionId, { ...h.deps, punchi: undefined });
    expect(r.ok).toBe(false);
  });
});
