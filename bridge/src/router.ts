import { AgentId } from '@multicodigo/shared';

export type ParsedCommand =
  | { kind: 'prompt'; agent: AgentId | undefined; text: string }
  | { kind: 'switch'; agent: AgentId }
  /** Con `project` cambia el proyecto activo; sin el, pregunta cual es. */
  | { kind: 'project'; project: string | undefined }
  | { kind: 'status' }
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
