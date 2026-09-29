import { describe, expect, it } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import type { Recibido } from '../src/store.js';
import { aprobarLead, aprobarSaliente, descartarSaliente, MODO, planificar, procesarRebote } from '../src/ventas.js';
import { armar, casilla } from './armar.js';

const borrador = JSON.stringify({
  encaja: true,
  motivo: 'pyme',
  resumen_empresa: 'Distribuidora de bebidas en Rosario',
  dolor: 'toman pedidos por WhatsApp a mano',
  idea: 'bot que carga los pedidos solo',
  asunto: 'pedidos de la distri',
  mensaje: 'Hola, vi que toman pedidos por WhatsApp...',
  seguimiento1: 'Te escribo de nuevo...',
  seguimiento2: '¿Lo dejo acá?',
});

const hallazgo = { externo: 'osm:node/1', nombre: 'La Distri', web: 'https://ladistri.com.ar', fuente: 'osm' as const };

/** Corre la cola hasta que no quede nada listo ahora. */
async function vaciar(deps: Parameters<typeof correrSiguiente>[0]) {
  for (let i = 0; i < 50 && (await correrSiguiente(deps)); i++);
}

async function hastaContactado() {
  const h = armar({
    hallazgos: [hallazgo],
    sitio: { texto: 'Distribuidora La Distri. Pedidos por WhatsApp.', mails: ['ventas@ladistri.com.ar'] },
    pedirIa: async () => borrador,
  });
  await h.store.encolar({ tipo: 'prospectar', payload: { cantidad: 1, rubro: 'distribuidora', ciudad: 'Rosario' }, requiereIa: false });
  await vaciar(h.deps);
  return h;
}

describe('de la busqueda al primer mail', () => {
  it('encuentra, investiga y le pasa a Gero la tarjeta con el mail y los seguimientos', async () => {
    const { store, tarjetas, prompts } = await hastaContactado();
    const lead = store.leads[0]!;
    expect(lead).toMatchObject({ estado: 'borrador', email: 'ventas@ladistri.com.ar' });
    expect(lead.investigacion?.idea).toBe('bot que carga los pedidos solo');
    expect(store.salientes.map((s) => [s.tipo, s.paso, s.estado])).toEqual([
      ['inicial', 0, 'borrador'],
      ['seguimiento', 1, 'borrador'],
      ['seguimiento', 2, 'borrador'],
    ]);
    expect(tarjetas[0]!.datos).toEqual([`ap:${lead.id}`, `de:${lead.id}`]);
    // La web va marcada como no confiable en el prompt.
    expect(prompts[0]).toContain('<no_confiable>');
  });

  it('al aprobar sale el inicial y el seguimiento queda a 3 dias habiles, en el mismo hilo', async () => {
    const h = await hastaContactado();
    await aprobarLead(1, h.deps);
    h.mover(new Date(h.ahora().getTime() + 20 * 60_000));
    await vaciar(h.deps);

    expect(h.enviados).toHaveLength(1);
    expect(h.enviados[0]).toMatchObject({ para: 'ventas@ladistri.com.ar', asunto: 'pedidos de la distri' });
    expect(h.store.leads[0]!.estado).toBe('contactado');

    const seguimiento = h.store.tareas.find((t) => t.tipo === 'enviar_saliente' && t.estado === 'pendiente')!;
    // Martes 14:20 + 3 habiles = viernes.
    expect(seguimiento.disponibleDesde.toISOString().slice(0, 10)).toBe('2026-10-02');

    h.mover(new Date('2026-10-02T17:30:00Z'));
    await vaciar(h.deps);
    expect(h.enviados[1]).toMatchObject({ asunto: 'Re: pedidos de la distri', enRespuestaA: '<m1@x>' });
  });

  it('en modo automatico no pide aprobacion', async () => {
    const h = armar({
      hallazgos: [hallazgo],
      sitio: { texto: 'x', mails: ['ventas@ladistri.com.ar'] },
      pedirIa: async () => borrador,
    });
    await h.store.guardarEstado(MODO, 'auto');
    await h.store.encolar({ tipo: 'prospectar', payload: { cantidad: 1 }, requiereIa: false });
    await vaciar(h.deps);
    expect(h.tarjetas).toHaveLength(0);
    expect(h.store.leads[0]!.estado).toBe('aprobado');
  });

  it('descarta el negocio sin mail o que no encaja', async () => {
    const h = armar({ hallazgos: [hallazgo], sitio: { texto: 'x', mails: [] }, pedirIa: async () => borrador });
    await h.store.encolar({ tipo: 'prospectar', payload: { cantidad: 1 }, requiereIa: false });
    await vaciar(h.deps);
    expect(h.store.leads[0]!.estado).toBe('descartado');
    expect(h.tarjetas).toHaveLength(0);
  });
});

