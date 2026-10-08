import { describe, expect, it } from 'vitest';
import { agentePublicitar, CorridaSinCerrar } from '../src/agentes.js';
import {
  aprobarAnuncio,
  cambiarPresupuesto,
  chequearReparto,
  escribirALeadMeta,
  estadoDelMes,
  leerInsights,
  leerLeadsDeMeta,
  linkDeWhatsapp,
  mesDe,
  pedirCambio,
  planificarAnuncios,
  proponerAnuncio,
  publicarAnuncio,
  repartirPresupuesto,
  resumenDeAnuncios,
  type Propuesta,
} from '../src/anuncios.js';
import { casillaPausada } from '../src/envio.js';
import { leerMonto } from '../src/telegram.js';
import { agenteDe, armar, casilla, type Opciones } from './armar.js';
import { metaFalsa } from './meta-falsa.js';

const PROPUESTA: Propuesta = {
  rubro: 'taller',
  titulo: 'Turnos sin perder ninguno',
  texto: 'Los turnos que hoy entran por WhatsApp quedan agendados solos. Menos llamadas, cero olvidos.',
  frase: '¿Cuántos turnos se te pierden por semana?',
  preguntas: ['¿Qué tarea les lleva más tiempo hoy?'],
  diario: 2000,
  porQue: 'Los talleres son el rubro que más responde a los mails.',
};

function conMeta(o: Opciones = {}) {
  const f = metaFalsa();
  return { ...armar({ ...o, meta: f.meta }), f };
}

/** Un anuncio ya publicado en Meta, con su diario. */
async function activo(h: ReturnType<typeof conMeta>, diario: number, n = 1) {
  const id = await h.store.crearAnuncio({ ...PROPUESTA, diario, imagen: Buffer.from('png') });
  await h.store.actualizarAnuncio(id, {
    estado: 'activo',
    metaIds: { imagen: `hash${n}`, formulario: `form${n}`, conjunto: `set${n}`, creativo: `cre${n}`, anuncio: `ad${n}` },
  });
  return id;
}

const gasto = (dia: string, anuncioId: number, pesos: number) => ({ dia, anuncioId, gasto: pesos, impresiones: 100, consultas: 1 });

describe('el mes', () => {
  it('cuenta los dias que faltan con hoy incluido, en hora argentina', () => {
    expect(mesDe(new Date('2026-09-29T17:00:00Z'))).toEqual({ primerDia: '2026-09-01', hoy: '2026-09-29', diasQueFaltan: 2 });
    // Las 23 del 31 en Argentina siguen siendo octubre.
    expect(mesDe(new Date('2026-11-01T02:00:00Z'))).toMatchObject({ primerDia: '2026-10-01', diasQueFaltan: 1 });
    expect(mesDe(new Date('2026-11-01T15:00:00Z'))).toMatchObject({ primerDia: '2026-11-01', diasQueFaltan: 30 });
  });

  it('al cambiar de mes, lo gastado el anterior no cuenta', async () => {
    const h = conMeta({ ahora: new Date('2026-10-01T15:00:00Z') });
    const id = await activo(h, 1000);
    await h.store.guardarGastos([gasto('2026-09-30', id, 49_000), gasto('2026-10-01', id, 300)]);
    const m = await estadoDelMes(h.deps);
    expect(m).toMatchObject({ presupuesto: 50_000, gastado: 300, gastadoHoy: 300, diarios: 1000, diasQueFaltan: 31 });
    expect(m.diarioQueEntra).toBe(Math.floor(49_700 / 31));
  });
});

