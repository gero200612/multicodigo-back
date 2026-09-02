import { AgentId } from '@multicodigo/shared';
import type { Boton } from './render.js';
import { MODOS_PERMISO, type ModoPermiso, type Proyecto, type AgenteResumen } from './store.js';

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
/**
 * Elegir el modo de permisos.
 *
 * Lleva el modo adentro, que es un dato del cliente y por eso se valida contra
 * la lista al leerlo: un `k:loquesea` no puede terminar en un INSERT.
 */
const PERMISO = 'k';
/**
 * Una accion del menu principal.
 *
 * Lleva un verbo corto adentro —`agentes`, `proyectos`— y no un id: son
 * opciones fijas del bot, no filas de una tabla.
 */
const ACCION = 'z';

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

export function datosDePermiso(modo: ModoPermiso): string {
  return `${PERMISO}:${modo}`;
}

/**
 * Las cosas que se pueden hacer desde el menu principal.
 *
 * Es la lista de lo que el bot sabe hacer, dicha en terminos de lo que la
 * persona quiere, no de como esta implementado. `/menu` mostraba directamente
 * los agentes, que es un paso del medio: elegir agente es UNA de estas.
 */
export const ACCIONES = ['agentes', 'proyectos', 'permisos', 'cowork', 'estado'] as const;
export type Accion = (typeof ACCIONES)[number];

export function datosDeAccion(accion: Accion): string {
  return `${ACCION}:${accion}`;
}

/** El menu principal: que queres hacer. */
export function tecladoDeAcciones(): Boton[][] {
  return [
    [{ label: '🤖 Elegir agente', data: datosDeAccion('agentes') }],
    [{ label: '📁 Cambiar de proyecto', data: datosDeAccion('proyectos') }],
    [{ label: '🔐 Permisos', data: datosDeAccion('permisos') }],
    [{ label: '👥 Trabajar con varios', data: datosDeAccion('cowork') }],
    [{ label: '📊 Ver estado', data: datosDeAccion('estado') }],
  ];
}

export type MenuData =
  | { kind: 'proyecto'; id: string }
  | { kind: 'agente'; slot: AgentId }
  | { kind: 'menu' }
  | { kind: 'permiso'; modo: ModoPermiso }
  | { kind: 'accion'; accion: Accion };

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

  if (prefijo === ACCION) {
    return (ACCIONES as readonly string[]).includes(resto)
      ? { kind: 'accion', accion: resto as Accion }
      : null;
  }

  if (prefijo === PERMISO) {
    return (MODOS_PERMISO as readonly string[]).includes(resto)
      ? { kind: 'permiso', modo: resto as ModoPermiso }
      : null;
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

/**
 * Como se llama cada modo delante de una persona.
 *
 * Los nombres dicen QUE pasa y no como se llama el modo por dentro: "aprobar
 * todo" no significa nada hasta que se aclara que git queda afuera, y eso no
 * cabe en la etiqueta de un boton pero si en la del mensaje.
 */
export const NOMBRE_DE_MODO: Record<ModoPermiso, string> = {
  preguntar: 'Preguntar antes de todo',
  ediciones: 'Aprobar ediciones basicas',
  todo: 'Aprobar todo (menos git)',
};

/**
 * Los tres modos como botones, con el actual marcado.
 *
 * El actual se marca y NO se saca de la lista: una lista de dos opciones que
 * cambia segun donde estas obliga a recordar en cual estabas.
 */
export function tecladoDePermisos(actual: ModoPermiso): Boton[][] {
  return MODOS_PERMISO.map((m) => [
    {
      label: `${m === actual ? '◉' : '○'} ${NOMBRE_DE_MODO[m]}`,
      // El actual queda inerte: volver a elegirlo no cambia nada, y un boton
      // que contesta "listo, ya estabas ahi" es ruido.
      data: m === actual ? INERTE : datosDePermiso(m),
    },
  ]);
}

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
