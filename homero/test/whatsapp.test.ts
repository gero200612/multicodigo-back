import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { agenteWhatsApp } from '../src/agentes.js';
import {
  recibirLeads,
  resolverIa,
  rutasDeWhatsApp,
  variantesDeTelefono,
  yaContestado,
  ErrorDeWhatsApp,
  type AdminWa,
  type Charla,
  type ClienteWa,
  type EventoWa,
  type Pedir,
} from '../src/whatsapp.js';
import { agenteDe, armar } from './armar.js';

const CONTACTO = '5491155550000';

function waFalso(charla: Partial<Charla> = {}) {
  const mandados: { a: string; texto: string }[] = [];
  const acks: number[][] = [];
  let eventos: EventoWa[] = [];
  let fallarCon: string | undefined;
  const wa: ClienteWa = {
    eventos: async () => eventos,
    ack: async (ids) => void acks.push(ids),
    mandar: async (a, texto) => {
      if (fallarCon) throw new ErrorDeWhatsApp(409, fallarCon);
      mandados.push({ a, texto });
      return { id: mandados.length, wamid: `wamid.${mandados.length}` };
    },
    charla: async (contacto) => ({
      contacto,
      ventana_abierta: true,
      baja: false,
      mensajes: [{ id: 10, direccion: 'entra', tipo: 'text', texto: 'Hola, vi el anuncio, ¿cómo funciona?', fecha: '2026-09-29T16:59:00Z' }],
      ...charla,
    }),
  };
  return {
    wa,
    mandados,
    acks,
    ponerEventos: (e: EventoWa[]) => (eventos = e),
    fallar: (c: string) => (fallarCon = c),
  };
}

const payload = { contacto: CONTACTO, nombre: 'Ana', tipo: 'text', texto: 'Hola, vi el anuncio, ¿cómo funciona?', referral: null, mensaje_id: 10 };

describe('whatsapp: helpers', () => {
  it('variantes de un celular argentino, con y sin el 9', () => {
    expect(variantesDeTelefono('5491155550000').sort()).toEqual(['541155550000', '5491155550000']);
    expect(variantesDeTelefono('+54 11 5555-0000').sort()).toEqual(['541155550000', '5491155550000']);
  });

  it('yaContestado: solo si salió algo después de ese mensaje', () => {
    const c = (m: Charla['mensajes']): Charla => ({ contacto: CONTACTO, ventana_abierta: true, baja: false, mensajes: m });
    const entra = (id: number) => ({ id, direccion: 'entra' as const, tipo: 'text', texto: 'x', fecha: '' });
    const sale = (id: number) => ({ id, direccion: 'sale' as const, tipo: 'text', texto: 'y', fecha: '' });
    expect(yaContestado(c([entra(1), entra(2)]), 1)).toBe(false);
    expect(yaContestado(c([entra(1), entra(2), sale(3)]), 1)).toBe(true);
    expect(yaContestado(c([sale(0), entra(1)]), 1)).toBe(false);
  });
});

describe('whatsapp: recibir leads', () => {
  it('cada mensaje es una tarea del agente, con espera para juntar, y recién después se confirma', async () => {
    const h = armar();
    const f = waFalso();
    f.ponerEventos([
      { id: 7, tipo: 'mensaje', fecha: '', datos: payload },
      { id: 8, tipo: 'otro', fecha: '', datos: {} },
    ]);
    await recibirLeads(f.wa, h.store, h.ahora);
    const tareas = h.store.tareas.filter((t) => t.tipo === 'agente_whatsapp');
    expect(tareas).toHaveLength(1);
    expect(tareas[0]!.clave).toBe('wa:7');
    expect(f.acks).toEqual([[7, 8]]);
    // Si el ack no llegó y el bot lo vuelve a mandar, no se duplica.
    await recibirLeads(f.wa, h.store, h.ahora);
    expect(h.store.tareas.filter((t) => t.tipo === 'agente_whatsapp')).toHaveLength(1);
  });
});

