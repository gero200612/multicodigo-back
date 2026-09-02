import { AgentId } from '@multicodigo/shared';
import { MODOS_PERMISO, CLAVES_DE_MODELO, type ModoPermiso, type ClaveDeModelo } from './store.js';

export type ParsedCommand =
  | { kind: 'prompt'; agent: AgentId | undefined; text: string }
  | { kind: 'switch'; agent: AgentId }
  /** Con `project` cambia el proyecto activo; sin el, pregunta cual es. */
  | { kind: 'project'; project: string | undefined }
  | { kind: 'status' }
  /**
   * Trabajar con mas de un agente en el mismo chat.
   *
   * Con `agent` lo suma o lo saca de la lista; sin el, la muestra. Es un toggle
   * y no un par de comandos: sumar y sacar son la misma decision vista dos
   * veces, y el estado ya se ve en la respuesta.
   */
  | { kind: 'cowork'; agent: AgentId | undefined }
  /**
   * Cuanto quiere que se le pregunte antes de actuar.
   *
   * Sin `modo` muestra el actual con botones para cambiarlo. Con botones y no
   * escribiendo el nombre: son tres opciones fijas y elegir de una lista no se
   * escribe mal.
   */
  | { kind: 'permisos'; modo: ModoPermiso | undefined }
  /** Con que modelo escribe la IA. Sin `modelo`, muestra el actual. */
  | { kind: 'modelo'; modelo: ClaveDeModelo | undefined }
  /**
   * La cola de trabajo.
   *
   * Con texto, encola una tarea por linea. Sin texto, muestra como va. El
   * texto se guarda CRUDO —con sus saltos— y lo parte `partirEnTareas`: el
   * router decide que comando es, no que hay adentro.
   */
  | { kind: 'cola'; texto: string }
  /** Corta lo que queda por hacer. */
  | { kind: 'cola_cancelar' }
  /** Pide un codigo para atar este chat a una cuenta del panel. */
  | { kind: 'vincular' }
  /**
   * El menu principal: que queres hacer.
   *
   * `saluda` distingue `/start` de `/menu`. Antes eran lo mismo y los dos
   * llevaban al selector de agentes; ahora `/start` se presenta —es lo primero
   * que manda Telegram cuando alguien abre el bot y no sabe que es— y `/menu`
   * no, porque repetir la presentacion veinte veces es leer lo mismo veinte
   * veces.
   */
  | { kind: 'menu'; saluda: boolean }
  /** El selector de agentes, que antes era lo que hacia /menu. */
  | { kind: 'agentes' }
  | { kind: 'empty' };

/**
 * El nombre del proyecto termina en una ruta de filesystem
 * (`/srv/work/<agente>/<proyecto>`), asi que no puede traer separadores ni
 * puntos sueltos. Mismo criterio que `isSafeProject` en el hijo.
 */
const NOMBRE_PROYECTO = /^[a-zA-Z0-9._-]+$/;

function esNombreValido(n: string): boolean {
  return NOMBRE_PROYECTO.test(n) && n !== '.' && n !== '..';
}

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  const match = /^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: 'prompt', agent: undefined, text };

  const command = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (command === 'status') return { kind: 'status' };

  if (command === 'cola') {
    // `rest` de un /cola multilinea trae los saltos: el regex de arriba captura
    // con [\s\S]*, no con .*, justamente para que una lista sobreviva entera.
    return { kind: 'cola', texto: rest };
  }

  if (command === 'cancelar') return { kind: 'cola_cancelar' };

  if (command === 'modelo' || command === 'modelos') {
    if (rest === '') return { kind: 'modelo', modelo: undefined };
    const m = rest.toLowerCase();
    return (CLAVES_DE_MODELO as readonly string[]).includes(m)
      ? { kind: 'modelo', modelo: m as ClaveDeModelo }
      : { kind: 'prompt', agent: undefined, text };
  }

  if (command === 'permisos') {
    if (rest === '') return { kind: 'permisos', modo: undefined };
    const m = rest.toLowerCase();
    // Igual que /proyecto y /cowork: un argumento que no es un modo se trata
    // como texto comun, porque es mas probable la confusion de comando que el
    // deseo de un modo llamado asi.
    return (MODOS_PERMISO as readonly string[]).includes(m)
      ? { kind: 'permisos', modo: m as ModoPermiso }
      : { kind: 'prompt', agent: undefined, text };
  }

  if (command === 'cowork') {
    if (rest === '') return { kind: 'cowork', agent: undefined };
    const a = AgentId.safeParse(rest.toLowerCase());
    // Un argumento que no es un agente NO es un cowork fallido: se trata como
    // texto comun, igual que /proyecto. Mismo criterio, misma razon.
    return a.success ? { kind: 'cowork', agent: a.data } : { kind: 'prompt', agent: undefined, text };
  }

  // /start es lo primero que manda Telegram cuando alguien abre el bot, asi
  // que lleva al mismo lugar que /menu, pero presentandose: quien lo manda no
  // sabe todavia que es esto.
  if (command === 'start') return { kind: 'menu', saluda: true };
  if (command === 'menu') return { kind: 'menu', saluda: false };

  // El selector de agentes, que es lo que /menu hacia antes. Sigue estando
  // como comando propio porque es la accion mas usada y llegar por el menu
  // seria un toque de mas para lo de siempre.
  if (command === 'agente' || command === 'agentes') return { kind: 'agentes' };

  // Sin argumentos: el codigo lo genera el bot, no lo trae el usuario. Lo que
  // venga atras es ruido.
  if (command === 'vincular') return { kind: 'vincular' };

  if (command === 'proyecto' || command === 'p') {
    if (rest === '') return { kind: 'project', project: undefined };
    // Un nombre invalido NO es un cambio de proyecto fallido: se trata como
    // texto comun. Si alguien escribe "/proyecto que hace el stock", es mas
    // probable que se haya equivocado de comando que que quiera un proyecto
    // llamado asi.
    if (!esNombreValido(rest)) return { kind: 'prompt', agent: undefined, text };
    return { kind: 'project', project: rest };
  }

  const agent = AgentId.safeParse(command);
  if (agent.success) {
    return rest === ''
      ? { kind: 'switch', agent: agent.data }
      : { kind: 'prompt', agent: agent.data, text: rest };
  }

  return { kind: 'prompt', agent: undefined, text };
}
