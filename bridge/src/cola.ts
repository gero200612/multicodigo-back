/**
 * La cola de trabajo: todo lo que hay que hacer, dictado de una.
 *
 * Nace de que encargar cinco cosas obligaba a esperar cada una para mandar la
 * siguiente. Ahora se manda la lista entera y el bot la recorre solo.
 *
 * ## Que NO hace
 *
 * No corre dos tareas a la vez. Podria —hay varios agentes— pero una cola que
 * reparte trabajo entre slots es otra cosa: las tareas de una lista suelen
 * depender del resultado de la anterior ("arregla el bug", "corre los tests"),
 * y hacerlas en paralelo sobre el mismo worktree es pisarse.
 *
 * Tampoco reintenta. Si una falla, la cola se detiene y avisa: seguir con la
 * siguiente cuando la anterior no salio es hacer trabajo sobre una base que
 * nadie miro.
 */

/** Lo que se le saca al principio de una linea: viñetas y numeracion. */
const VINETA = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Parte un mensaje de varias lineas en tareas, una por linea.
 *
 * Las viñetas se sacan porque una lista se escribe con guiones sin pensarlo, y
 * si el prefijo queda, al agente le llega "- arregla el stock" y lo lee como
 * parte del pedido. Solo al PRINCIPIO de la linea: un guion en el medio es
 * parte de la frase ("auto-guardado").
 */
export function partirEnTareas(texto: string): string[] {
  return texto
    .split('\n')
    .map((l) => l.replace(VINETA, '').trim())
    .filter((l) => l !== '');
}

/** Una tarea de la cola. */
export interface Tarea {
  id: string;
  chatId: number;
  agente: string;
  proyecto: string;
  texto: string;
  posicion: number;
  estado: 'pendiente' | 'corriendo' | 'lista' | 'fallida' | 'cancelada';
  resultado?: string;
}

/** Lo que hace falta para encolar una tanda. */
export interface Encargo {
  agente: string;
  proyecto: string;
  textos: string[];
}
