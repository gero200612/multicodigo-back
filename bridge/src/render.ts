import type { ApprovalRequest } from '@multicodigo/shared';

export interface Boton {
  label: string;
  data: string;
}

export type BotonKind = 'ok' | 'no' | 'ex';

const PREFIJOS: Record<BotonKind, string> = { ok: 'ok', no: 'no', ex: 'ex' };

/**
 * `callback_data` de un boton.
 *
 * Lleva el approvalId adentro a proposito: es lo que hace que un boton de un
 * mensaje viejo, o tres toques seguidos, se resuelvan contra la MISMA
 * aprobacion y el store los pueda descartar. Un boton sin id dependeria de
 * "cual es la aprobacion actual", que es justo lo que se rompe cuando hay dos.
 *
 * `ok:` + un uuid son 39 bytes; Telegram permite 64.
 */
export function approvalData(kind: BotonKind, approvalId: string): string {
  return `${PREFIJOS[kind]}:${approvalId}`;
}

export function parseApprovalData(data: string): { kind: BotonKind; approvalId: string } | null {
  const m = /^(ok|no|ex):([0-9a-fA-F-]{36})$/.exec(data);
  // Los dos grupos son obligatorios en el patron, asi que si hubo match
  // existen; el chequeo explicito es para no mentirle al tipo con un `!`.
  const kind = m?.[1];
  const approvalId = m?.[2];
  if (!kind || !approvalId) return null;
  return { kind: kind as BotonKind, approvalId };
}

export function renderApproval(a: ApprovalRequest): { text: string; buttons: Boton[][] } {
  // Una tarea de build tarda y hace cola: decirlo baja la ansiedad de mirar un
  // mensaje que no se mueve por dos minutos.
  const esRun = a.tool === 'mcp__multicodigo__run';
  const nota = esRun
    ? 'Puede tardar: hay un solo turno de build para toda la maquina.'
    : 'Tenes 15 minutos para contestar; despues lo cancelo solo.';

  const text = [`🔐 ${a.agent.toUpperCase()} pide permiso`, '', a.summary, '', nota].join('\n');

  return {
    text,
    buttons: [
      [
        { label: '✅ Aprobar', data: approvalData('ok', a.approvalId) },
        { label: '❌ Rechazar', data: approvalData('no', a.approvalId) },
      ],
      [{ label: '💬 Rechazar y explicar', data: approvalData('ex', a.approvalId) }],
    ],
  };
}
