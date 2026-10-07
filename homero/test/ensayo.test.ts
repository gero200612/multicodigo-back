import { describe, expect, it } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import { cortarBusquedas } from '../src/comandos.js';
import { linkDeFicha } from '../src/fuentes.js';
import type { Recibido } from '../src/store.js';
import {
  apagarEnsayo,
  aprobarLead,
  aprobarSaliente,
  ENSAYO,
  ensayoActivo,
  mandarMuestras,
  reproponerBorradores,
  proponerPrioridad,
  lugaresHoy,
} from '../src/ventas.js';
import { agenteDe, armar, type Guion } from './armar.js';

const mail = {
  email: 'info@estudiox.com.ar',
  asunto: 'facturas del estudio',
  mensaje:
    'Hola, soy Geronimo Enrici de Sincro. Vi que son un estudio contable con varios clientes y me imagino que la carga de facturas les lleva bastante tiempo. ¿Charlamos 15 minutos?\nGero',
  seguimiento: 'Te escribo de nuevo, ¿lo vemos o lo dejamos para más adelante?\nGero',
  resumen_empresa: 'Estudio contable en Rosario',
  dolor: 'carga de facturas',
  idea: 'bot de facturas por WhatsApp',
  factibilidad: 8,
  factibilidad_motivo: 'proceso manual claro',
  fuentes: ['https://estudiox.com.ar', 'https://estudiox.com.ar/contacto'],
};

/**
 * Un borrador hecho por los agentes, con el ensayo prendido. `guion.atencion`
 * se cambia en cada paso de un test: es lo que "piensa" atencion esa vez.
 */
async function conUnBorrador() {
  const guion: Guion = {
    buscador: async (usar) => {
      await usar('anotar_negocio', {
        nombre: 'Estudio X',
        rubro: 'contable',
        zona: 'Rosario',
        web: 'https://estudiox.com.ar',
        por_que: 'Estudio con muchos clientes y carga manual',
      });
    },
    vendedor: async (usar) => {
      const r = await usar('dejar_mail_listo', mail);
      expect(r.error).toBe(false);
    },
  };
  const h = armar({ ensayo: true, agente: agenteDe(guion) });
  await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 1 }, requiereIa: true });
  for (let i = 0; i < 10 && (await correrSiguiente(h.deps)); i++);
  return { ...h, guion };
}

