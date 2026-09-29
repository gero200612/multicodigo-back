/**
 * A quien se le escribe.
 *
 * Cada rubro trae con que buscarlo (texto para Google, etiquetas para
 * OpenStreetMap) y dos ideas de automatizacion que le sirven, para que el mail
 * hable de algo concreto de SU negocio y no de "automatizamos procesos".
 */
export interface Rubro {
  id: string;
  nombre: string;
  /** Lo que se le pide a Google Places: "<busqueda> en <ciudad>". */
  busqueda: string;
  /** Filtros de Overpass, uno por linea: `["office"="accountant"]`. */
  osm: string[];
  ideas: string[];
}

export const RUBROS: Rubro[] = [
  {
    id: 'contable',
    nombre: 'estudio contable',
    busqueda: 'estudio contable',
    osm: ['["office"="accountant"]'],
    ideas: [
      'un bot de WhatsApp donde los clientes mandan fotos de facturas y quedan cargadas y ordenadas solas',
      'recordatorios automáticos de vencimientos y pedido de comprobantes a cada cliente',
    ],
  },
  {
    id: 'distribuidora',
    nombre: 'distribuidora',
    busqueda: 'distribuidora mayorista',
    osm: ['["shop"="wholesale"]', '["office"="wholesale"]'],
    ideas: [
      'toma de pedidos por WhatsApp que carga el pedido solo y avisa a depósito',
      'facturas y remitos que se generan automáticos con el pedido',
    ],
  },
  {
    id: 'inmobiliaria',
    nombre: 'inmobiliaria',
    busqueda: 'inmobiliaria',
    osm: ['["office"="estate_agent"]'],
    ideas: [
      'un bot que responde consultas de propiedades 24/7 y agenda visitas',
      'cobro de alquileres con recordatorios y recibos automáticos',
    ],
  },
  {
    id: 'consultorio',
    nombre: 'consultorio o clínica',
    busqueda: 'consultorio médico',
    osm: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["amenity"="dentist"]'],
    ideas: [
      'turnos por WhatsApp con confirmación y recordatorio automático (menos ausencias)',
      'carga automática de órdenes y autorizaciones de obras sociales',
    ],
  },
  {
    id: 'taller',
    nombre: 'taller mecánico',
    busqueda: 'taller mecánico',
    osm: ['["shop"="car_repair"]'],
    ideas: [
      'presupuestos que se arman solos y se mandan por WhatsApp con aprobación',
      'aviso automático al cliente cuando el auto está listo y recordatorio de service',
    ],
  },
  {
    id: 'gastronomia',
    nombre: 'restaurante',
    busqueda: 'restaurante',
    osm: ['["amenity"="restaurant"]'],
    ideas: [
      'control de stock y costos que se actualiza solo con las facturas de proveedores',
      'pedidos y reservas por WhatsApp que entran directo al sistema',
    ],
  },
  {
    id: 'logistica',
    nombre: 'empresa de logística',
    busqueda: 'empresa de logística transporte',
    osm: ['["office"="logistics"]', '["office"="moving_company"]'],
    ideas: [
      'seguimiento de envíos con avisos automáticos al cliente por WhatsApp',
      'carga automática de remitos y guías desde una foto',
    ],
  },
  {
    id: 'veterinaria',
    nombre: 'veterinaria',
    busqueda: 'veterinaria',
    osm: ['["amenity"="veterinary"]'],
    ideas: [
      'recordatorios automáticos de vacunas y controles a cada dueño',
      'turnos por WhatsApp con confirmación',
    ],
  },
  {
    id: 'gimnasio',
    nombre: 'gimnasio',
    busqueda: 'gimnasio',
    osm: ['["leisure"="fitness_centre"]'],
    ideas: [
      'cobro de cuotas con recordatorio y aviso de vencidos automático',
      'reservas de clases por WhatsApp',
    ],
  },
  {
    id: 'ferreteria',
    nombre: 'ferretería o corralón',
    busqueda: 'corralón materiales construcción',
    osm: ['["shop"="hardware"]', '["shop"="doityourself"]'],
    ideas: [
      'presupuestos por WhatsApp que se arman solos con la lista de precios',
      'actualización automática de precios con las listas de proveedores',
    ],
  },
];

export const CIUDADES = [
  'Ciudad Autónoma de Buenos Aires',
  'Córdoba',
  'Rosario',
  'Mendoza',
  'La Plata',
  'Mar del Plata',
  'San Miguel de Tucumán',
  'Santa Fe',
  'Salta',
  'Neuquén',
];

export interface Rendimiento {
  rubro: string;
  contactados: number;
  respuestas: number;
}

/**
 * Que rubro atacar ahora.
 *
 * Mayormente el que mejor responde (tasa de respuesta con un previo de 1/10
 * para que un rubro con 1 de 1 no gane por suerte), y cada tanto uno cualquiera
 * para seguir aprendiendo. Los que nunca se probaron van primero.
 */
export function elegirRubro(stats: Rendimiento[], azar: () => number = Math.random): Rubro {
  const sinProbar = RUBROS.filter((r) => !stats.some((s) => s.rubro === r.id && s.contactados > 0));
  if (sinProbar.length > 0) return sinProbar[Math.floor(azar() * sinProbar.length)]!;
  if (azar() < 0.2) return RUBROS[Math.floor(azar() * RUBROS.length)]!;

  const tasa = (r: Rubro) => {
    const s = stats.find((x) => x.rubro === r.id);
    return ((s?.respuestas ?? 0) + 1) / ((s?.contactados ?? 0) + 10);
  };
  return [...RUBROS].sort((a, b) => tasa(b) - tasa(a))[0]!;
}

/** La ciudad menos buscada para ese rubro. */
export function elegirCiudad(buscadas: { ciudad: string; veces: number }[]): string {
  const veces = (c: string) => buscadas.find((b) => b.ciudad === c)?.veces ?? 0;
  return [...CIUDADES].sort((a, b) => veces(a) - veces(b))[0]!;
}

export function rubroPorId(id: string): Rubro | undefined {
  return RUBROS.find((r) => r.id === id);
}
