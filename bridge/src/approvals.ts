import { PendingApprovalsResponse, type AgentId, type ApprovalDecision, type ApprovalRequest } from '@multicodigo/shared';

export interface WatchDeps {
  fetchPending: () => Promise<ApprovalRequest[]>;
  announce: (a: ApprovalRequest) => Promise<void>;
  /** Ids ya anunciados. Se pasa desde afuera para que el llamador lo comparta entre pasadas. */
  seen: Set<string>;
}

/**
 * Una pasada del poller.
 *
 * Nunca tira: el turno del hijo sigue corriendo del otro lado y una pasada
 * que explota no puede matar el loop. Un `announce` que falla NO marca la
 * aprobacion como vista, asi que la proxima pasada la reintenta — es la
 * diferencia entre "Telegram estuvo caido dos segundos" y "el usuario nunca
 * se entera de que el agente esta esperando".
 */
export async function tickApprovals(deps: WatchDeps): Promise<void> {
  let pendientes: ApprovalRequest[];
  try {
    pendientes = await deps.fetchPending();
  } catch {
    return;
  }

  for (const a of pendientes) {
    if (deps.seen.has(a.approvalId)) continue;
    try {
      await deps.announce(a);
      deps.seen.add(a.approvalId);
    } catch {
      // se reintenta en la proxima pasada
    }
  }
}

export function startWatching(deps: WatchDeps, intervalMs: number): () => void {
  const timer = setInterval(() => void tickApprovals(deps), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface GatewayApprovalsDeps {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export async function fetchPending(
  agent: AgentId,
  deps: GatewayApprovalsDeps,
): Promise<ApprovalRequest[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(
    `${deps.gatewayUrl.replace(/\/$/, '')}/agents/${agent}/approvals/pending`,
    { headers: { authorization: `Bearer ${deps.token}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`el gateway devolvio ${res.status}`);
  return PendingApprovalsResponse.parse(await res.json()).pending;
}

export async function sendDecision(
  agent: AgentId,
  approvalId: string,
  decision: ApprovalDecision,
  deps: GatewayApprovalsDeps,
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(
    `${deps.gatewayUrl.replace(/\/$/, '')}/agents/${agent}/approvals/${approvalId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
      body: JSON.stringify(decision),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`el gateway devolvio ${res.status}`);
}
