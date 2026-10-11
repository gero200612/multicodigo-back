/**
 * El catalogo de capacidades: la regla que manda sobre todo el bot.
 *
 * Una app tiene SOLO lo que pidio el cliente. Para su clave, una ruta que no
 * esta en sus capacidades no existe (404, como si no estuviera publicada), y
 * un evento que no le toca no le llega. Agregar una capacidad nueva es sumar
 * una entrada aca; lo demas lo lee de este catalogo.
 */

export const CAPACIDADES = ['leads', 'facturas', 'avisos', 'promociones', 'atender'] as const;
export type Capacidad = (typeof CAPACIDADES)[number];

export type TipoDeEvento = 'mensaje' | 'factura' | 'estado' | 'derivar';
export type CategoriaDePlantilla = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

interface Entrada {
  eventos: TipoDeEvento[];
  /** `METODO /ruta` tal como la registra Fastify. */
  rutas: string[];
  plantillas: CategoriaDePlantilla[];
}

const PLANTILLAS = ['GET /plantillas', 'POST /plantillas'];

const CATALOGO: Record<Capacidad, Entrada> = {
  leads: {
    eventos: ['mensaje'],
    rutas: ['POST /mensajes', 'GET /charlas/:contacto', 'GET /media/:id'],
    plantillas: [],
  },
  facturas: { eventos: ['factura'], rutas: ['GET /media/:id'], plantillas: [] },
  avisos: { eventos: ['estado'], rutas: ['POST /avisos', ...PLANTILLAS], plantillas: ['UTILITY'] },
  promociones: { eventos: ['estado'], rutas: ['POST /avisos', ...PLANTILLAS], plantillas: ['MARKETING'] },
  atender: {
    // `mensaje` le llega solo con la charla derivada: eso lo decide quien emite.
    eventos: ['mensaje', 'derivar'],
    rutas: [
      'POST /mensajes',
      'GET /charlas/:contacto',
      'PUT /atender/contexto',
      'POST /charlas/:contacto/liberar',
      'GET /media/:id',
    ],
    plantillas: [],
  },
};

/** Las que ve toda clave de app, tenga lo que tenga. */
const COMUNES = new Set(['GET /yo', 'GET /eventos', 'POST /eventos/ack']);

export function rutaPermitida(capacidades: readonly Capacidad[], ruta: string): boolean {
  return COMUNES.has(ruta) || capacidades.some((c) => CATALOGO[c].rutas.includes(ruta));
}

export function recibeEvento(capacidades: readonly Capacidad[], tipo: TipoDeEvento): boolean {
  return capacidades.some((c) => CATALOGO[c].eventos.includes(tipo));
}

export function categoriasPermitidas(capacidades: readonly Capacidad[]): Set<CategoriaDePlantilla> {
  return new Set(capacidades.flatMap((c) => CATALOGO[c].plantillas));
}

export function tiene(capacidades: readonly Capacidad[], c: Capacidad): boolean {
  return capacidades.includes(c);
}