describe('el tope de plata', () => {
  it('rechaza un reparto que no entra en el mes y dice cuánto entra', async () => {
    const h = conMeta(); // martes 29/9: faltan 2 dias
    const a = await activo(h, 2000, 1);
    const b = await activo(h, 2000, 2);
    await h.store.guardarGastos([gasto('2026-09-10', a, 30_000), gasto('2026-08-31', a, 99_999)]);

    // 30.000 + (6.000 + 5.000) × 2 = 52.000 > 50.000
    const r = await repartirPresupuesto([{ anuncioId: a, diario: 6000 }, { anuncioId: b, diario: 5000 }], h.deps);
    expect(r).toMatchObject({ ok: false, entra: 10_000 });
    if (!r.ok) expect(r.motivo).toContain('$10.000');
    expect(h.f.de('cambiarDiario')).toHaveLength(0);
    expect((await h.store.anuncio(a))!.diario).toBe(2000);

    // 30.000 + 10.000 × 2 = 50.000: entra justo.
    expect(await repartirPresupuesto([{ anuncioId: a, diario: 6000 }, { anuncioId: b, diario: 4000 }], h.deps)).toEqual({ ok: true });
    expect(h.f.de('cambiarDiario').map((l) => l.args)).toEqual([
      ['set1', 6000],
      ['set2', 4000],
    ]);
  });

  it('bajar siempre se puede, aunque el mes ya venga pasado', () => {
    const m = { presupuesto: 50_000, gastado: 46_000, gastadoHoy: 0, diarios: 6000, diasQueFaltan: 5, comprometido: 76_000, diarioQueEntra: 800 };
    expect(chequearReparto(m, new Map([[1, 3000]]), new Map([[1, 6000]]))).toEqual({ ok: true });
    expect(chequearReparto(m, new Map([[1, 7000]]), new Map([[1, 6000]]))).toMatchObject({ ok: false });
  });

  it('bajar uno y subir otro (o prender uno pausado) con el mes pasado no se puede', () => {
    const m = { presupuesto: 50_000, gastado: 46_000, gastadoHoy: 0, diarios: 6000, diasQueFaltan: 5, comprometido: 76_000, diarioQueEntra: 800 };
    const antes = new Map([
      [1, 4000],
      [2, 2000],
    ]);
    // Mismo total, pero el 2 sube.
    expect(chequearReparto(m, new Map([[1, 2000], [2, 4000]]), antes)).toMatchObject({ ok: false });
    // Mismo total, pero el 3 (pausado, no estaba en `antes`) se prende.
    expect(chequearReparto(m, new Map([[1, 2000], [3, 2000], [2, 2000]]), antes)).toMatchObject({ ok: false });
  });

  it('al 90% del mes pausa todo, avisa una sola vez y no deja volver a subir', async () => {
    const h = conMeta();
    const a = await activo(h, 2000, 1);
    const b = await activo(h, 2000, 2);
    h.f.datos.insights = [{ anuncio: 'ad1', dia: '2026-09-28', gasto: 44_900, impresiones: 9000, consultas: 12 }];
    await leerInsights(h.deps);
    // 44.900 es el 89,8%: sigue andando.
    expect(h.f.de('cambiarEstado')).toHaveLength(0);
    expect(await h.store.gastos('2026-09-01')).toEqual([{ dia: '2026-09-28', anuncioId: a, gasto: 44_900, impresiones: 9000, consultas: 12 }]);

    h.f.datos.insights = [{ anuncio: 'ad1', dia: '2026-09-28', gasto: 45_000, impresiones: 9000, consultas: 12 }];
    await leerInsights(h.deps);
    expect(h.f.de('cambiarEstado').map((l) => l.args)).toEqual([
      ['set2', 'PAUSED'],
      ['set1', 'PAUSED'],
    ]);
    expect((await h.store.anuncio(a))!.estado).toBe('pausado');
    expect((await h.store.anuncio(b))!.estado).toBe('pausado');
    expect(h.avisos.filter((t) => t.startsWith('🛑'))).toHaveLength(1);

    await leerInsights(h.deps);
    expect(h.avisos.filter((t) => t.startsWith('🛑'))).toHaveLength(1);
    const r = await repartirPresupuesto([{ anuncioId: a, diario: 1000 }], h.deps);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.motivo).toContain('solo se puede bajar o pausar');
  });

  it('aprobar con el diario que propuso, o con lo que entra, o nada si no entra el mínimo', async () => {
    const h = conMeta();
    const otro = await activo(h, 1000);
    const id = await proponerAnuncio({ ...PROPUESTA, diario: 3000 }, h.deps);
    // Gastado 45.000 de 50.000 y el otro anuncio a 1.000 × 2 dias: entra 1.500 por dia para este.
    await h.store.guardarGastos([gasto('2026-09-10', otro, 44_000)]);
    const r = await aprobarAnuncio(id, h.deps);
    expect(r).toMatchObject({ ok: true, anuncio: { estado: 'aprobado', diario: 2000 } });

    const id2 = await proponerAnuncio(PROPUESTA, h.deps);
    const r2 = await aprobarAnuncio(id2, h.deps);
    expect(r2).toMatchObject({ ok: false });
    if (!r2.ok) expect(r2.motivo).toContain('no entra');
    expect((await h.store.anuncio(id2))!.estado).toBe('propuesto');
  });

  it('/presupuesto recuerda subir el límite de la cuenta en Meta, y si queda chico pausa ya', async () => {
    const h = conMeta();
    h.f.datos.limite = 50_000;
    expect((await cambiarPresupuesto(80_000, h.deps)).aviso).toContain('límite de gasto de $50.000');
    expect((await cambiarPresupuesto(30_000, h.deps)).aviso).toBeUndefined();

    const a = await activo(h, 1000);
    await h.store.guardarGastos([gasto('2026-09-10', a, 28_000)]);
    const r = await cambiarPresupuesto(30_000, h.deps);
    expect(r.pausados).toBe(1);
    expect(await h.store.leerEstado('presupuesto_mes')).toBe(30_000);
  });

  it('leerMonto entiende como lo escribe Gero', () => {
    expect(leerMonto('80000')).toBe(80_000);
    expect(leerMonto('80.000')).toBe(80_000);
    expect(leerMonto('$80.000')).toBe(80_000);
    expect(leerMonto('ochenta')).toBeUndefined();
    expect(leerMonto('0')).toBeUndefined();
  });
});