describe('whatsapp: el agente', () => {
  it('responde solo, registra el lead, guarda los horarios ofrecidos y avisa a Gero', async () => {
    const f = waFalso();
    const h = armar({
      agente: agenteDe({
        atencion: async (usar, p) => {
          expect(p.herramientas).toContain('responder');
          expect(p.sistema).toContain('WhatsApp');
          const charla = await usar('ver_charla');
          expect(charla.texto).toContain('vi el anuncio');
          expect(charla.texto).toContain('<no_confiable>');
          const r = await usar('responder', { texto: 'Hola Ana! Te cuento en una llamada corta. ¿Te sirve 1 o 2?', horarios: [1, 2] });
          expect(r.error).toBe(false);
        },
      }),
    });
    h.deps.wa = f.wa;
    await agenteWhatsApp(payload, h.deps);
    expect(f.mandados).toHaveLength(1);
    expect(f.mandados[0]!.a).toBe(CONTACTO);
    const lead = await h.store.leadPorTelefono(variantesDeTelefono(CONTACTO));
    expect(lead?.fuente).toBe('whatsapp');
    expect((await h.store.oferta(lead!.id))?.length).toBe(2);
    expect(h.avisos.some((a) => a.includes('Le contesté'))).toBe(true);
  });

  it('no manda links y no contesta dos veces en la misma corrida', async () => {
    const f = waFalso();
    const h = armar({
      agente: agenteDe({
        atencion: async (usar) => {
          expect((await usar('responder', { texto: 'mirá www.sincro.com', horarios: [] })).error).toBe(true);
          expect((await usar('responder', { texto: 'Hola!', horarios: [] })).error).toBe(false);
          expect((await usar('responder', { texto: 'Hola de nuevo!', horarios: [] })).error).toBe(true);
        },
      }),
    });
    h.deps.wa = f.wa;
    await agenteWhatsApp(payload, h.deps);
    expect(f.mandados.map((m) => m.texto)).toEqual(['Hola!']);
  });

  it('confirmar un horario ofrecido reserva la reunión y manda el link por WhatsApp', async () => {
    const f = waFalso();
    let ofrecido = '';
    const h = armar({
      agente: agenteDe({
        atencion: async (usar) => {
          ofrecido = (await usar('horarios_libres')).texto.split('\n')[0]!;
          await usar('responder', { texto: '¿Te sirve este?', horarios: [1] });
        },
      }),
    });
    h.deps.wa = f.wa;
    await agenteWhatsApp(payload, h.deps);
    // Contesta "el 1" en otro mensaje: otra corrida.
    const h2 = { ...h };
    h2.deps.gateway = {
      correr: async (p) => {
        const r = await h.sesiones.usar(p.corrida, p.tokenCorrida, 'confirmar_horario', { horario: 1 });
        expect(r.error).toBe(false);
        return { texto: '', turnos: 1, pasos: [] };
      },
    };
    await agenteWhatsApp({ ...payload, texto: 'el 1', mensaje_id: 11 }, h2.deps);
    expect(f.mandados[1]!.texto).toContain('Link para entrar');
    expect(ofrecido).not.toBe('');
    const lead = await h.store.leadPorTelefono(variantesDeTelefono(CONTACTO));
    expect(lead?.estado).toBe('reunion');
    expect(h.avisos.some((a) => a.includes('Reunión por WhatsApp'))).toBe(true);
  });

  it('si ya salió una respuesta después de ese mensaje, no piensa de nuevo', async () => {
    const f = waFalso({
      mensajes: [
        { id: 10, direccion: 'entra', tipo: 'text', texto: 'hola', fecha: '' },
        { id: 11, direccion: 'entra', tipo: 'text', texto: '¿cómo es?', fecha: '' },
        { id: 12, direccion: 'sale', tipo: 'text', texto: 'Hola!', fecha: '' },
      ],
    });
    const h = armar();
    h.deps.wa = f.wa;
    await agenteWhatsApp(payload, h.deps);
    expect(h.corridas).toHaveLength(0);
  });

  it('fuera de la ventana de 24 h el agente se entera y no rompe nada', async () => {
    const f = waFalso();
    f.fallar('fuera_de_ventana');
    const h = armar({
      agente: agenteDe({
        atencion: async (usar) => {
          const r = await usar('responder', { texto: 'Hola!', horarios: [] });
          expect(r.error).toBe(true);
          expect(r.texto).toContain('24 h');
          await usar('avisar_a_gero', { texto: 'No le pude contestar a tiempo' });
        },
      }),
    });
    h.deps.wa = f.wa;
    await agenteWhatsApp(payload, h.deps);
    expect(f.mandados).toHaveLength(0);
  });
});

