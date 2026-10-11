import type { Capacidad, CategoriaDePlantilla, TipoDeEvento } from './capacidades.js';

/**
 * Lo que el bot guarda, detras de una interfaz.
 *
 * En produccion es `PgStore` (db.ts). Los tests usan una version en memoria
 * (test/memoria.ts) porque en la laptop no hay Postgres: toda la logica vive
 * arriba de esta interfaz y la base solo guarda y filtra, asi lo que se prueba
 * es lo mismo que corre.
 */

export interface Negocio {
  id: number;
  nombre: string;
  app: string;
  capacidades: Capacidad[];
  topeMensualArs: number;
  urlBase: string | null;
  activo: boolean;
  claveHash: string | null;
  claveUltimoUso: Date | null;
  /** Cifrado (cifrado.ts). */
  secretoEventos: string;
  contextoAtender: string;
  creado: Date;
}

export interface NuevoNegocio {
  nombre: string;
  app: string;
  capacidades: Capacidad[];
  topeMensualArs: number;
  urlBase: string | null;
  secretoEventos: string;
}

export type CambiosDeNegocio = Partial<
  Pick<Negocio, 'capacidades' | 'topeMensualArs' | 'urlBase' | 'activo' | 'contextoAtender' | 'claveHash'>
>;

export interface Numero {
  id: number;
  negocioId: number;
  phoneNumberId: string;
  wabaId: string;
  /** Cifrado. Null: usa el token del system user (el numero de Sincro). */
  tokenCifrado: string | null;
  calidad: string | null;
  /** Contactos distintos por 24 h. Null: sin tope (o todavia no se sabe). */
  topeMeta: number | null;
  estado: string | null;
  nombreVerificado: string | null;
  sinMensajesAlertado: boolean;
}

export type CambiosDeNumero = Partial<
  Pick<Numero, 'calidad' | 'topeMeta' | 'estado' | 'nombreVerificado' | 'sinMensajesAlertado'>
>;

export interface Contacto {
  numeroId: number;
  negocioId: number;
  contacto: string;
  nombre: string | null;
  ultimaEntrada: Date | null;
  baja: boolean;
  bajaDesde: Date | null;
  derivada: boolean;
}

export type CategoriaDeMensaje = 'marketing' | 'utility' | 'authentication' | 'service';

export interface Mensaje {
  id: number;
  negocioId: number;
  numeroId: number;
  contacto: string;
  direccion: 'entra' | 'sale';
  tipo: string;
  texto: string | null;
  mediaId: number | null;
  referral: Record<string, unknown> | null;
  /** El nombre de la plantilla, si salio con una. */
  plantilla: string | null;
  wamid: string | null;
  categoria: CategoriaDeMensaje | null;
  costoEstimado: number;
  costoReal: number | null;
  estado: string | null;
  error: { codigo: number | string; detalle: string } | null;
  fecha: Date;
}

export type NuevoMensaje = Omit<Mensaje, 'id'>;

export type CambiosDeMensaje = Partial<Pick<Mensaje, 'estado' | 'costoReal' | 'error' | 'mediaId'>>;

export interface Media {
  id: number;
  negocioId: number;
  mime: string;
  datos: Buffer;
  creado: Date;
}

export interface Plantilla {
  id: number;
  negocioId: number;
  wabaId: string;
  metaId: string | null;
  nombre: string;
  idioma: string;
  categoria: CategoriaDePlantilla;
  componentes: unknown[];
  estado: string;
  motivo: string | null;
  bloqueada: boolean;
}

export type NuevaPlantilla = Omit<Plantilla, 'id'>;

export type CambiosDePlantilla = Partial<Pick<Plantilla, 'estado' | 'motivo' | 'categoria' | 'bloqueada' | 'metaId'>>;

export interface Precio {
  categoria: string;
  precioArs: number;
  desde: Date;
}

export interface UsoIa {
  negocioId: number;
  capacidad: string;
  modelo: string;
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number;
  fecha: Date;
}

export interface Cambio {
  id?: number;
  negocioId: number | null;
  campo: string;
  antes: string | null;
  despues: string | null;
  quien: string;
  fecha: Date;
}

