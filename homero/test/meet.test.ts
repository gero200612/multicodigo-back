import { describe, expect, it } from 'vitest';
import { encolarPedidosDeMeet, pedirMeet, recibirMeet, type DepsDeMeet } from '../src/meet.js';
import { aprobarSaliente } from '../src/ventas.js';
import { ErrorDeWhatsApp, type ClienteWa } from '../src/whatsapp.js';
import { armar } from './armar.js';

const INICIO = new Date('2026-09-30T18:00:00Z'); // miercoles 15hs AR
const MEET = 'https://meet.google.com/abc-defg-hij';

function waFalso(o: { fueraDeVentana?: boolean; plantillaAprobada?: boolean } = {}) {
  const textos: { a: string; texto: string }[] = [];
  const plantillas: { a: string; plantilla: string; variables: string[] }[] = [];
  const wa = {
    mandar: async (a: string, texto: string) => {
      if (o.fueraDeVentana) throw new ErrorDeWhatsApp(409, 'fuera_de_ventana');
      textos.push({ a, texto });
      return { id: 1, wamid: 'w' };
    },
    avisar: async (a: string, plantilla: string, _idioma: string, variables: string[]) => {
      if (!o.plantillaAprobada) throw new ErrorDeWhatsApp(409, 'plantilla_no_aprobada');
      plantillas.push({ a, plantilla, variables });
      return { id: 2, wamid: 'w' };
    },
    plantillas: async () => [{ nombre: 'link_reunion', idioma: 'es_AR', estado: 'PENDING' }],
  } as unknown as ClienteWa;
  return { wa, textos, plantillas };
}

async function conReunion(canal: 'whatsapp' | 'mail', wa?: ClienteWa) {
  const h = armar();
  const leadId = (await h.store.crearLead({ nombre: 'Ana', rubro: 'panadería', ciudad: '-', telefono: '5491155550000', email: 'ana@x.com', fuente: 'whatsapp' }))!;
  const reunionId = (await h.store.crearReunion({ leadId, inicio: INICIO, fin: INICIO, link: '' }))!;
  const deps: DepsDeMeet = { ...h.deps, wa, aprobar: (id) => aprobarSaliente(id, h.deps) };
  return { h, leadId, reunionId, deps };
}

describe('link de Meet', () => {
  it('encola el pedido a -45 min y el repedido a -10; si falta menos, el primero sale ya', async () => {
    const h = armar();
    await encolarPedidosDeMeet(h.store, new Date('2026-09-29T17:00:00Z'), { reunionId: 1, inicio: INICIO, canal: 'mail' });
    expect(h.store.tareas.map((t) => t.disponibleDesde?.toISOString())).toEqual(['2026-09-30T17:15:00.000Z', '2026-09-30T17:50:00.000Z']);
    const h2 = armar();
    const ahora = new Date('2026-09-30T17:55:00Z');
    await encolarPedidosDeMeet(h2.store, ahora, { reunionId: 1, inicio: INICIO, canal: 'mail' });
    expect(h2.store.tareas.map((t) => t.disponibleDesde?.toISOString())).toEqual([ahora.toISOString()]);
  });

  it('por WhatsApp: Gero responde al pedido con su Meet y le llega al cliente; el repedido ya no sale', async () => {
    const f = waFalso();
    const { h, reunionId, deps } = await conReunion('whatsapp', f.wa);
    await pedirMeet({ reunionId, vuelta: 1, canal: 'whatsapp' }, h.deps);
    const pedido = h.tarjetas.at(-1)!;
    expect(pedido.texto).toContain('Respondé a ESTE mensaje');
    const msg = 1000 + h.tarjetas.length;

    expect(await recibirMeet(msg, 'no es un link', deps)).toContain('Pegame el link de Google Meet');
    expect(await recibirMeet(msg, `dale, ${MEET}`, deps)).toContain('✅');
    expect(f.textos).toEqual([{ a: '5491155550000', texto: expect.stringContaining(MEET) }]);
    expect(f.textos[0]!.texto).toContain('15:00');

    const antes = h.tarjetas.length;
    await pedirMeet({ reunionId, vuelta: 2, canal: 'whatsapp' }, h.deps);
    expect(h.tarjetas).toHaveLength(antes);
  });

  it('un mensaje que no es un pedido de Meet no lo toca', async () => {
    const { deps } = await conReunion('whatsapp', waFalso().wa);
    expect(await recibirMeet(42, MEET, deps)).toBeUndefined();
  });

  it('pasadas las 24 h va con la plantilla; si no está aprobada, Gero se lo manda a mano', async () => {
    const ok = waFalso({ fueraDeVentana: true, plantillaAprobada: true });
    const a = await conReunion('whatsapp', ok.wa);
    await pedirMeet({ reunionId: a.reunionId, vuelta: 1, canal: 'whatsapp' }, a.h.deps);
    expect(await recibirMeet(1000 + a.h.tarjetas.length, MEET, a.deps)).toContain('✅');
    expect(ok.plantillas).toEqual([{ a: '5491155550000', plantilla: 'link_reunion', variables: ['15:00', MEET] }]);

    const mal = waFalso({ fueraDeVentana: true });
    const b = await conReunion('whatsapp', mal.wa);
    await pedirMeet({ reunionId: b.reunionId, vuelta: 1, canal: 'whatsapp' }, b.h.deps);
    const r = await recibirMeet(1000 + b.h.tarjetas.length, MEET, b.deps);
    expect(r).toContain('❌');
    expect(r).toContain('https://wa.me/5491155550000');
  });

  it('por mail: sale en el hilo de la confirmación, sin otra aprobación', async () => {
    const { h, leadId, reunionId, deps } = await conReunion('mail');
    await h.store.crearSaliente({
      leadId,
      tipo: 'confirmacion',
      paso: 0,
      casilla: 'ventas@sincro.com',
      asunto: 'Re: hola',
      cuerpo: 'Quedamos',
      enRespuestaA: '<a@x>',
      reunionId,
    });
    await pedirMeet({ reunionId, vuelta: 1, canal: 'mail' }, h.deps);
    expect(await recibirMeet(1000 + h.tarjetas.length, MEET, deps)).toContain('por mail');
    const tarea = h.store.tareas.find((t) => t.tipo === 'enviar_saliente');
    expect(tarea).toBeDefined();
    const s = await h.store.saliente((tarea!.payload as { salienteId: number }).salienteId);
    expect(s?.cuerpo).toContain(MEET);
    expect(s?.asunto).toBe('Re: hola');
    expect(s?.estado).toBe('aprobado');
  });
});
