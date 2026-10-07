import { randomBytes } from 'node:crypto';
import type { ClienteDeGateway } from './gateway.js';
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

export interface OpcionesDeIa {
  sistema: string;
  modelo?: string;
  gateway: ClienteDeGateway;
}

/**
 * Le pide a Claude un texto, en un solo turno y SIN herramientas.
 *
 * Corre en el fondo comun de cuentas, igual que los agentes: Homero ya no tiene
 * cuenta propia. Sin herramientas es la defensa principal cuando el prompt lleva
 * texto de terceros: el modelo solo puede devolver texto, y lo que se hace con
 * ese texto lo decide este proceso.
 *
 * Los errores llegan del gateway ya traducidos: sin uso en todas las cuentas es
 * un `ErrorDeLimite` (con la hora de vuelta), y sin cuenta libre un `SinLugar`.
 */
export async function pedirTexto(prompt: string, o: OpcionesDeIa): Promise<string> {
  const r = await o.gateway.correr({
    corrida: `t${randomBytes(9).toString('hex')}`,
    // El token no se usa (sin herramientas no hay MCP), pero el contrato lo pide.
    tokenCorrida: randomBytes(24).toString('base64url'),
    sistema: o.sistema,
    objetivo: prompt,
    herramientas: [],
    web: false,
    maxTurnos: 1,
    maxMinutos: 5,
    modelo: o.modelo,
  });
  return r.texto;
}