describe('nada se crea en Meta sin aprobación', () => {
  it('el publicista propone: imagen, tarjeta con botones y ni una llamada a Meta', async () => {
    const h = conMeta({
      agente: agenteDe({
        publicista: async (usar, p) => {
          expect(p.herramientas).toEqual(['ver_resultados', 'proponer_anuncio', 'repartir_presupuesto', 'pausar_anuncio', 'escribir_libreta']);
          expect((await usar('ver_resultados')).texto).toContain('Presupuesto del mes: $50.000');
          const r = await usar('proponer_anuncio', {
            rubro: PROPUESTA.rubro,
            titulo: PROPUESTA.titulo,
            texto: PROPUESTA.texto,
            frase_imagen: PROPUESTA.frase,
            preguntas: PROPUESTA.preguntas,
            diario: PROPUESTA.diario,
            por_que: PROPUESTA.porQue,
          });
          expect(r).toEqual({ texto: 'Listo: el anuncio #1 le llegó a Gero para aprobar.', error: false });
          // Un link no pasa.
          const link = await usar('proponer_anuncio', {
            rubro: 'taller',
            titulo: 'Mirá www.sincroresto.com',
            texto: PROPUESTA.texto,
            frase_imagen: PROPUESTA.frase,
            preguntas: [],
            diario: 2000,
            por_que: PROPUESTA.porQue,
          });
          expect(link.error).toBe(true);
          // Repartir sobre uno que Gero no aprobo, tampoco.
          expect((await usar('repartir_presupuesto', { anuncios: [{ id: 1, diario: 3000 }] })).texto).toContain('no está aprobado');
        },
      }),
    });
    await agentePublicitar({}, h.deps);

    expect(h.f.llamadas).toEqual([]);
    expect(await h.store.anuncio(1)).toMatchObject({ estado: 'propuesto', diario: 2000, preguntas: PROPUESTA.preguntas });
    expect(h.fotos).toHaveLength(1);
    expect(h.fotos[0]!.png.subarray(1, 4).toString()).toBe('PNG');
    expect(h.tarjetas.at(-1)!.datos).toEqual(['aa:1', 'ac:1', 'ad:1']);
    expect(h.tarjetas.at(-1)!.texto).toContain('¿Qué tarea les lleva más tiempo hoy?');
    expect(h.store.corridasGuardadas.at(-1)).toMatchObject({ agente: 'publicista', estado: 'lista' });
    expect(h.store.corridasGuardadas.at(-1)!.resumen).toContain('Propuso el anuncio #1');
  });

  it('al aprobar se encola la publicación, y recién ahí se crea todo en Meta', async () => {
    const h = conMeta();
    const id = await proponerAnuncio(PROPUESTA, h.deps);
    expect(await aprobarAnuncio(id, h.deps)).toMatchObject({ ok: true });
    expect(h.f.llamadas).toEqual([]);
    expect(h.store.tareas.map((t) => t.tipo)).toEqual(['publicar_anuncio', 'agente_publicitar']);

    await publicarAnuncio({ anuncioId: id }, h.deps);
    expect(h.f.llamadas.map((l) => l.metodo)).toEqual([
      'crearCampana',
      'subirImagen',
      'crearFormulario',
      'buscarIntereses',
      'buscarIntereses',
      'crearConjunto',
      'crearCreativo',
      'crearAnuncio',
    ]);
    expect(h.f.de('crearFormulario')[0]!.args[0]).toMatchObject({
      privacidad: 'https://www.sincroresto.com/privacidad',
      web: 'https://www.sincroresto.com',
      preguntas: [
        { tipo: 'FULL_NAME' },
        { tipo: 'EMAIL' },
        { tipo: 'PHONE' },
        { tipo: 'COMPANY_NAME' },
        { tipo: 'CUSTOM', clave: 'p1', texto: '¿Qué tarea les lleva más tiempo hoy?' },
      ],
    });
    expect(h.f.de('crearConjunto')[0]!.args[0]).toMatchObject({ diario: 2000 });
    expect(await h.store.anuncio(id)).toMatchObject({ estado: 'activo', metaIds: { anuncio: 'ad8', conjunto: 'set6' } });
    expect(h.avisos.at(-1)).toContain('Publiqué el anuncio #1');

    // Otra vez no hace nada: ya esta activo.
    await publicarAnuncio({ anuncioId: id }, h.deps);
    expect(h.f.llamadas).toHaveLength(8);
  });

  it('si Meta falla a mitad, el reintento sigue desde ahí sin duplicar', async () => {
    const h = conMeta();
    const id = await proponerAnuncio(PROPUESTA, h.deps);
    await aprobarAnuncio(id, h.deps);
    h.f.datos.fallar = 'crearCreativo';
    await expect(publicarAnuncio({ anuncioId: id }, h.deps)).rejects.toThrow('falló crearCreativo');
    await publicarAnuncio({ anuncioId: id }, h.deps);
    for (const m of ['crearCampana', 'subirImagen', 'crearFormulario', 'crearConjunto', 'crearAnuncio']) {
      expect(h.f.de(m)).toHaveLength(1);
    }
    expect(h.f.de('crearCreativo')).toHaveLength(2);
    expect((await h.store.anuncio(id))!.estado).toBe('activo');
  });

  it('✏️ Cambiar descarta el propuesto y el publicista lo rehace con lo que pidió Gero', async () => {
    const h = conMeta({
      agente: agenteDe({
        publicista: async (usar, p) => {
          expect(p.objetivo).toContain('más corto, y para contables');
          expect(p.herramientas).not.toContain('repartir_presupuesto');
          await usar('proponer_anuncio', {
            rubro: 'contable',
            titulo: 'Facturas que se cargan solas',
            texto: 'Tus clientes mandan la factura por WhatsApp y queda cargada.',
            frase_imagen: '¿Seguís cargando facturas a mano?',
            preguntas: [],
            diario: 2000,
            por_que: 'Lo pidió Gero: más corto y para contables.',
          });
        },
      }),
    });
    const id = await proponerAnuncio(PROPUESTA, h.deps);
    expect(await pedirCambio(id, 'más corto, y para contables', h.deps)).toMatchObject({ ok: true });
    expect(await h.store.anuncio(id)).toMatchObject({ estado: 'descartado', motivo: 'Gero pidió cambiar: más corto, y para contables' });
    const tarea = h.store.tareas.find((t) => t.tipo === 'agente_publicitar')!;
    await agentePublicitar(tarea.payload, h.deps);
    expect(await h.store.anuncio(2)).toMatchObject({ estado: 'propuesto', rubro: 'contable' });
    expect(h.f.llamadas).toEqual([]);
  });

  it('una corrida de cambio que no propone nada queda fallida', async () => {
    const h = conMeta({ agente: agenteDe({ publicista: async () => {} }) });
    const id = await proponerAnuncio(PROPUESTA, h.deps);
    await pedirCambio(id, 'otro color', h.deps);
    const tarea = h.store.tareas.find((t) => t.tipo === 'agente_publicitar')!;
    await expect(agentePublicitar(tarea.payload, h.deps)).rejects.toBeInstanceOf(CorridaSinCerrar);
  });

  it('sin Meta configurado, ni se aprueba ni corre el publicista', async () => {
    const h = armar({ agente: async () => ({}) });
    const id = await proponerAnuncio(PROPUESTA, h.deps);
    expect(await aprobarAnuncio(id, h.deps)).toMatchObject({ ok: false, motivo: expect.stringContaining('META_TOKEN') });
    await agentePublicitar({}, h.deps);
    expect(h.corridas).toHaveLength(0);
    await planificarAnuncios(h.deps);
    expect(h.store.tareas).toHaveLength(0);
  });
});

