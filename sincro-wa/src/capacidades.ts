/**
 * El catalogo de capacidades: la regla que manda sobre todo el bot.
 *
 * Una app tiene SOLO lo que pidio el cliente. Para su clave, una ruta que no
 * esta en sus capacidades no existe (404, como si no estuviera publicada), y
 * un evento que no le toca no le llega. Agregar una capacidad nueva es sumar
 * una entrada aca; lo demas lo lee de este catalogo.
 */

export const CAPACIDADES = ['leads', 'facturas', 'avisos', 'promociones', 'atender', 'puente'] as const;
export type Capacidad = (typeof CAPACIDADES)[number];

export type TipoDeEvento = 'mensaje' | 'formulario' | 'factura' | 'estado' | 'derivar' | 'conexion' | 'baja' | 'alta' | 'comentario';
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
    // `formulario`: el de contacto de la web del negocio (ver formulario.ts).
    eventos: ['mensaje', 'formulario'],
    rutas: ['POST /mensajes', 'POST /escribiendo', 'GET /charlas/:contacto', 'GET /media/:id'],
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
      'POST /escribiendo',
      'GET /charlas/:contacto',
      'PUT /atender/contexto',
      'POST /charlas/:contacto/liberar',
      'GET /media/:id',
    ],
    plantillas: [],
  },
  // Sincro Puente: contesta en nombre de la empresa. Recibe todos los mensajes (no solo los derivados),
  // los estados de entrega y los avisos de la conexion (token caido). Plantillas de utilidad; las de
  // marketing exigen ademas `promociones`. NO usa la IA de este bot: piensa Puente, en la app.
  puente: {
    eventos: ['mensaje', 'estado', 'conexion', 'baja', 'alta', 'comentario'],
    rutas: [
      'POST /mensajes',
      'POST /escribiendo',
      'GET /charlas/:contacto',
      'POST /charlas/:contacto/baja',
      'POST /comentarios/:id/responder',
      'POST /comentarios/:id/privado',
      'POST /comentarios/:id/ocultar',
      'GET /media/:id',
      'POST /avisos',
      ...PLANTILLAS,
    ],
    plantillas: ['UTILITY'],
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