const respuesta = (cuerpo: string, extra: Partial<Recibido> = {}): Recibido => ({
  cuenta: casilla.email,
  messageId: `<r${Math.random()}@c>`,
  de: 'Ana <ventas@ladistri.com.ar>',
  asunto: 'Re: pedidos de la distri',
  cuerpo,
  recibidoEn: new Date(),
  ...extra,
});

async function contactadoYRespondio(analisis: object) {
  const h = await hastaContactado();
  await aprobarLead(1, h.deps);
  h.mover(new Date(h.ahora().getTime() + 20 * 60_000));
  await vaciar(h.deps);
  h.deps.pedirIa = async () => JSON.stringify(analisis);
  return h;
}

describe('cuando responden', () => {
  it('un interesado corta los seguimientos y Gero recibe la respuesta propuesta con 3 horarios', async () => {
    const h = await contactadoYRespondio({
      tipo: 'interesado',
      empresa: 'La Distri',
      resumen: 'Quiere ver cómo sería',
      sugerencia: 'Ofrecer reunión',
      respuesta: 'Buenísimo, ¿te sirve alguno de estos horarios?',
    });
    await h.store.encolar({ tipo: 'resumir_respuesta', payload: respuesta('Me interesa'), requiereIa: true });
    await vaciar(h.deps);

    expect(h.store.leads[0]!.estado).toBe('respondio');
    expect(h.store.salientes.filter((s) => s.tipo === 'seguimiento').every((s) => s.estado === 'cancelado')).toBe(true);
    expect(h.store.ofertas.get(1)).toHaveLength(3);
    const tarjeta = h.tarjetas.at(-1)!;
    expect(tarjeta.texto).toContain('Qué hacen: Distribuidora de bebidas en Rosario');
    expect(tarjeta.datos[0]).toMatch(/^en:/);

    // Gero toca Enviar: sale en el hilo aunque sean las 22hs.
    h.mover(new Date('2026-09-30T01:00:00Z'));
    await aprobarSaliente(Number(tarjeta.datos[0]!.slice(3)), h.deps);
    await vaciar(h.deps);
    expect(h.enviados.at(-1)).toMatchObject({ texto: 'Buenísimo, ¿te sirve alguno de estos horarios?' });
  });

  async function eligioElPrimero() {
    const h = await contactadoYRespondio({ tipo: 'eligio_horario', empresa: 'La Distri', resumen: 'El 1', sugerencia: '-', horario_elegido: 1 });
    const horario = new Date('2026-09-30T18:00:00Z'); // miercoles 15hs AR
    await h.store.guardarOferta(1, [horario]);
    const antes = h.enviados.length;
    await h.store.encolar({ tipo: 'resumir_respuesta', payload: respuesta('Dale, el primero'), requiereIa: true });
    await vaciar(h.deps);
    return { h, antes };
  }

  it('si elige un horario reserva, pero la confirmacion NO sale sin el OK de Gero', async () => {
    const { h, antes } = await eligioElPrimero();
    expect(h.store.reuniones).toHaveLength(1);
    expect(h.store.leads[0]!.estado).toBe('reunion');
    expect(h.enviados).toHaveLength(antes);
    const tarjeta = h.tarjetas.at(-1)!;
    expect(tarjeta.texto).toContain('ELIGIÓ HORARIO');
    expect(tarjeta.datos[0]).toMatch(/^en:/);

    await aprobarSaliente(Number(tarjeta.datos[0]!.slice(3)), h.deps);
    await vaciar(h.deps);
    const confirmacion = h.enviados.at(-1)!;
    expect(confirmacion.ics).toContain('DTSTART:20260930T180000Z');
    expect(confirmacion.cc).toBe('gero@personal.com');
    expect(confirmacion.texto).toContain('meet.jit.si');
    expect(h.store.tareas.filter((t) => t.tipo === 'recordatorio')).toHaveLength(2);
  });

  it('si Gero no manda la confirmacion, el horario se libera', async () => {
    const { h } = await eligioElPrimero();
    const tarjeta = h.tarjetas.at(-1)!;
    await descartarSaliente(Number(tarjeta.datos[1]!.slice(3)), h.deps);
    expect(await h.store.reunionesDesde(new Date(0))).toHaveLength(0);
    expect(h.store.leads[0]!.estado).toBe('respondio');
  });

  it('el recordatorio al cliente tambien espera el OK', async () => {
    const { h } = await eligioElPrimero();
    await aprobarSaliente(Number(h.tarjetas.at(-1)!.datos[0]!.slice(3)), h.deps);
    await vaciar(h.deps);
    const enviadosAntes = h.enviados.length;
    h.mover(new Date('2026-09-30T16:05:00Z')); // 2hs antes
    await vaciar(h.deps);
    expect(h.enviados).toHaveLength(enviadosAntes);
    expect(h.tarjetas.at(-1)!.texto).toContain('Recordatorio para La Distri');
  });

  it('si responde otra persona de la empresa, lo reconoce por el hilo y le contesta a ella', async () => {
    const h = await contactadoYRespondio({ tipo: 'otro', empresa: 'La Distri', resumen: 'reenvio', sugerencia: '-' });
    await h.store.encolar({
      tipo: 'resumir_respuesta',
      payload: respuesta('Soy Juan, el dueño', { de: 'Juan <juan@ladistri.com.ar>', enRespuestaA: '<m1@x>' }),
      requiereIa: true,
    });
    await vaciar(h.deps);
    expect(h.store.leads[0]).toMatchObject({ estado: 'respondio', email: 'juan@ladistri.com.ar' });
  });
});

