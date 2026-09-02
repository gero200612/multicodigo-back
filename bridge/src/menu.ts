import { AgentId } from '@multicodigo/shared';
import type { Boton } from './render.js';
import type { Proyecto, AgenteResumen } from './store.js';

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
/**
 * "Volver a mostrarme el menu".
 *
 * No lleva nada adentro: el menu se arma con el usuario del chat, que sale del
 * vinculo y no del boton. Un id ahi seria un dato que viene del cliente para
 * algo que ya sabemos de este lado.
 */
const MENU = 'm';

const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function datosDeProyecto(id: string): string {
  return `${PROYECTO}:${id}`;
}

export function datosDeAgente(slot: AgentId): string {
  return `${AGENTE}:${slot}`;
}

export function datosDeMenu(): string {
  return `${MENU}:`;
}

export type MenuData =
  | { kind: 'proyecto'; id: string }
  | { kind: 'agente'; slot: AgentId }
  | { kind: 'menu' };

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

  // Se exige que no traiga nada: `m:` y solo eso. Aceptar `m:loquesea` seria
  // dejar entrar un dato que nadie lee, y el dia que alguien lo lea ya venia
  // del cliente.
  if (prefijo === MENU) {
    return resto === '' ? { kind: 'menu' } : null;
  }

  return null;
}

export interface AgenteConEstado extends AgenteResumen {
  arriba: boolean;
  tieneCuenta: boolean;
  /**
   * La cuenta esta sin tokens, y hasta cuando.
   *
   * Ausente = tiene tokens, hasta donde se sabe. La marca la escribe el turno
   * que se topo con el limite; no hay forma de preguntarle a Anthropic cuanto
   * queda, asi que esto es lo unico que se sabe.
   */
  agotado?: { resets?: string };
  /** Lo esta usando otra persona ahora mismo. */
  ocupado?: boolean;
}

/** Un dato que no matchea ningun prefijo: el boton existe y no hace nada. */
const INERTE = 'x:';

export function tecladoDeProyectos(proyectos: Proyecto[]): Boton[][] {
  // Uno por fila: los nombres de proyecto son largos y dos por fila se cortan
  // en la pantalla de un celular.
  return proyectos.map((p) => [{ label: p.nombre, data: datosDeProyecto(p.id) }]);
}

export function tecladoDeAgentes(agentes: AgenteConEstado[]): Boton[][] {
  return agentes.map((a) => {
    // El orden importa: primero "no tiene cuenta", despues "no tiene tokens".
    // Un slot sin cuenta cargada tampoco puede estar agotado, y si las dos
    // marcas compitieran, la de tokens taparia la que dice que hacer.
    // "Ocupado" va despues de "sin tokens" y antes de arriba/apagado: es un
    // impedimento, asi que tapa al estado del contenedor, pero es el unico que
    // se resuelve solo —hay que esperar, no hay que ir a arreglar nada—, asi
    // que no puede tapar a los que si mandan a hacer algo.
    const marca = !a.tieneCuenta
      ? '⚠'
      : a.agotado
        ? '⛔'
        : a.ocupado
          ? '🔒'
          : a.arriba
            ? '●'
            : '○';
    const nombre = a.nombre ?? a.slot.toUpperCase();

    // La hora del reset en el boton y no solo en la leyenda: es lo que decide
    // si conviene esperar o cambiar de agente, y en la leyenda seria una nota
    // al pie que no dice de cual de los seis habla.
    const cola = a.agotado
      ? ` — sin tokens${a.agotado.resets ? `, vuelve ${a.agotado.resets}` : ''}`
      : a.ocupado
        ? ' — lo esta usando otro'
        : '';

    return [
      {
        label: `${marca} ${nombre}${cola}`,
        // Un slot sin cuenta lleva a un turno que falla con sin_credencial, y
        // uno agotado a un turno que falla con usage_limit. En los dos casos el
        // boton no hace nada y la etiqueta explica por que: hacer perder un
        // turno para llegar a un error que ya sabemos es lo que esto arregla.
        // Un slot ocupado tampoco lleva a ningun lado: el turno chocaria con
        // un 409 y la etiqueta ya explica por que. Es el mismo criterio que
        // con el slot sin cuenta y el agotado.
        data: a.tieneCuenta && !a.agotado && !a.ocupado ? datosDeAgente(a.slot) : INERTE,
      },
    ];
  });
}
