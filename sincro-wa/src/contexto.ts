import { descifrar } from './cifrado.js';
import type { Despertador } from './eventos.js';
import type { ClienteMeta } from './meta.js';
import type { Numero, Store } from './store.js';

/** Hace el POST de un evento a la app. True si contesto 2xx. */
export type Push = (url: string, cuerpo: string, firma: string) => Promise<boolean>;

/**
 * Todo lo que usan las piezas del bot, junto. Los tests arman uno con la base
 * en memoria, un Meta falso y un reloj que controlan.
 */
export interface Contexto {
  store: Store;
  meta: ClienteMeta;
  ahora: () => Date;
  claveCifrado: Buffer;
  /** El del system user: lo usan los numeros sin token propio. */
  tokenMeta: string;
  despertador: Despertador;
  push: Push;
  log: (texto: string) => void;
}

export function tokenDe(ctx: Contexto, numero: Numero): string {
  return numero.tokenCifrado ? descifrar(ctx.claveCifrado, numero.tokenCifrado) : ctx.tokenMeta;
}

export const pushConFetch: Push = async (url, cuerpo, firma) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sincro-firma': firma },
      body: cuerpo,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
};
