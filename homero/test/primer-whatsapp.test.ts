import { describe, expect, it } from 'vitest';
import { entrarFormularioWeb, escribirPrimerWhatsapp, PLANTILLA_CONSULTA, primerNombre, temaDeLaConsulta, vigilarPlantilla } from '../src/primer-whatsapp.js';
import { recibirLeads } from '../src/whatsapp.js';
import { armar } from './armar.js';
import { waConPlantillas } from './wa-plantillas.js';

const LAURA = {
  nombre: 'Laura Pérez',
  negocio: 'Panadería Don Luis',
  whatsapp: '5491123456789',
  mail: 'laura@pan.com',
  tema: 'Stock que avisa',
  mensaje: 'Se nos vence la mercadería.',
  acepta_whatsapp: true,
  evento: 7,
};

function conBot(o: Parameters<typeof waConPlantillas>[0] = { estado: 'APPROVED' }) {
  const h = armar();
  const bot = waConPlantillas(o);
  return { h, bot, deps: { store: h.store, wa: bot.wa, avisar: h.deps.avisar } };
}

describe('el formulario de la web llega por el bot', () => {
  it('recibirLeads lo encola como tarea urgente formulario_web, con el id del evento, y confirma', async () => {
    const { h, bot } = conBot();
    bot.ponerEventos([{ id: 7, tipo: 'formulario', fecha: '2026-10-12T20:00:00Z', datos: { ...LAURA, evento: undefined } }]);
    await recibirLeads(bot.wa, h.store, h.deps.ahora);
    expect(h.store.tareas).toHaveLength(1);
    expect(h.store.tareas[0]).toMatchObject({ tipo: 'formulario_web', payload: { nombre: 'Laura Pérez', evento: 7 } });
    expect(bot.acks).toEqual([[7]]);
  });

  it('queda como lead caliente de la web y le escribe ya por WhatsApp con la plantilla', async () => {
    const { h, bot, deps } = conBot();
    await entrarFormularioWeb(LAURA, deps);
    expect(h.store.leads[0]).toMatchObject({
      nombre: 'Panadería Don Luis',
      fuente: 'web',
      estado: 'caliente',
      email: 'laura@pan.com',
      telefono: '5491123456789',
      investigacion: { contacto: 'Laura Pérez' },
    });
    expect(bot.avisos).toEqual([{ a: '5491123456789', plantilla: 'consulta_recibida', idioma: 'es_AR', variables: ['Laura', 'stock que avisa'] }]);
    expect(h.avisos.at(-1)).toContain('Consulta nueva desde la web');
    expect(h.avisos.at(-1)).toContain('✅ Le escribí por WhatsApp');
  });

  it('sin el tilde de WhatsApp no se le escribe; Gero se entera igual', async () => {
    const { h, bot, deps } = conBot();
    await entrarFormularioWeb({ ...LAURA, acepta_whatsapp: false }, deps);
    expect(bot.avisos).toEqual([]);
    expect(h.avisos.at(-1)).toContain('No tildó');
  });

  it('el mismo envío dos veces (el bot lo reentregó) no escribe ni avisa de nuevo', async () => {
    const { h, bot, deps } = conBot();
    await entrarFormularioWeb(LAURA, deps);
    await entrarFormularioWeb(LAURA, deps);
    expect(bot.avisos).toHaveLength(1);
    expect(h.avisos.filter((t) => t.includes('Consulta nueva desde la web'))).toHaveLength(1);
  });

  it('si la plantilla no existe la crea (UTILIDAD) y le avisa a Gero que todavía no salió', async () => {
    const { h, bot, deps } = conBot({});
    await entrarFormularioWeb(LAURA, deps);
    expect(bot.avisos).toEqual([]);
    expect(bot.creadas).toEqual([
      {
        nombre: 'consulta_recibida',
        idioma: 'es_AR',
        categoria: 'UTILITY',
        componentes: [{ type: 'BODY', text: PLANTILLA_CONSULTA.texto, example: { body_text: [['Laura', 'stock que avisa']] } }],
      },
    ]);
    expect(h.avisos.at(-1)).toContain('todavía no está aprobada');
    expect(h.avisos.at(-1)).toContain('https://wa.me/5491123456789');
  });

  it('sin la capacidad avisos lo dice claro', async () => {
    const { bot } = conBot({ sinPermiso: true });
    const r = await escribirPrimerWhatsapp(bot.wa, { a: '5491123456789', nombre: 'Ana' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toContain('capacidad avisos');
  });
});

describe('las variables de la plantilla', () => {
  it('primer nombre, con mayúscula; sin nombre, un saludo', () => {
    expect(primerNombre('maría josé pérez')).toBe('María');
    expect(primerNombre('  ')).toBe('qué tal');
    expect(primerNombre(undefined)).toBe('qué tal');
  });

  it('el tema en minúscula; "Otra cosa" o nada, el general', () => {
    expect(temaDeLaConsulta('Facturas que se cargan solas')).toBe('facturas que se cargan solas');
    expect(temaDeLaConsulta('Otra cosa')).toBe('lo que necesitás para tu negocio');
    expect(temaDeLaConsulta(undefined)).toBe('lo que necesitás para tu negocio');
  });
});

describe('la plantilla se registra sola', () => {
  it('apenas hay permiso la crea, y a Gero le cuenta cada cambio una sola vez', async () => {
    const { h, bot } = conBot({});
    const deps = { wa: bot.wa, store: h.store, avisar: h.deps.avisar };
    expect(await vigilarPlantilla(deps)).toBe('PENDING');
    expect(bot.creadas).toHaveLength(1);
    expect(await vigilarPlantilla(deps)).toBe('PENDING');
    expect(bot.creadas).toHaveLength(1);
    expect(h.avisos.filter((t) => t.includes('Está en revisión'))).toHaveLength(1);
    // Meta la aprueba.
    (await bot.wa.plantillas())[0]!.estado = 'APPROVED';
    expect(await vigilarPlantilla(deps)).toBe('APPROVED');
    expect(h.avisos.at(-1)).toContain('Meta aprobó la plantilla');
  });

  it('sin la capacidad avisos no crea nada ni avisa (vuelve a mirar en media hora)', async () => {
    const { h, bot } = conBot({ sinPermiso: true });
    expect(await vigilarPlantilla({ wa: bot.wa, store: h.store, avisar: h.deps.avisar })).toBe('sin_permiso');
    expect(bot.creadas).toEqual([]);
    expect(h.avisos).toEqual([]);
  });
});