describe('rebotes', () => {
  it('marca el lead y frena la casilla si rebotan muchos', async () => {
    const h = armar();
    for (let i = 0; i < 3; i++) {
      await h.store.crearLead({ nombre: `N${i}`, rubro: 'x', ciudad: 'y', fuente: 'osm', email: `malo${i}@x.com` });
      await h.store.registrarEnvio({ cuenta: casilla.email, para: `malo${i}@x.com`, asunto: 'a' });
      await procesarRebote(
        { cuenta: casilla.email, messageId: `<b${i}>`, de: 'mailer-daemon@googlemail.com', asunto: 'Delivery failed', cuerpo: `Address not found: malo${i}@x.com`, recibidoEn: new Date() },
        h.deps,
      );
    }
    expect(h.store.leads.every((l) => l.estado === 'rebotado')).toBe(true);
    expect(await h.store.leerEstado(`casilla_pausada:${casilla.email}`)).toBeDefined();
    expect(h.avisos.some((a) => a.includes('Frené'))).toBe(true);
  });
});

describe('planificar', () => {
  it('un dia habil a la mañana sale a buscar una vez, y a la noche manda el resumen', async () => {
    const h = armar({ ahora: new Date('2026-09-29T11:00:00Z') }); // martes 8hs AR
    await planificar(h.deps);
    await planificar(h.deps);
    expect(h.store.tareas.filter((t) => t.tipo === 'prospectar')).toHaveLength(1);
    expect(h.store.tareas[0]!.payload).toEqual({ cantidad: 3 }); // 60% de un cupo de 5

    h.mover(new Date('2026-09-29T23:45:00Z')); // 20:45 AR
    await planificar(h.deps);
    expect(h.store.tareas.some((t) => t.tipo === 'resumen_diario')).toBe(true);
  });

  it('el fin de semana no sale a buscar', async () => {
    const h = armar({ ahora: new Date('2026-10-03T13:00:00Z') }); // sabado
    await planificar(h.deps);
    expect(h.store.tareas).toHaveLength(0);
  });
});
