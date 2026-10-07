import { request as pedirHttp } from 'node:http';
import { request as pedirHttps } from 'node:https';
import { ErrorDeLimite } from './ia.js';
import type { Paso } from './store.js';

/**
 * El cliente del gateway: Homero ya no tiene cuentas de Claude propias.
 *
 * Las cuentas son un fondo comun de todos los bots y el gateway es el unico
 * proceso que las usa. Homero le pide "corré este agente" y el gateway elige
 * una cuenta libre (dejando siempre una para Punchi) y, si se queda sin uso a
 * mitad de camino, sigue en otra.
 */

export interface PedidoDeCorrida {
  /** El id con el que el MCP de Homero reconoce la corrida. */
  corrida: string;
  tokenCorrida: string;
  sistema: string;
  objetivo: string;
  /** Las herramientas de Homero que ve el agente, por nombre corto. */
  herramientas: string[];
  web: boolean;
  maxTurnos: number;
  maxMinutos: number;
  modelo?: string;
}

export interface RespuestaDeCorrida {
  texto: string;
  turnos: number;
  pasos: Paso[];
  /** Termino por tope de turnos o de reloj, no porque el agente cerro. */
  cortada?: 'turnos' | 'tiempo';
  slot?: string;
}

/** No hay una cuenta libre ahora (Punchi las esta usando). No es culpa de nadie. */
export class SinLugar extends Error {
  constructor() {
    super('sin_lugar');
    this.name = 'SinLugar';
  }
}

export interface ClienteDeGateway {
  correr(p: PedidoDeCorrida): Promise<RespuestaDeCorrida>;
}

/**
 * POST con `node:http` y no con `fetch`, a proposito.
 *
 * Una corrida tarda hasta quince minutos y el gateway no contesta nada hasta
 * que termina. El `fetch` de Node corta a los 300 s por `headersTimeout` de
 * undici sin importar el `AbortSignal` (ver `bridge/src/dispatcher.ts`, el
 * mismo bug medido en produccion). `http.request` no tiene ese techo: el unico
 * es el que se pone aca.
 */
function postJson(
  url: string,
  token: string,
  cuerpo: unknown,
  techoMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const destino = new URL(url);
    const datos = Buffer.from(JSON.stringify(cuerpo));
    const pedir = destino.protocol === 'https:' ? pedirHttps : pedirHttp;
    const req = pedir(
      destino,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': datos.length,
          authorization: `Bearer ${token}`,
        },
        timeout: techoMs,
      },
      (res) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(partes).toString('utf8')) as Record<string, unknown>;
          } catch {
            // Un cuerpo que no es JSON se trata como vacio: el status alcanza.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('el gateway no contesto a tiempo')));
    req.on('error', reject);
    req.end(datos);
  });
}

export function clienteDeGateway(
  cfg: { url: string; token: string },
  post: typeof postJson = postJson,
): ClienteDeGateway {
  return {
    async correr(p) {
      // El techo de la corrida, mas el del gateway, mas un margen para cerrar.
      const techo = (p.maxMinutos + 5) * 60_000;
      const { status, json } = await post(`${cfg.url.replace(/\/$/, '')}/comercial/corrida`, cfg.token, p, techo);
      if (status === 200) {
        return {
          texto: typeof json.texto === 'string' ? json.texto : '',
          turnos: typeof json.turnos === 'number' ? json.turnos : 0,
          pasos: Array.isArray(json.pasos) ? (json.pasos as Paso[]) : [],
          cortada: json.cortada === 'turnos' || json.cortada === 'tiempo' ? json.cortada : undefined,
          slot: typeof json.slot === 'string' ? json.slot : undefined,
        };
      }
      if (json.code === 'sin_lugar') throw new SinLugar();
      if (json.code === 'sin_uso') {
        const resets = Array.isArray(json.resets) ? (json.resets as unknown[]) : [];
        throw new ErrorDeLimite(typeof resets[0] === 'string' ? resets[0] : undefined);
      }
      throw new Error(`el gateway devolvio ${status}: ${String(json.code ?? '')} ${String(json.message ?? '')}`.trim());
    },
  };
}