describe('modo ensayo', () => {
  it('arranca prendido hacia el mail de Gero', async () => {
    const h = armar({ ensayo: true });
    expect(await ensayoActivo(h.deps)).toBe('gero@personal.com');
    await h.store.guardarEstado(ENSAYO, { apagado: true });
    expect(await ensayoActivo(h.deps)).toBeUndefined();
  });

  it('al mail le llega el mail tal cual y a Telegram la informacion, y nada al cliente', async () => {
    const h = await conUnBorrador();
    const { enviados, store } = h;
    expect(enviados).toHaveLength(1);
    const m = enviados[0]!;
    expect(m.para).toBe('gero@personal.com');
    // Al mail, exactamente lo que recibiria el cliente.
    expect(m.asunto).toBe('facturas del estudio');
    expect(m.texto).toBe(mail.mensaje);
    // Y la informacion, por Telegram.
    const tarjeta = h.tarjetas[0]!.texto;
    expect(tarjeta).toContain('Factibilidad: 8/10');
    expect(tarjeta).toContain('https://estudiox.com.ar/contacto');
    expect(tarjeta).toContain('lo dejamos para más adelante');
    // Cuenta para el cupo de la casilla (cuida que no caiga en spam) y no
    // cambia al lead.
    expect(store.envios).toHaveLength(1);
    expect(store.leads[0]!.estado).toBe('borrador');
  });

  it('pasado el cupo de la casilla no manda mas muestras por mail: quedan en Telegram', async () => {
    const h = await conUnBorrador();
    // Llena el cupo del dia (5 para una casilla nueva).
    for (let i = 0; i < 5; i++) await h.store.registrarEnvio({ cuenta: 'sincro.ventas@gmail.com', para: 'x@x.com', asunto: 'a' });
    const antes = h.enviados.length;
    expect(await mandarMuestras('gero@personal.com', h.deps)).toBe(0);
    expect(h.enviados).toHaveLength(antes);
  });

  it('al apagar el ensayo los borradores pendientes vuelven con el boton de Aprobar', async () => {
    const h = await conUnBorrador();
    expect(h.tarjetas.at(-1)!.datos).toEqual(['de:1']);
    await apagarEnsayo(h.deps);
    expect(await reproponerBorradores(h.deps)).toBe(1);
    const nueva = h.tarjetas.at(-1)!;
    expect(nueva.datos).toEqual(['ap:1', 'de:1']);
    expect(nueva.texto).toContain('Factibilidad: 8/10');
    expect(nueva.texto).toContain('respondé a este mensaje');
    // Y ahora Aprobar si programa el envio.
    expect(await aprobarLead(1, h.deps)).toBe(true);
  });

  it('/prioridad pasa primero los de mayor factibilidad y aprobar descuenta lugares del dia', async () => {
    const h = armar();
    const factibilidades = [6, 9, 7];
    for (const [i, fact] of factibilidades.entries()) {
      const id = (await h.store.crearLead({ nombre: `N${i}`, rubro: 'contable', ciudad: 'X', fuente: 'osm', email: `n${i}@x.com` }))!;
      await h.store.actualizarLead(id, {
        estado: 'borrador',
        investigacion: { resumen_empresa: 'r', dolor: 'd', idea: 'i', factibilidad: fact },
      });
      await h.store.crearSaliente({ leadId: id, tipo: 'inicial', paso: 0, asunto: 'a', cuerpo: 'c' });
    }
    expect(await proponerPrioridad(h.deps, 2)).toBe(2);
    expect(h.tarjetas.map((t) => t.datos[0])).toEqual(['ap:2', 'ap:3']);

    expect((await lugaresHoy(h.deps)).quedan).toBe(5);
    await aprobarLead(2, h.deps);
    expect((await lugaresHoy(h.deps)).quedan).toBe(4);
  });

  it('/cortar cancela las busquedas y los vendedores pendientes (tambien los del guion viejo)', async () => {
    const h = armar({ ensayo: true });
    await h.store.encolar({ tipo: 'agente_buscar', payload: { cantidad: 3 }, requiereIa: true });
    await h.store.encolar({ tipo: 'agente_vender', payload: { leadId: 9 }, requiereIa: true });
    await h.store.encolar({ tipo: 'prospectar', payload: { cantidad: 3 }, requiereIa: false });
    await h.store.encolar({ tipo: 'resumen_diario', payload: {}, requiereIa: false });
    expect(await cortarBusquedas(h.store)).toBe(3);
    expect(h.store.tareas.map((t) => t.estado)).toEqual(['fallida', 'fallida', 'fallida', 'pendiente']);
  });

  it('la tarjeta no tiene boton de aprobar y aprobar igual no hace nada', async () => {
    const h = await conUnBorrador();
    expect(h.tarjetas[0]!.datos).toEqual(['de:1']);
    expect(h.tarjetas[0]!.texto).toContain('De dónde saqué la info');
    expect(await aprobarLead(1, h.deps)).toBe(false);
    expect(h.store.tareas.some((t) => t.tipo === 'enviar_saliente')).toBe(false);
  });

  it('/ensayo reenvia las muestras de los borradores que ya estaban', async () => {
    const h = await conUnBorrador();
    expect(await mandarMuestras('gero200612@gmail.com', h.deps)).toBe(1);
    expect(h.enviados.at(-1)!.para).toBe('gero200612@gmail.com');
  });

  it('respondiendo la muestra se prueba el circuito entero, y todo le llega a Gero', async () => {
    const h = await conUnBorrador();
    const vaciar = async () => {
      for (let i = 0; i < 20 && (await correrSiguiente(h.deps)); i++);
    };
    const deGero = (cuerpo: string, enRespuestaA: string): Recibido => ({
      cuenta: 'sincro.ventas@gmail.com',
      messageId: `<g${Math.random()}@gmail>`,
      de: 'Geronimo <gero@personal.com>',
      asunto: 'Re: [ENSAYO] facturas del estudio',
      cuerpo,
      recibidoEn: new Date(),
      enRespuestaA,
    });

    // 1. Gero contesta la muestra como si fuera el estudio, y atencion arma la
    //    respuesta con horarios: le llega a Gero ya escrita, con Enviar.
    let hilo = '';
    h.guion.atencion = async (usar, p) => {
      expect(p.objetivo).toContain('ensayo');
      hilo = (await usar('ver_hilo')).texto;
      await usar('proponer_respuesta', { texto: 'Hola, ¿te sirve el miércoles a las 15 o el jueves a las 12:30?\nGero', horarios: [1, 2] });
    };
    await h.store.encolar({ tipo: 'agente_atender', payload: deGero('Me interesa, contame', '<m1@x>'), requiereIa: true });
    await vaciar();
    expect(hilo).toContain('Estudio contable en Rosario');
    expect(hilo).toContain('Me interesa, contame');
    const propuesta = h.tarjetas.at(-1)!;
    expect(propuesta.texto).toContain('🧪 ENSAYO');
    expect(propuesta.texto).toContain('Respuesta para Estudio X');
    expect(propuesta.datos).toEqual([expect.stringMatching(/^en:/), expect.stringMatching(/^no:/)]);
    // El negocio real no cambia de estado ni recibe el mail de Gero, y nada
    // le sale al cliente.
    expect(h.store.leads[0]).toMatchObject({ estado: 'borrador', email: 'info@estudiox.com.ar' });
    expect(h.enviados.every((m) => m.para === 'gero@personal.com')).toBe(true);

    // 2. Gero toca Enviar: la respuesta le llega a el, no al estudio.
    await aprobarSaliente(Number(propuesta.datos[0]!.slice(3)), h.deps);
    await vaciar();
    const resp = h.enviados.at(-1)!;
    expect(resp.para).toBe('gero@personal.com');
    expect(resp.asunto).toBe('Re: [ENSAYO] facturas del estudio');
    const idDeLaRespuesta = h.store.salientes.find((s) => s.tipo === 'respuesta')!.messageId!;

    // 3. Gero elige el horario: reserva, y la confirmacion con la invitacion le llega a el.
    h.guion.atencion = async (usar) => {
      expect((await usar('confirmar_horario', { horario: 1 })).error).toBe(false);
    };
    await h.store.encolar({ tipo: 'agente_atender', payload: deGero('Dale, el miércoles', idDeLaRespuesta), requiereIa: true });
    await vaciar();
    expect(h.tarjetas.at(-1)!.texto).toContain('🧪 ENSAYO · 📅 ELIGIÓ HORARIO');
    await aprobarSaliente(Number(h.tarjetas.at(-1)!.datos[0]!.slice(3)), h.deps);
    await vaciar();
    const conf = h.enviados.at(-1)!;
    expect(conf.para).toBe('gero@personal.com');
    expect(conf.ics).toContain('mailto:gero@personal.com');
    expect(conf.ics).not.toContain('info@estudiox.com.ar');
    expect(h.store.leads[0]!.estado).toBe('borrador');
    expect(h.enviados.some((m) => m.para === 'info@estudiox.com.ar')).toBe(false);

    // 4. Al apagar el ensayo, el horario de prueba se libera.
    expect(await apagarEnsayo(h.deps)).toBe(1);
    expect(await h.store.reunionesDesde(new Date(0))).toHaveLength(0);
  });

  it('en ensayo, un mail de Gero que no responde a una muestra no lanza a atencion', async () => {
    const h = await conUnBorrador();
    const corridasAntes = h.corridas.length;
    await h.store.encolar({
      tipo: 'agente_atender',
      payload: { cuenta: 'sincro.ventas@gmail.com', messageId: '<suelto@gmail>', de: 'gero@personal.com', asunto: 'hola', cuerpo: 'hola', recibidoEn: new Date() },
      requiereIa: true,
    });
    for (let i = 0; i < 5 && (await correrSiguiente(h.deps)); i++);
    expect(h.corridas).toHaveLength(corridasAntes);
    expect(h.avisos.at(-1)).toContain('no respondiendo a una muestra');
  });

  it('el link de la ficha sale para OSM y para Google', () => {
    expect(linkDeFicha('osm:way/7')).toBe('https://www.openstreetmap.org/way/7');
    expect(linkDeFicha('google:ChIJabc')).toBe('https://www.google.com/maps/place/?q=place_id:ChIJabc');
    expect(linkDeFicha(undefined)).toBeUndefined();
  });
});
