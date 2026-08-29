import { AgentId } from '@multicodigo/shared';

/**
 * El tope que impone Telegram al callback_data de un boton.
 *
 * No es una recomendacion: pasarse hace que Telegram rechace el teclado entero,
 * asi que el menu no aparece y el error no dice por que.
 */
export const TOPE_CALLBACK_DATA = 64;

/**
 * Prefijos de una letra, y no palabras.
 *
 * Con un uuid de 36 caracteres adentro, cada caracter del prefijo es uno menos
 * de margen contra el tope.
 */
const PROYECTO = 'p';
const AGENTE = 'a';

const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function datosDeProyecto(id: string): string {
  return `${PROYECTO}:${id}`;
}

export function datosDeAgente(slot: AgentId): string {
  return `${AGENTE}:${slot}`;
}

export type MenuData =
  | { kind: 'proyecto'; id: string }
  | { kind: 'agente'; slot: AgentId };

/**
 * Lee lo que trae un boton.
 *
 * Devuelve null y no tira ante cualquier cosa rara: esto llega de la red, y un
 * toque de otro teclado —una aprobacion, un boton viejo de antes de un
 * deploy— es normal, no un error.
 */
export function parseMenuData(data: string): MenuData | null {
  const corte = data.indexOf(':');
  if (corte < 1) return null;

  const prefijo = data.slice(0, corte);
  const resto = data.slice(corte + 1);

  if (prefijo === PROYECTO) {
    return ES_UUID.test(resto) ? { kind: 'proyecto', id: resto } : null;
  }

  if (prefijo === AGENTE) {
    const slot = AgentId.safeParse(resto);
    return slot.success ? { kind: 'agente', slot: slot.data } : null;
  }

  return null;
}