describe('whatsapp: la sección de la web', () => {
  function adminFalso() {
    const pedidos: { metodo: string; ruta: string; cuerpo?: unknown }[] = [];
    const pedir: Pedir = async (metodo, ruta, cuerpo) => {
      pedidos.push({ metodo, ruta, cuerpo });
      return { status: 200, json: { ok: true } };
    };
    const admin: AdminWa = {
      pedir,
      eventos: async () => [],
      ack: async () => {},
      iaPendientes: async () => [],
      iaArchivo: async () => ({ datos: Buffer.from(''), tipo: 'image/jpeg' }),
      iaResultado: async () => {},
    };
    return { admin, pedidos };
  }

  it('pasa solo las rutas de la lista y firma como gero lo que cambia algo', async () => {
    const { admin, pedidos } = adminFalso();
    const app = Fastify();
    rutasDeWhatsApp(app, admin);
    expect((await app.inject({ method: 'GET', url: '/whatsapp/resumen?mes=2026-10' })).statusCode).toBe(200);
    expect(pedidos[0]).toEqual({ metodo: 'GET', ruta: '/admin/resumen?mes=2026-10', cuerpo: undefined });
    await app.inject({ method: 'PATCH', url: '/whatsapp/negocios/3', payload: { tope_mensual_ars: 50000, quien: 'otro' } });
    expect(pedidos[1]).toEqual({ metodo: 'PATCH', ruta: '/admin/negocios/3', cuerpo: { tope_mensual_ars: 50000, quien: 'gero' } });
    // Lo que no está en la lista no existe: ni la IA ni los eventos del admin.
    expect((await app.inject({ method: 'GET', url: '/whatsapp/ia/pendientes' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/whatsapp/eventos' })).statusCode).toBe(404);
    expect(pedidos).toHaveLength(2);
  });
});

describe('whatsapp: la IA que pide el bot', () => {
  it('atender: devuelve la respuesta del JSON y cuánto texto se usó', async () => {
    const h = armar({
      agente: async (p) => {
        expect(p.herramientas).toEqual([]);
        expect(p.objetivo).toContain('<no_confiable>');
        return { texto: '{"respuesta":"Abrimos de 9 a 18.","derivar":false,"motivo":""}' };
      },
    });
    const resultados: unknown[] = [];
    const admin = { iaResultado: async (_id: number, c: unknown) => void resultados.push(c) } as unknown as AdminWa;
    await resolverIa(
      { id: 1, negocio_id: 2, tipo: 'atender', entrada: { contexto: 'Horario 9 a 18', charla: [{ direccion: 'entra', texto: '¿Hasta qué hora?' }], negocio: 'Taller X' } },
      { admin, gateway: h.deps.gateway, sesiones: h.sesiones },
    );
    expect(resultados[0]).toMatchObject({ ok: true, salida: { respuesta: 'Abrimos de 9 a 18.', derivar: false } });
  });

  it('factura: el modelo ve la imagen por MCP y devuelve los datos con su herramienta', async () => {
    const h = armar({
      agente: async (p, sesiones) => {
        const vista = await sesiones.usar(p.corrida, p.tokenCorrida, 'ver_factura', {});
        expect(vista.bloques[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
        await sesiones.usar(p.corrida, p.tokenCorrida, 'devolver_factura', {
          es_factura: true,
          datos: { proveedor: 'Edesur', cuit: null, numero: '0001-123', fecha: '2026-10-01', vencimiento: '2026-10-18', total: 48230, moneda: 'ARS', impuestos: [] },
          falta: [],
        });
        return { texto: '' };
      },
    });
    const resultados: unknown[] = [];
    const admin = {
      iaArchivo: async () => ({ datos: Buffer.from('jpg'), tipo: 'image/jpeg' }),
      iaResultado: async (_id: number, c: unknown) => void resultados.push(c),
    } as unknown as AdminWa;
    await resolverIa({ id: 5, negocio_id: 2, tipo: 'factura', entrada: { media_id: 1, mime: 'image/jpeg' } }, { admin, gateway: h.deps.gateway, sesiones: h.sesiones });
    expect(resultados[0]).toMatchObject({ ok: true, salida: { es_factura: true, datos: { proveedor: 'Edesur', total: 48230 } } });
    // La sesión MCP se cierra al terminar: el agente no puede seguir mirando.
    expect(h.sesiones.enCurso()).toHaveLength(0);
  });
});
