import type { DepsDeCola } from '../src/cola.js';
import type { Correo, MailSaliente } from '../src/envio.js';
import type { Hallazgo } from '../src/fuentes.js';
import type { PedidoDeCorrida, RespuestaDeCorrida } from '../src/gateway.js';
import { SesionesMcp } from '../src/mcp.js';
import type { Meta } from '../src/meta.js';
import { MemoriaStore } from './memoria.js';

export const casilla = { email: 'sincro.ventas@gmail.com', clave: 'x' };

export interface Opciones {
  pedirIa?: (p: string) => Promise<string>;
  ahora?: Date;
  hallazgos?: Hallazgo[];
  /** Por defecto apagado en los tests; en produccion arranca prendido. */
  ensayo?: boolean;
  /**
   * Lo que hace el "agente" en el gateway falso: recibe el pedido y las
   * sesiones (para llamar a las herramientas como lo haria el modelo).
   */
  agente?: (p: PedidoDeCorrida, sesiones: SesionesMcp) => Promise<Partial<RespuestaDeCorrida>>;
  paginas?: Record<string, string>;
  /** Sin esto, Homero anda como sin META_TOKEN. */
  meta?: Meta;
}

/** Un Homero entero con todo lo de afuera falso. */
export function armar(o: Opciones = {}) {
  let ahora = o.ahora ?? new Date('2026-09-29T17:00:00Z'); // martes 14hs AR
  const store = new MemoriaStore(() => ahora);
  if (!o.ensayo) store.estado.set('ensayo', { apagado: true });
  const avisos: string[] = [];
  const tarjetas: { texto: string; datos: string[] }[] = [];
  const enviados: MailSaliente[] = [];
  const prompts: string[] = [];
  const correo: Correo = {
    async enviar(_c, _r, m) {
      enviados.push(m);
      return { messageId: `<m${enviados.length}@x>` };
    },
  };
  const sesiones = new SesionesMcp();
  const corridas: PedidoDeCorrida[] = [];
  const fotos: { png: Buffer; pie: string }[] = [];
  const deps: DepsDeCola = {
    store,
    correo,
    remitente: 'Geronimo Enrici',
    casillas: [casilla],
    firma: 'Gero',
    emailGero: 'gero@personal.com',
    ahora: () => ahora,
    avisar: async (t) => {
      avisos.push(t);
    },
    proponer: async (texto, botones) => {
      tarjetas.push({ texto, datos: botones.map((b) => b.datos) });
      return 1000 + tarjetas.length;
    },
    pedirIa: async (p) => {
      prompts.push(p);
      if (!o.pedirIa) throw new Error('sin IA en este test');
      return o.pedirIa(p);
    },
    fuente: async () => o.hallazgos ?? [],
    nombreDeFuente: 'osm',
    recibeMail: async () => true,
    azar: () => 0,
    sesiones,
    meta: o.meta,
    mandarFoto: async (png, pie) => {
      fotos.push({ png, pie });
    },
    bajarPagina: async (url) => (o.paginas?.[url] ? { html: o.paginas[url]!, url } : undefined),
    gateway: {
      async correr(p) {
        corridas.push(p);
        if (!o.agente) throw new Error('sin agente en este test');
        return { texto: '', turnos: 1, pasos: [], ...(await o.agente(p, sesiones)) };
      },
    },
  };
  return { store, deps, corridas, sesiones, avisos, tarjetas, enviados, prompts, fotos, mover: (d: Date) => (ahora = d), ahora: () => ahora };
}

/**
 * Los agentes de verdad corren en el gateway. Aca un "agente" es un guion que
 * usa las herramientas por la MISMA puerta que el modelo (token de la corrida y
 * validacion incluidos): lo que se prueba es lo que Homero hace con eso.
 */
export type Usar = (nombre: string, args?: unknown) => Promise<{ texto: string; error: boolean }>;
export interface Guion {
  buscador?: (usar: Usar, p: PedidoDeCorrida) => Promise<void>;
  vendedor?: (usar: Usar, p: PedidoDeCorrida) => Promise<void>;
  atencion?: (usar: Usar, p: PedidoDeCorrida) => Promise<void>;
  publicista?: (usar: Usar, p: PedidoDeCorrida) => Promise<void>;
}

export function agenteDe(g: Guion) {
  return async (p: PedidoDeCorrida, sesiones: SesionesMcp): Promise<Partial<RespuestaDeCorrida>> => {
    const usar: Usar = (nombre, args) => sesiones.usar(p.corrida, p.tokenCorrida, nombre, args);
    const quien = p.herramientas.includes('anotar_negocio')
      ? g.buscador
      : p.herramientas.includes('dejar_mail_listo')
        ? g.vendedor
        : p.herramientas.includes('proponer_anuncio')
          ? g.publicista
          : g.atencion;
    if (!quien) throw new Error(`este test no esperaba una corrida con ${p.herramientas.join(',')}`);
    await quien(usar, p);
    return { texto: 'informe', slot: 'c3' };
  };
}
