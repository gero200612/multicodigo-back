import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { esAvisoDeLimite, horaDeReset } from '@multicodigo/shared';
import { instanteDeReset } from './horas.js';

/**
 * La cuenta de Claude se quedo sin uso. Se espera al reset, nunca se corta.
 *
 * `resets` es el texto crudo del cartel ("10:50pm (UTC)"), o nada si no lo dijo.
 */
export class ErrorDeLimite extends Error {
  constructor(readonly resets?: string) {
    super('usage_limit');
    this.name = 'ErrorDeLimite';
  }
}

/** La sesion de la cuenta vencio: hay que volver a cargarla con el login. */
export class ErrorDeCuenta extends Error {
  constructor(detalle: string) {
    super(`auth_expired: ${detalle}`);
    this.name = 'ErrorDeCuenta';
  }
}

/** Margen despues del reset: el cartel redondea al minuto. */
const MARGEN_MS = 60_000;
/** Si el cartel no dijo la hora, o la cuenta vencio, se reintenta cada tanto. */
export const REINTENTO_SIN_HORA_MS = 30 * 60_000;

/**
 * Cuando volver a intentar despues de un corte de la IA.
 *
 * Sin techo a proposito, a diferencia de `cuandoReintentar` del bridge: una
 * corrida de Punchi tiene hora de cierre, Homero no. Esperar 9 horas a que
 * vuelva la cuenta es mejor que dejar mails sin contestar.
 */
export function cuandoReintentar(err: ErrorDeLimite | ErrorDeCuenta, ahora: Date): Date {
  if (err instanceof ErrorDeLimite && err.resets) {
    const reset = instanteDeReset(err.resets, ahora);
    if (reset) return new Date(reset.getTime() + MARGEN_MS);
  }
  return new Date(ahora.getTime() + REINTENTO_SIN_HORA_MS);
}

// Mismas pistas que `multicodigo-vm/src/agent/src/claude.ts`.
function esDeCuenta(m: string): boolean {
  const t = m.toLowerCase();
  return t.includes('oauth') || t.includes('unauthorized') || t.includes('authentication_failed');
}
function esDeLimite(m: string): boolean {
  const t = m.toLowerCase();
  return (
    t.includes('usage limit') ||
    t.includes('rate_limit') ||
    t.includes('rate limit') ||
    t.includes('429') ||
    t.includes('insufficient_quota') ||
    t.includes('quota exceeded')
  );
}

// Lo minimo que se lee del stream del SDK. Tipado a mano para poder testear con
// un stream falso sin armar mensajes completos del SDK.
interface MensajeDelSdk {
  type?: string;
  subtype?: string;
  result?: unknown;
  errors?: unknown;
  error?: unknown;
}
export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<MensajeDelSdk>;

export interface OpcionesDeIa {
  sistema: string;
  modelo?: string;
  /**
   * El HOME con la cuenta de Claude a usar (la de un agente asignado a este
   * bot). Sin esto, el del proceso: la cuenta propia de Homero.
   */
  home?: string;
  query?: QueryFn;
}

/**
 * Le pide a Claude un texto. SIN herramientas.
 *
 * Esta es la defensa principal contra un mail malicioso: el modelo lee texto
 * de desconocidos, asi que no puede hacer nada mas que contestar texto. Lo que
 * se hace con esa respuesta lo decide este proceso, con sus topes.
 */
export async function pedirTexto(prompt: string, opciones: OpcionesDeIa): Promise<string> {
  const query = opciones.query ?? (sdkQuery as unknown as QueryFn);
  const options: Record<string, unknown> = {
    tools: [],
    allowedTools: [],
    maxTurns: 1,
    systemPrompt: opciones.sistema,
    settingSources: [],
    persistSession: false,
    // Red de mas: si algun dia `tools: []` dejara de apagar todo, igual no
    // se ejecuta nada.
    canUseTool: async () => ({ behavior: 'deny', message: 'Homero no usa herramientas' }),
  };
  if (opciones.modelo) options.model = opciones.modelo;
  if (opciones.home) options.env = { ...process.env, HOME: opciones.home };

  try {
    for await (const m of query({ prompt, options })) {
      if (m?.type === 'assistant' && m.error === 'authentication_failed') {
        throw new ErrorDeCuenta('el SDK reporto authentication_failed');
      }
      if (m?.type !== 'result') continue;
      if (m.subtype !== 'success') {
        const errores = Array.isArray(m.errors) ? m.errors.join('; ') : '';
        throw new Error(`el SDK termino con error (${m.subtype}): ${errores}`);
      }
      const texto = typeof m.result === 'string' ? m.result : '';
      // El limite llega como una respuesta "exitosa" con el cartel adentro.
      if (esAvisoDeLimite(texto)) throw new ErrorDeLimite(horaDeReset(texto));
      return texto;
    }
  } catch (err) {
    if (err instanceof ErrorDeLimite || err instanceof ErrorDeCuenta) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (esDeCuenta(msg)) throw new ErrorDeCuenta(msg);
    if (esDeLimite(msg)) throw new ErrorDeLimite(horaDeReset(msg));
    throw err;
  }
  throw new Error('el stream del SDK termino sin resultado');
}
