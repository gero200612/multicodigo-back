import type { DepsDeCola } from '../src/cola.js';
import type { Correo, MailSaliente } from '../src/envio.js';
import type { Hallazgo } from '../src/fuentes.js';
import { MemoriaStore } from './memoria.js';

export const casilla = { email: 'sincro.ventas@gmail.com', clave: 'x' };

export interface Opciones {
  pedirIa?: (p: string) => Promise<string>;
  ahora?: Date;
  hallazgos?: Hallazgo[];
  sitio?: { texto: string; mails: string[]; paginas?: string[] };
  /** Por defecto apagado en los tests; en produccion arranca prendido. */
  ensayo?: boolean;
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
    leerSitio: async () => o.sitio,
    recibeMail: async () => true,
    azar: () => 0,
  };
  return { store, deps, avisos, tarjetas, enviados, prompts, mover: (d: Date) => (ahora = d), ahora: () => ahora };
}