describe('las consultas que entran', () => {
  const lead = (id: string, campos: Record<string, string>) => ({ id, creado: new Date(), formulario: 'form1', anuncio: 'ad1', campos });

  it('entra caliente, avisa con WhatsApp y encola el mail; el mismo lead no entra dos veces', async () => {
    const h = conMeta();
    const a = await activo(h, 2000);
    h.f.datos.leads.set('form1', [
      lead('L1', {
        full_name: 'Ana Gómez',
        email: 'Ana@TallerGomez.com',
        phone_number: '+5491122334455',
        company_name: 'Taller Gómez',
        p1: 'Los turnos',
      }),
    ]);
    expect(await leerLeadsDeMeta(h.deps)).toBe(1);
    expect(h.store.leads[0]).toMatchObject({
      nombre: 'Taller Gómez',
      fuente: 'meta',
      estado: 'caliente',
      email: 'ana@tallergomez.com',
      anuncioId: a,
      investigacion: { contacto: 'Ana Gómez', formulario: [{ pregunta: '¿Qué tarea les lleva más tiempo hoy?', respuesta: 'Los turnos' }] },
    });
    expect(h.avisos.at(-1)).toContain('https://wa.me/5491122334455');
    expect(h.avisos.at(-1)).toContain('Los turnos');
    expect(h.store.tareas.map((t) => t.tipo)).toEqual(['escribir_a_lead_meta']);

    expect(await leerLeadsDeMeta(h.deps)).toBe(0);
    expect(h.store.leads).toHaveLength(1);
    expect(h.store.tareas).toHaveLength(1);
  });

  it('si ya estaba en la base por mail no se duplica; por teléfono no se junta con otro', async () => {
    const h = conMeta();
    await activo(h, 2000);
    const porMail = (await h.store.crearLead({ nombre: 'Estudio Pérez', rubro: 'contable', ciudad: 'Rosario', email: 'juan@perez.com', fuente: 'osm' }))!;
    const porTel = (await h.store.crearLead({ nombre: 'Ferretería Sol', rubro: 'ferreteria', ciudad: 'Tigre', email: 'sol@ferreteria.com', telefono: '011 4455-6677', fuente: 'google' }))!;
    h.f.datos.leads.set('form1', [
      lead('L2', { full_name: 'Juan Pérez', email: 'JUAN@perez.com' }),
      // Mismo teléfono que la ferretería y otro mail: es otro contacto, y el
      // mail automático le va a él, nunca a sol@ferreteria.com.
      lead('L3', { full_name: 'Otro', email: 'otro@gmail.com', phone_number: '+54 9 11 4455-6677' }),
    ]);
    expect(await leerLeadsDeMeta(h.deps)).toBe(2);
    expect(h.store.leads).toHaveLength(3);
    expect(await h.store.lead(porMail)).toMatchObject({ estado: 'caliente', anuncioId: 1 });
    expect(await h.store.lead(porTel)).toMatchObject({ estado: 'nuevo', email: 'sol@ferreteria.com' });
    expect(h.avisos.filter((t) => t.includes('ya estaba en la base'))).toHaveLength(1);
    expect(h.store.tareas.map((t) => t.payload)).toEqual([{ leadId: porMail }, { leadId: 3 }]);
  });

  it('un formulario no hace volver atrás a un lead que ya respondió o pidió la baja', async () => {
    const h = conMeta();
    await activo(h, 2000);
    const id = (await h.store.crearLead({ nombre: 'Estudio Pérez', rubro: 'contable', ciudad: 'Rosario', email: 'juan@perez.com', fuente: 'osm' }))!;
    await h.store.actualizarLead(id, { estado: 'reunion' });
    h.f.datos.leads.set('form1', [lead('L9', { full_name: 'Juan Pérez', email: 'juan@perez.com' })]);
    expect(await leerLeadsDeMeta(h.deps)).toBe(1);
    expect(await h.store.lead(id)).toMatchObject({ estado: 'reunion', anuncioId: 1 });
  });

  it('el link de WhatsApp sale de como venga el teléfono', () => {
    expect(linkDeWhatsapp('+54 9 11 2233-4455')).toBe('https://wa.me/5491122334455');
    expect(linkDeWhatsapp('011 2233-4455')).toBe('https://wa.me/5491122334455');
    expect(linkDeWhatsapp('+54 11 2233 4455')).toBe('https://wa.me/5491122334455');
    expect(linkDeWhatsapp('123')).toBeUndefined();
    expect(linkDeWhatsapp(undefined)).toBeUndefined();
  });
});

