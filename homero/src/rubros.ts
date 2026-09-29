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
    osm: ['["office"="accountant"]', '["office"="tax_advisor"]'],
    ideas: [
      'una aplicación donde los clientes mandan sus facturas por WhatsApp y quedan cargadas y ordenadas solas por cliente y por mes',
      'facturación automática: las facturas de cada cliente se generan solas, sin cargarlas a mano',
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

/**
 * Donde se busca: Capital y zona norte, EN ORDEN de prioridad. Homero agota
 * primero los de arriba: a igual cantidad de busquedas, gana el primero.
 *
 * `osm` es el nombre exacto del limite administrativo en OpenStreetMap
 * (verificado contra Overpass); con el nombre corto no encuentra el area.
 */
export interface Zona {
  nombre: string;
  osm: string;
}

export const ZONAS: Zona[] = [
  { nombre: 'Capital Federal', osm: 'Ciudad Autónoma de Buenos Aires' },
  { nombre: 'Vicente López', osm: 'Partido de Vicente López' },
  { nombre: 'San Isidro', osm: 'Partido de San Isidro' },
  { nombre: 'San Fernando', osm: 'Partido de San Fernando' },
  { nombre: 'Tigre', osm: 'Partido de Tigre' },
  { nombre: 'Escobar', osm: 'Partido de Escobar' },
  { nombre: 'Pilar', osm: 'Partido del Pilar' },
  { nombre: 'San Miguel', osm: 'Partido de San Miguel' },
  { nombre: 'Malvinas Argentinas', osm: 'Partido de Malvinas Argentinas' },
  { nombre: 'José C. Paz', osm: 'Partido de José C. Paz' },
];

export const CIUDADES = ZONAS.map((z) => z.nombre);

/** La zona de la lista, o `undefined` si es una ciudad libre de /buscar. */
export function zonaPorNombre(nombre: string): Zona | undefined {
  const n = nombre.trim().toLowerCase();
  return ZONAS.find((z) => z.nombre.toLowerCase() === n || z.osm.toLowerCase() === n);
}

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
 * para seguir aprendiendo. Los que nunca se probaron van primero, EN ORDEN:
 * la lista arranca por estudios contables, que es donde mejor encaja.
 */
export function elegirRubro(stats: Rendimiento[], azar: () => number = Math.random): Rubro {
  const sinProbar = RUBROS.filter((r) => !stats.some((s) => s.rubro === r.id && s.contactados > 0));
  if (sinProbar.length > 0) return sinProbar[0]!;
  if (azar() < 0.2) return RUBROS[Math.floor(azar() * RUBROS.length)]!;

  const tasa = (r: Rubro) => {
    const s = stats.find((x) => x.rubro === r.id);
    return ((s?.respuestas ?? 0) + 1) / ((s?.contactados ?? 0) + 10);
  };
  return [...RUBROS].sort((a, b) => tasa(b) - tasa(a))[0]!;
}

/** La zona menos buscada para ese rubro; si empatan, la primera de la lista. */
export function elegirCiudad(buscadas: { ciudad: string; veces: number }[]): string {
  const veces = (c: string) => buscadas.find((b) => b.ciudad === c)?.veces ?? 0;
  return [...CIUDADES].sort((a, b) => veces(a) - veces(b))[0]!;
}

export function rubroPorId(id: string): Rubro | undefined {
  return RUBROS.find((r) => r.id === id);
}
