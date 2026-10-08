/**
 * A quien se le escribe.
 *
 * Veinte tipos de negocio. Cada uno trae con que buscarlo (texto para Google,
 * etiquetas para OpenStreetMap) e ideas de automatizacion como INSPIRACION: la
 * propuesta la arma la IA para cada negocio segun lo que ve en su web.
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
      'recepción de facturas y comprobantes por WhatsApp que quedan cargados y ordenados por cliente y por mes',
      'facturación automática de los clientes del estudio',
      'recordatorios automáticos de vencimientos y pedido de documentación',
    ],
  },
  {
    id: 'juridico',
    nombre: 'estudio jurídico',
    busqueda: 'estudio jurídico abogados',
    osm: ['["office"="lawyer"]'],
    ideas: [
      'seguimiento de expedientes con avisos automáticos al cliente del estado de su caso',
      'recepción y orden de la documentación de cada cliente',
      'agenda de audiencias y vencimientos con recordatorios',
    ],
  },
  {
    id: 'inmobiliaria',
    nombre: 'inmobiliaria',
    busqueda: 'inmobiliaria',
    osm: ['["office"="estate_agent"]'],
    ideas: [
      'cobro de alquileres con recordatorios y recibos automáticos',
      'administración de propiedades: vencimientos de contratos, ajustes e inquilinos en un solo lugar',
      'respuesta de consultas y agenda de visitas',
    ],
  },
  {
    id: 'consultorio',
    nombre: 'consultorio médico o clínica',
    busqueda: 'consultorio médico',
    osm: ['["amenity"="clinic"]', '["amenity"="doctors"]'],
    ideas: [
      'turnos con confirmación y recordatorio automático (menos ausencias)',
      'carga de órdenes y autorizaciones de obras sociales',
      'historia clínica y facturación a obras sociales ordenadas',
    ],
  },
  {
    id: 'odontologia',
    nombre: 'consultorio odontológico',
    busqueda: 'odontólogo',
    osm: ['["amenity"="dentist"]', '["healthcare"="dentist"]'],
    ideas: [
      'turnos con recordatorio y confirmación automáticos',
      'presupuestos de tratamientos y seguimiento de pagos en cuotas',
      'recordatorio de controles periódicos a cada paciente',
    ],
  },
  {
    id: 'kinesiologia',
    nombre: 'centro de kinesiología',
    busqueda: 'kinesiología',
    osm: ['["healthcare"="physiotherapist"]'],
    ideas: [
      'agenda de sesiones con recordatorios y control de sesiones autorizadas por obra social',
      'seguimiento de pacientes y cobro de sesiones',
    ],
  },
  {
    id: 'veterinaria',
    nombre: 'veterinaria',
    busqueda: 'veterinaria',
    osm: ['["amenity"="veterinary"]'],
    ideas: [
      'recordatorios automáticos de vacunas y controles a cada dueño',
      'turnos y fichas de cada mascota en un solo lugar',
      'stock de alimentos y medicamentos',
    ],
  },
  {
    id: 'optica',
    nombre: 'óptica',
    busqueda: 'óptica',
    osm: ['["shop"="optician"]'],
    ideas: [
      'aviso automático cuando los anteojos están listos',
      'recetas y graduaciones de cada cliente ordenadas, con recordatorio de control anual',
      'pedidos a laboratorio y stock de armazones',
    ],
  },
  {
    id: 'estetica',
    nombre: 'centro de estética o peluquería',
    busqueda: 'centro de estética',
    osm: ['["shop"="beauty"]', '["shop"="hairdresser"]'],
    ideas: [
      'turnos online con recordatorio y seña',
      'fichas de clientas y recordatorio para volver a reservar',
      'caja y comisiones de cada profesional',
    ],
  },
  {
    id: 'gimnasio',
    nombre: 'gimnasio',
    busqueda: 'gimnasio',
    osm: ['["leisure"="fitness_centre"]'],
    ideas: [
      'cobro de cuotas con recordatorio y aviso de vencidos',
      'reservas de clases con cupo',
      'control de acceso y asistencia de socios',
    ],
  },
  {
    id: 'instituto',
    nombre: 'instituto o academia',
    busqueda: 'instituto de idiomas academia',
    osm: ['["amenity"="language_school"]', '["amenity"="music_school"]', '["amenity"="driving_school"]'],
    ideas: [
      'inscripciones y cobro de cuotas con recordatorios',
      'asistencia, notas y comunicación con alumnos o padres',
    ],
  },
  {
    id: 'taller',
    nombre: 'taller mecánico',
    busqueda: 'taller mecánico',
    osm: ['["shop"="car_repair"]'],
    ideas: [
      'presupuestos que se arman y se aprueban por WhatsApp',
      'aviso automático cuando el auto está listo y recordatorio de service',
      'historial de cada vehículo y repuestos usados',
    ],
  },
  {
    id: 'distribuidora',
    nombre: 'distribuidora',
    busqueda: 'distribuidora mayorista',
    osm: ['["shop"="wholesale"]', '["office"="wholesale"]'],
    ideas: [
      'toma de pedidos que se cargan solos y avisan a depósito',
      'facturas y remitos automáticos con cada pedido',
      'cuenta corriente de clientes y cobranzas',
    ],
  },
  {
    id: 'ferreteria',
    nombre: 'ferretería o corralón',
    busqueda: 'corralón materiales construcción',
    osm: ['["shop"="hardware"]', '["shop"="doityourself"]', '["shop"="trade"]'],
    ideas: [
      'presupuestos que se arman solos con la lista de precios',
      'actualización automática de precios con las listas de proveedores',
      'stock y reposición',
    ],
  },
  {
    id: 'gastronomia',
    nombre: 'restaurante o café',
    busqueda: 'restaurante',
    osm: ['["amenity"="restaurant"]', '["amenity"="cafe"]'],
    ideas: [
      'control de stock y costos que se actualiza con las facturas de proveedores',
      'pedidos y reservas que entran directo al sistema',
    ],
  },
  {
    id: 'logistica',
    nombre: 'empresa de logística o transporte',
    busqueda: 'empresa de logística transporte',
    osm: ['["office"="logistics"]', '["office"="moving_company"]', '["shop"="courier"]'],
    ideas: [
      'seguimiento de envíos con avisos automáticos al cliente',
      'carga de remitos y guías desde una foto',
      'liquidación de choferes y viajes',
    ],
  },
  {
    id: 'seguros',
    nombre: 'productor de seguros',
    busqueda: 'productor de seguros',
    osm: ['["office"="insurance"]'],
    ideas: [
      'avisos automáticos de vencimientos y renovaciones de pólizas',
      'recepción de denuncias de siniestros con fotos por WhatsApp',
      'cartera de clientes y pólizas ordenada',
    ],
  },
  {
    id: 'viajes',
    nombre: 'agencia de viajes',
    busqueda: 'agencia de viajes',
    osm: ['["shop"="travel_agency"]', '["office"="travel_agent"]'],
    ideas: [
      'cotizaciones que se arman y se mandan solas',
      'seguimiento de reservas, pagos y documentación de cada pasajero',
    ],
  },
  {
    id: 'arquitectura',
    nombre: 'estudio de arquitectura o constructora',
    busqueda: 'estudio de arquitectura constructora',
    osm: ['["office"="architect"]', '["office"="construction_company"]'],
    ideas: [
      'seguimiento de obras con avance, gastos y certificados',
      'presupuestos y compras de materiales por obra',
    ],
  },
  {
    id: 'imprenta',
    nombre: 'imprenta o gráfica',
    busqueda: 'imprenta gráfica',
    osm: ['["shop"="copyshop"]', '["craft"="printer"]'],
    ideas: [
      'pedidos y presupuestos que se arman solos según cantidad y material',
      'aviso automático cuando el trabajo está listo',
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

export function rubroPorId(id: string): Rubro | undefined {
  return RUBROS.find((r) => r.id === id);
}