describe('el mail a quien llenó el formulario', () => {
  // Domingo 3 de la mañana en Argentina, y la casilla ya mandó su cupo de hoy.
  const domingo = new Date('2026-10-04T06:00:00Z');

  async function conLead(o: Opciones = {}) {
    const h = conMeta({ ahora: domingo, ...o });
    await activo(h, 2000);
    h.f.datos.leads.set('form1', [
      { id: 'L1', creado: domingo, formulario: 'form1', campos: { full_name: 'Ana Gómez', email: 'ana@taller.com', company_name: 'Taller Gómez', p1: 'Los turnos' } },
    ]);
    await leerLeadsDeMeta(h.deps);
    for (let i = 0; i < 5; i++) await h.store.registrarEnvio({ cuenta: casilla.email, para: `x${i}@x.com`, asunto: 'a' });
    return h;
  }

  it('sale ya, sin horario ni cupo, con tres horarios; sin IA, el mail fijo', async () => {
    const h = await conLead();
    expect(await escribirALeadMeta({ leadId: 1 }, h.deps)).toBeUndefined();
    expect(h.enviados).toHaveLength(1);
    const m = h.enviados[0]!;
    expect(m).toMatchObject({ para: 'ana@taller.com', asunto: 'Tu consulta en Sincro' });
    expect(m.texto).toMatch(/^Hola Ana,/);
    expect(m.texto.match(/^- /gm)).toHaveLength(3);
    expect(m.texto.endsWith('Gero')).toBe(true);
    expect(await h.store.oferta(1)).toHaveLength(3);
    expect((await h.store.salientesDeLead(1))[0]).toMatchObject({ tipo: 'inicial', estado: 'enviado', messageId: '<m1@x>' });
    expect(h.avisos.at(-1)).toContain('mail fijo');
  });

  it('con IA, lo escribe la IA con lo que contestó y la firma de Gero', async () => {
    const h = await conLead({ pedirIa: async () => 'Hola Ana, gracias por escribirnos. Lo de los turnos lo resolvemos seguido: ¿charlamos el lunes?' });
    await escribirALeadMeta({ leadId: 1 }, h.deps);
    expect(h.prompts[0]).toContain('Los turnos');
    expect(h.prompts[0]).toContain('<no_confiable>');
    expect(h.enviados[0]!.texto).toBe('Hola Ana, gracias por escribirnos. Lo de los turnos lo resolvemos seguido: ¿charlamos el lunes?\n\nGero');
  });

  it('respeta las bajas y las casillas frenadas', async () => {
    const h = await conLead();
    await h.store.agregarBaja('ana@taller.com');
    await escribirALeadMeta({ leadId: 1 }, h.deps);
    expect(h.enviados).toHaveLength(0);
    expect(h.avisos.at(-1)).toContain('pidió la baja');

    const h2 = await conLead();
    const hasta = new Date(domingo.getTime() + 3_600_000);
    await h2.store.guardarEstado(casillaPausada(casilla.email), { hasta: hasta.toISOString() });
    expect(await escribirALeadMeta({ leadId: 1 }, h2.deps)).toEqual({ reprogramarPara: hasta });
    expect(h2.enviados).toHaveLength(0);
  });

  it('en ensayo le llega a Gero, no al lead', async () => {
    const h = await conLead({ ensayo: true });
    await escribirALeadMeta({ leadId: 1 }, h.deps);
    expect(h.enviados[0]).toMatchObject({ para: 'gero@personal.com', asunto: '[ENSAYO] Tu consulta en Sincro' });
    expect(await h.store.salientesDeLead(1)).toEqual([]);
  });
});