/** Tipos de evento: los de las apps y `alerta`, que es solo de admin. */
export type TipoDeEventoGuardado = TipoDeEvento | 'alerta';

export interface Evento {
  id: number;
  /** Null: evento de admin (alertas para Homero). */
  negocioId: number | null;
  tipo: TipoDeEventoGuardado;
  datos: Record<string, unknown>;
  fecha: Date;
  entregado: boolean;
  intentos: number;
  proximoIntento: Date | null;
  alertado: boolean;
}

export type CambiosDeEvento = Partial<Pick<Evento, 'entregado' | 'intentos' | 'proximoIntento' | 'alertado'>>;

export type TipoDeTrabajo = 'factura' | 'atender';
export type EstadoDeTrabajo = 'pendiente' | 'tomada' | 'lista' | 'fallida';

export interface TrabajoIa {
  id: number;
  negocioId: number;
  numeroId: number;
  contacto: string;
  tipo: TipoDeTrabajo;
  entrada: Record<string, unknown>;
  estado: EstadoDeTrabajo;
  tomadaHasta: Date | null;
  resultado: Record<string, unknown> | null;
  error: string | null;
  creado: Date;
}

export type NuevoTrabajo = Pick<TrabajoIa, 'negocioId' | 'numeroId' | 'contacto' | 'tipo' | 'entrada' | 'creado'>;

export type CambiosDeTrabajo = Partial<Pick<TrabajoIa, 'estado' | 'tomadaHasta' | 'resultado' | 'error' | 'entrada'>>;

export interface Alerta {
  id: number;
  /** Para no repetir: una sola alerta por clave. Null: siempre se guarda. */
  clave: string | null;
  negocioId: number | null;
  tipo: string;
  texto: string;
  fecha: Date;
}

/** Un mensaje saliente para los resumenes: lo minimo para agrupar. */
export interface Saliente {
  negocioId: number;
  fecha: Date;
  categoria: CategoriaDeMensaje | null;
  /** El real si llego, si no el estimado. */
  costo: number;
}

export interface Store {
  // Negocios
  crearNegocio(n: NuevoNegocio, fecha: Date): Promise<Negocio>;
  negocio(id: number): Promise<Negocio | undefined>;
  negocios(): Promise<Negocio[]>;
  cambiarNegocio(id: number, c: CambiosDeNegocio): Promise<Negocio | undefined>;
  usoDeClave(id: number, fecha: Date): Promise<void>;
  registrarCambios(c: Cambio[]): Promise<void>;
  cambios(negocioId?: number): Promise<Cambio[]>;

  // Numeros
  /** Undefined si el phone_number_id ya esta dado de alta. */
  crearNumero(n: Omit<Numero, 'id' | 'calidad' | 'topeMeta' | 'estado' | 'nombreVerificado' | 'sinMensajesAlertado'>): Promise<Numero | undefined>;
  numero(id: number): Promise<Numero | undefined>;
  numeroPorPhoneId(phoneNumberId: string): Promise<Numero | undefined>;
  numerosDe(negocioId: number): Promise<Numero[]>;
  numerosDeWaba(wabaId: string): Promise<Numero[]>;
  todosLosNumeros(): Promise<Numero[]>;
  cambiarNumero(id: number, c: CambiosDeNumero): Promise<void>;

  // Contactos
  contacto(numeroId: number, contacto: string): Promise<Contacto | undefined>;
  /** El contacto en todos los numeros del negocio. */
  contactosDe(negocioId: number, contacto: string): Promise<Contacto[]>;
  /** Abre la ventana: crea el contacto o le pone la ultima entrada. */
  registrarEntrada(numeroId: number, negocioId: number, contacto: string, nombre: string | null, fecha: Date): Promise<Contacto>;
  cambiarContacto(numeroId: number, contacto: string, c: Partial<Pick<Contacto, 'baja' | 'bajaDesde' | 'derivada'>>): Promise<void>;
  bajas(negocioId?: number): Promise<Contacto[]>;
  /** Contactos con la ultima entrada despues de `desde`. */
  ventanasAbiertas(desde: Date, negocioId?: number): Promise<number>;

