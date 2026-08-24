import { AgentId } from '@multicodigo/shared';

export type ParsedCommand =
  | { kind: 'prompt'; agent: AgentId | undefined; text: string }
  | { kind: 'switch'; agent: AgentId }
  | { kind: 'status' }
  | { kind: 'empty' };

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  const match = /^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?\s*([\s\S]*)$/.exec(text);
  if (!match) return { kind: 'prompt', agent: undefined, text };

  const command = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (command === 'status') return { kind: 'status' };

  const agent = AgentId.safeParse(command);
  if (agent.success) {
    return rest === ''
      ? { kind: 'switch', agent: agent.data }
      : { kind: 'prompt', agent: agent.data, text: rest };
  }

  return { kind: 'prompt', agent: undefined, text };
}
