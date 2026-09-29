import { describe, expect, it } from 'vitest';
import { correrSiguiente } from '../src/cola.js';
import { linkDeFicha } from '../src/fuentes.js';
import { aprobarLead, ENSAYO, ensayoActivo, mandarMuestras } from '../src/ventas.js';
import { armar } from './armar.js';

const borrador = JSON.stringify({
  encaja: true,
  motivo: 'pyme',
  resumen_empresa: 'Estudio contable en Rosario',
  dolor: 'carga de facturas',
  idea: 'bot de facturas por WhatsApp',
  asunto: 'facturas del estudio',
  mensaje: 'Hola, vi que son estudio contable...',
  seguimiento1: 'Te escribo de nuevo...',
  seguimiento2: '¿Lo dejo acá?',
});

async function conUnBorrador() {
  const h = armar({
    ensayo: true,
    hallazgos: [{ externo: 'osm:node/42', nombre: 'Estudio X', web: 'https://estudiox.com.ar', fuente: 'osm' }],
    sitio: {
      texto: 'Estudio X',
      mails: ['info@estudiox.com.ar'],
      paginas: ['https://estudiox.com.ar', 'https://estudiox.com.ar/contacto'],
    },
    pedirIa: async () => borrador,
  });
  await h.store.encolar({ tipo: 'prospectar', payload: { cantidad: 1 }, requiereIa: false });
  for (let i = 0; i < 10 && (await correrSiguiente(h.deps)); i++);
  return h;
}

describe('modo ensayo', () => {
  it('arranca prendido hacia el mail de Gero', async () => {
    const h = armar({ ensayo: true });
    expect(await ensayoActivo(h.deps)).toBe('gero@personal.com');
    await h.store.guardarEstado(ENSAYO, { apagado: true });
    expect(await ensayoActivo(h.deps)).toBeUndefined();
  });

  it('manda la muestra a Gero, con a quien iba, las fuentes y los seguimientos, y nada al cliente', async () => {
    const { enviados, store } = await conUnBorrador();
    expect(enviados).toHaveLength(1);
    const m = enviados[0]!;
    expect(m.para).toBe('gero@personal.com');
    expect(m.asunto).toBe('[ENSAYO] facturas del estudio');
    expect(m.texto).toContain('Iba para: info@estudiox.com.ar');
    expect(m.texto).toContain('https://www.openstreetmap.org/node/42');
    expect(m.texto).toContain('https://estudiox.com.ar/contacto');
    expect(m.texto).toContain('Hola, vi que son estudio contable...');
    expect(m.texto).toContain('¿Lo dejo acá?');
    // No gasta cupo ni cambia al lead.
    expect(store.envios).toHaveLength(0);
    expect(store.leads[0]!.estado).toBe('borrador');
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

  it('el link de la ficha sale para OSM y para Google', () => {
    expect(linkDeFicha('osm:way/7')).toBe('https://www.openstreetmap.org/way/7');
    expect(linkDeFicha('google:ChIJabc')).toBe('https://www.google.com/maps/place/?q=place_id:ChIJabc');
    expect(linkDeFicha(undefined)).toBeUndefined();
  });
});