  // Mensajes
  /** Undefined si el wamid ya estaba: Meta repite webhooks. */
  guardarMensaje(m: NuevoMensaje): Promise<Mensaje | undefined>;
  mensajePorWamid(wamid: string): Promise<Mensaje | undefined>;
  cambiarMensaje(id: number, c: CambiosDeMensaje): Promise<void>;
  /** Los ultimos `limite` de la charla, del mas viejo al mas nuevo. */
  charla(negocioId: number, contacto: string, limite: number): Promise<Mensaje[]>;
  /** Contactos distintos a los que salio una plantilla desde ese numero. */
  contactosConPlantilla(numeroId: number, desde: Date): Promise<string[]>;
  costosDelPeriodo(negocioId: number, desde: Date, hasta: Date): Promise<{ metaArs: number; iaUsd: number }>;
  salientes(desde: Date, hasta: Date, negocioId?: number): Promise<Saliente[]>;

  // Media
  guardarMedia(negocioId: number, mime: string, datos: Buffer, fecha: Date): Promise<number>;
  media(id: number): Promise<Media | undefined>;
  borrarMediaVieja(antes: Date): Promise<number>;

  // Plantillas
  /** Undefined si ya existe ese nombre e idioma en el negocio. */
  crearPlantilla(p: NuevaPlantilla): Promise<Plantilla | undefined>;
  plantilla(negocioId: number, nombre: string, idioma: string): Promise<Plantilla | undefined>;
  plantillas(negocioId?: number): Promise<Plantilla[]>;
  plantillaPorMetaId(metaId: string): Promise<Plantilla | undefined>;
  plantillasDeWaba(wabaId: string, nombre: string, idioma: string): Promise<Plantilla[]>;
  cambiarPlantilla(id: number, c: CambiosDePlantilla): Promise<void>;

  // Costos
  precios(): Promise<Precio[]>;
  ponerPrecio(categoria: string, precioArs: number, fecha: Date): Promise<void>;
  /** ARS por USD, el ultimo cargado. */
  dolar(): Promise<number | undefined>;
  ponerDolar(arsPorUsd: number, quien: string, fecha: Date): Promise<void>;
  registrarUsoIa(u: UsoIa): Promise<void>;

  // Eventos
  crearEvento(negocioId: number | null, tipo: TipoDeEventoGuardado, datos: Record<string, unknown>, fecha: Date): Promise<Evento>;
  /** Los no entregados, del mas viejo al mas nuevo. */
  eventosPendientes(negocioId: number | null, limite: number): Promise<Evento[]>;
  /** Marca entregados solo los de ese negocio (null: los de admin). */
  ackEventos(negocioId: number | null, ids: number[]): Promise<number>;
  /** Los de negocios con url_base, sin entregar, sin alertar y con el reintento vencido. */
  eventosParaPush(ahora: Date): Promise<Evento[]>;
  cambiarEvento(id: number, c: CambiosDeEvento): Promise<void>;

  // IA
  crearTrabajo(t: NuevoTrabajo): Promise<TrabajoIa>;
  trabajo(id: number): Promise<TrabajoIa | undefined>;
  /** Un trabajo de ese tipo todavia sin tomar para esa charla. */
  trabajoPendiente(numeroId: number, contacto: string, tipo: TipoDeTrabajo): Promise<TrabajoIa | undefined>;
  /** Toma hasta `limite` pendientes (o tomados vencidos) y los marca tomados hasta `hasta`. */
  tomarTrabajos(ahora: Date, hasta: Date, limite: number): Promise<TrabajoIa[]>;
  cambiarTrabajo(id: number, c: CambiosDeTrabajo): Promise<void>;
  /** Devuelve a pendientes los tomados que vencieron. */
  liberarTrabajosVencidos(ahora: Date): Promise<number>;

  // Alertas y registro
  /** Undefined si ya habia una con esa clave. */
  crearAlerta(a: Omit<Alerta, 'id'>): Promise<Alerta | undefined>;
  alertas(limite: number): Promise<Alerta[]>;
  registrarIntentoNegado(negocioId: number, metodo: string, ruta: string, fecha: Date): Promise<void>;
  registrarWebhook(numeroId: number, fecha: Date): Promise<void>;
  contarWebhooks(numeroId: number, desde: Date): Promise<number>;
  borrarWebhooksViejos(antes: Date): Promise<number>;
}
