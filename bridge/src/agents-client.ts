import { PromptResponse } from '@multicodigo/shared';
import type { PromptConToken } from './pipeline.js';

export interface AgentsClientDeps {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Quien pide el turno.
 *
 * El gateway lo necesita para saber de quien es el slot mientras dura: un slot
 * lo usa una persona a la vez, y el que llega segundo tiene que enterarse de
 * quien lo tiene.
 */
export interface Quien {
  usuarioId?: string;
  chatId?: number;
}

/**
 * Los headers que dicen quien pide el turno.
 *
 * En headers y NO adentro del cuerpo a proposito. El gateway le reenvia el
 * cuerpo al hijo sacando solo `githubToken` por descarte, asi que un campo
 * nuevo ahi terminaria en manos del agente. Un header se queda en el gateway.
 */
function headersDeQuien(quien: Quien | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (quien?.usuarioId) h['x-mc-usuario'] = quien.usuarioId;
  if (quien?.chatId !== undefined) h['x-mc-chat'] = String(quien.chatId);
  return h;
}

export async function askAgent(
  req: PromptConToken,
  deps: AgentsClientDeps,
  quien?: Quien,
): Promise<PromptResponse> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/agents/${req.agent}/prompt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.token}`,
      ...headersDeQuien(quien),
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(11 * 60 * 1000),
  });

  const text = await response.text();
  if (!response.ok) {
    const cuerpo = (() => {
      try {
        return JSON.parse(text) as {
          code?: string;
          resets?: string;
          duenio?: { usuarioId?: string; desde?: number };
        };
      } catch {
        return {};
      }
    })();
    throw new ErrorDelAgente(cuerpo.code ?? 'internal', cuerpo.resets, cuerpo.duenio);
  }
  return PromptResponse.parse(JSON.parse(text));
}

/**
 * El error que devolvio el agente, con lo que traiga de mas.
 *
 * El `message` sigue siendo el codigo pelado —hay codigo que lo compara asi— y
 * los datos extra viajan como propiedades. Meter el reset adentro del message
 * romperia todos esos `=== 'usage_limit'`.
 */
export class ErrorDelAgente extends Error {
  constructor(
    readonly codigo: string,
    /** Cuando vuelve la cuenta, si el agente lo supo decir. Solo en usage_limit. */
    readonly resets?: string,
    /**
     * Quien tiene el slot. Solo en `agente_ocupado`.
     *
     * Llega como `usuarioId` crudo: el gateway no le habla a Supabase y no
     * puede traducirlo. El nombre lo pone el bridge, que si tiene la base.
     */
    readonly duenio?: { usuarioId?: string; desde?: number },
  ) {
    super(codigo);
    this.name = 'ErrorDelAgente';
  }
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
