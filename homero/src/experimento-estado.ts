import { diaArgentino } from './agenda.js';
import { relojArgentino } from './horas.js';
import type { Store } from './store.js';

/**
 * El experimento de los 5 reels (spec 2026-10-18): lo que vive en
 * `homero.estado` y lo que otros archivos necesitan preguntar sin importar la
 * logica entera (anuncios.ts pausa al publicista mientras el experimento gasta;
 * publicar-reel.ts no promociona aparte los reels que ya estan adentro).
 */

export const EXPERIMENTO = 'experimento';

/**
 * - `reels`: Homero arma los reels y Gero los aprueba.
 * - `listo`: los 5 estan publicados y la campaña existe PAUSADA, esperando a Gero.
 * - `corriendo`: gasta, con el tope propio del experimento.
 * - `terminado` / `cancelado`: ya no hace nada.
 */
export type FaseDeExperimento = 'reels' | 'listo' | 'corriendo' | 'terminado' | 'cancelado';

/** Lo que se va creando en Meta para cada reel; se anota pieza por pieza para que un corte siga desde ahi. */
export interface PiezaDeExperimento {
  reelId: number;
  anuncioId?: number;
  formulario?: string;
  creativo?: string;
  anuncio?: string;
  /** Sigue gastando: lo pausa el control a partir del dia 4. */
  activo: boolean;
}

export interface EstadoDeExperimento {
  fase: FaseDeExperimento;
  creadoEn: string;
  /** Lo maximo que gasta el experimento entero, en pesos. */
  total: number;
  /** El presupuesto diario compartido de la campaña, en pesos (se baja solo al final para no pasarse del total). */
  diario: number;
  /** Cuantos reels hacen falta publicados para armar la campaña. */
  cantidad: number;
  /** Cuantos reels se pidieron (el numero del ultimo): el siguiente es este + 1. */
  pedidos: number;
  /** Los reels que hizo el estudio, en orden (alguno puede terminar descartado). */
  reelIds: number[];
  /** Una linea por reel hecho (estilo y gancho), para que el siguiente sea distinto. */
  hechos: string[];
  /** Los temas del banco ya usados. */
  musicas: string[];
  campana?: string;
  conjunto?: string;
  piezas: PiezaDeExperimento[];
  /** Cuando Gero lo arranco (ISO). */
  inicio?: string;
  /** El dia en que se concentro el gasto en los mejores (AAAA-MM-DD). */
  concentradoEn?: string;
  /** El ultimo dia que se mando el resumen diario (AAAA-MM-DD). */
  resumenDe?: string;
  /** Ya se aviso que faltan reels o que no se puede armar: una vez por motivo. */
  avisado?: string[];
  /** Lo gastado en la ultima lectura de Meta, en pesos. */
  gastado?: number;
  fin?: { cuando: string; motivo: string };
}

export async function leerExperimento(store: Pick<Store, 'leerEstado'>): Promise<EstadoDeExperimento | undefined> {
  return store.leerEstado<EstadoDeExperimento>(EXPERIMENTO);
}

/** Mientras el experimento arma, espera o gasta, el publicista no propone anuncios aparte. */
export async function experimentoOcupaLaCuenta(store: Pick<Store, 'leerEstado'>): Promise<boolean> {
  const e = await leerExperimento(store);
  return e?.fase === 'listo' || e?.fase === 'corriendo';
}

/** Cada hora, desde el planificador de anuncios: solo se encola si hay un experimento que mirar. */
export async function planificarExperimento(deps: { store: Store; ahora: () => Date }): Promise<void> {
  const e = await leerExperimento(deps.store);
  if (!e || (e.fase !== 'reels' && e.fase !== 'corriendo')) return;
  const dia = diaArgentino(deps.ahora());
  const { hora } = relojArgentino(deps.ahora());
  await deps.store.encolar({ tipo: 'experimento_paso', payload: {}, requiereIa: false, clave: `experimento:paso:${dia}:${hora}` });
}
