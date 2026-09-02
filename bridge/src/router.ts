import { AgentId } from '@multicodigo/shared';

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
  /** Pide un codigo para atar este chat a una cuenta del panel. */
  | { kind: 'vincular' }
  /** Vuelve al principio: elegir proyecto y agente. */
  | { kind: 'menu' }
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

  if (command === 'cowork') {
    if (rest === '') return { kind: 'cowork', agent: undefined };
    const a = AgentId.safeParse(rest.toLowerCase());
    // Un argumento que no es un agente NO es un cowork fallido: se trata como
    // texto comun, igual que /proyecto. Mismo criterio, misma razon.
    return a.success ? { kind: 'cowork', agent: a.data } : { kind: 'prompt', agent: undefined, text };
  }

  // /start es lo primero que manda Telegram cuando alguien abre el bot, asi
  // que tiene que llevar al mismo lugar que /menu.
  if (command === 'start' || command === 'menu') return { kind: 'menu' };

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