describe('resumen y planificador', () => {
  it('el resumen de las 20: gasto contra presupuesto, consultas, costo, reuniones y el mejor', async () => {
    const h = conMeta();
    const a = await activo(h, 2000, 1);
    const b = await activo(h, 1000, 2);
    await h.store.actualizarAnuncio(a, { estado: 'activo' });
    await h.store.guardarGastos([gasto('2026-09-28', a, 5000), gasto('2026-09-29', a, 1000), gasto('2026-09-29', b, 2000)]);
    h.f.datos.leads.set('form1', [
      { id: 'L1', creado: new Date(), formulario: 'form1', campos: { full_name: 'Ana', email: 'ana@x.com' } },
      { id: 'L2', creado: new Date(), formulario: 'form1', campos: { full_name: 'Beto', email: 'beto@x.com' } },
    ]);
    await leerLeadsDeMeta(h.deps);
    await h.store.crearReunion({ leadId: 1, inicio: new Date('2026-10-01T18:00:00Z'), fin: new Date('2026-10-01T18:30:00Z'), link: 'x' });
    await resumenDeAnuncios(h.deps);
    expect(h.avisos.at(-1)).toBe(
      [
        '📣 Anuncios hoy',
        'Gasto hoy: $3.000 · Mes: $8.000 de $50.000 (16%)',
        'Consultas hoy: 2 · Mes: 2 · $4.000 cada una',
        'Reuniones que salieron de anuncios este mes: 1',
        'Diarios andando: $3.000 por día · el mes cerraría en $14.000',
        'Mejor anuncio: #1 Turnos sin perder ninguno (2 consultas, $3.000 cada una)',
      ].join('\n'),
    );
  });

  it('sin anuncios aprobados no manda resumen', async () => {
    const h = conMeta();
    await proponerAnuncio(PROPUESTA, h.deps);
    await resumenDeAnuncios(h.deps);
    expect(h.avisos).toEqual([]);
  });

  it('insights cada hora, el publicista a las 10 y el resumen a las 20, una vez cada uno', async () => {
    const h = conMeta({ ahora: new Date('2026-09-29T12:30:00Z') }); // 9:30
    await planificarAnuncios(h.deps);
    await planificarAnuncios(h.deps);
    expect(h.store.tareas.map((t) => t.tipo)).toEqual(['leer_insights']);
    h.mover(new Date('2026-09-29T13:05:00Z')); // 10:05
    await planificarAnuncios(h.deps);
    expect(h.store.tareas.map((t) => t.tipo)).toEqual(['leer_insights', 'leer_insights', 'agente_publicitar']);
    h.mover(new Date('2026-09-29T23:10:00Z')); // 20:10
    await planificarAnuncios(h.deps);
    await planificarAnuncios(h.deps);
    expect(h.store.tareas.map((t) => t.tipo)).toEqual([
      'leer_insights',
      'leer_insights',
      'agente_publicitar',
      'leer_insights',
      'resumen_anuncios',
    ]);
  });
});
