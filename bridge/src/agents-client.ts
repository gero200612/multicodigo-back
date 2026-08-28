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
