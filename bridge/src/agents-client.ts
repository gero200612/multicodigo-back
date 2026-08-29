import { PromptResponse, type PromptRequest } from '@multicodigo/shared';

export interface AgentsClientDeps {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export async function askAgent(
  req: PromptRequest,
  deps: AgentsClientDeps,
): Promise<PromptResponse> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/agents/${req.agent}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(11 * 60 * 1000),
  });

  const text = await response.text();
  if (!response.ok) {
    const code = (() => {
      try {
        return (JSON.parse(text) as { code?: string }).code ?? 'internal';
      } catch {
        return 'internal';
      }
    })();
    throw new Error(code);
  }
  return PromptResponse.parse(JSON.parse(text));
}

/**
 * Que slots existen y cuales estan arriba, segun el gateway.
 *
 * El bridge lo usa solo para pintar el menu: el registro de que agente es de
 * que proyecto vive en la base, y el de que contenedores existen lo contesta
 * Docker del otro lado. Aca solo interesa el `arriba`.
 */
export async function listarAgentes(
  deps: AgentsClientDeps,
): Promise<{ id: string; arriba: boolean; cuenta: boolean }[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/agents`, {
    headers: { authorization: `Bearer ${deps.token}` },
    // Corto: esto lo espera una persona mirando el chat. Un gateway lento no
    // puede dejar el menu colgado, y el llamador ya sabe caerse a "apagados".
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('agent_unavailable');

  const cuerpo = (await res.json()) as {
    agents?: { id: string; arriba: boolean; cuenta?: boolean }[];
  };
  // `cuenta` puede faltar si el gateway todavia es una version anterior. Se
  // asume que no la tiene: un boton que no anda es peor que uno que avisa.
  return (cuerpo.agents ?? []).map((a) => ({ ...a, cuenta: a.cuenta === true }));
}
