import type { AgentId, ApprovalDecision } from '@multicodigo/shared';
import type { Store } from './store.js';

export type Desde = 'telegram' | 'panel';

export interface DecidirDeps {
  store: Store;
  send: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  /** Refleja la decision en el mensaje del chat. Puede fallar sin consecuencias. */
  editarMensaje: (chatId: number, messageId: number, texto: string) => Promise<void>;
}

export interface Decision {
  approvalId: string;
  decision: ApprovalDecision;
  usuarioId?: string;
  desde: Desde;
}

export type ResultadoDecision = 'ok' | 'ya_decidida' | 'desconocida';

/**
 * El unico camino por el que se decide una aprobacion.
 *
 * Existe para que haya UNO. Con dos —el boton de Telegram por un lado y el
 * panel por otro— el dia que cambie la regla va a cambiar en uno solo, y la
 * diferencia se va a notar cuando alguien apruebe desde el lugar equivocado.
 */
export async function decidir(deps: DecidirDeps, d: Decision): Promise<ResultadoDecision> {
  // El registro se lee ANTES del claim: hace falta el chat y el mensaje, y
  // leerlo primero deja un solo camino de lectura en vez de uno por rama.
  const registro = await deps.store.getApproval(d.approvalId);
  if (!registro) return 'desconocida';

  // El claim es la transicion atomica de NULL a no-NULL. Es lo que hace que
  // tocar tres veces cuente una, y ahora tambien que tocarlo en los dos
  // lugares cuente una.
  const r = await deps.store.claimApproval(d.approvalId, d.decision, {
    usuarioId: d.usuarioId,
    desde: d.desde,
  });

  if (r === 'unknown') return 'desconocida';
  if (r === 'already_decided') return 'ya_decidida';

  // El turno vuelve a correr: tanto aprobar como rechazar lo desbloquean —con
  // deny el agente sigue vivo hasta que decida cerrar—. `setJobStatus` no
  // reabre un job ya cerrado, asi que una decision que llega tarde no lo revive.
  await deps.store.setJobStatus(registro.jobId, 'running');

  // Primero el gateway: es el que tiene al agente esperando.
  await deps.send(registro.agent, d.approvalId, d.decision);

  // Y despues el mensaje. Si esto falla —mensaje viejo, chat borrado— la
  // decision ya se tomo y el agente ya siguio: volver atras seria deshacer
  // algo que ya paso. Se traga a proposito.
  try {
    const quien = d.desde === 'panel' ? 'desde el panel' : 'aca';
    await deps.editarMensaje(
      registro.chatId,
      registro.messageId,
      `${textoDeDecision(d.decision)} ${quien}.`,
    );
  } catch {
    // Sin log ruidoso: es esperable con mensajes de mas de 48 horas, que
    // Telegram no deja editar.
  }

  return 'ok';
}

function textoDeDecision(d: ApprovalDecision): string {
  if (d.decision === 'allow') return '✅ Aprobado';
  return d.feedback ? '💬 Rechazado con comentario' : '❌ Rechazado';
}
