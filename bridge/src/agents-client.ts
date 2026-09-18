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
): Promise<PromptResponse & { tokens?: number; costoUsd?: number }> {
  const doFetch = deps.fetchImpl ?? fetch;
  // `analisis` sale del cuerpo y viaja como header, por lo mismo que `quien`:
  // el gateway le reenvia el cuerpo al hijo por descarte, y este campo es para
  // el gateway —elige el techo de tiempo— no para el agente.
  const { analisis, ...cuerpo } = req;
  const response = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/agents/${req.agent}/prompt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.token}`,
      ...headersDeQuien(quien),
      ...(analisis ? { 'x-mc-analisis': '1' } : {}),
    },
    body: JSON.stringify(cuerpo),
    // 20 minutos, y el numero no es libre: tiene que ser mayor que el
    // AGENT_TIMEOUT_MS del gateway (18 min), que a su vez es mayor que los 15
    // que el agente espera una aprobacion. El de afuera aguanta mas que el de
    // adentro, o el de afuera convierte una espera legitima en un error de red.
    //
    // Con 11 min este era el segundo eslabon en rendirse: un turno frenado
    // esperando un OK moria aca o en el gateway —los dos por debajo de los 15—
    // y llegaba como "fetch failed".
    // El de un analista es mas largo, y el numero sigue la misma regla: tiene
    // que aguantar mas que el techo del gateway para ese tipo de turno (60 min
    // para analisis, 18 para el resto), o el de afuera convierte un turno
    // legitimo en un error de red. Ver `ANALISIS_TIMEOUT_MS` alla.
    signal: AbortSignal.timeout(analisis ? 62 * 60 * 1000 : 20 * 60 * 1000),
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
  const crudo = JSON.parse(text) as { tokens?: unknown; costoUsd?: unknown };
  // `parse` valida el contrato y DESCARTA lo que no declara, asi que el consumo
  // se lee del cuerpo crudo. Va al lado y no adentro porque el contrato vive en
  // un paquete publicado por tag; ver el comentario del agente.
  return {
    ...PromptResponse.parse(crudo),
    tokens: typeof crudo.tokens === 'number' ? crudo.tokens : undefined,
    costoUsd: typeof crudo.costoUsd === 'number' ? crudo.costoUsd : undefined,
  };
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
): Promise<{ id: string; arriba: boolean; cuenta: boolean; ocupado: boolean }[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/agents`, {
    headers: { authorization: `Bearer ${deps.token}` },
    // Corto: esto lo espera una persona mirando el chat. Un gateway lento no
    // puede dejar el menu colgado, y el llamador ya sabe caerse a "apagados".
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('agent_unavailable');

  const cuerpo = (await res.json()) as {
    agents?: {
      id: string;
      arriba: boolean;
      cuenta?: boolean;
      ocupado?: { usuarioId?: string; desde?: number };
    }[];
  };
  // `cuenta` puede faltar si el gateway todavia es una version anterior. Se
  // asume que no la tiene: un boton que no anda es peor que uno que avisa.
  // `ocupado` llega como el dueño o nada. Aca se aplana a un booleano: quien
  // pinta el menu solo necesita saber si se puede elegir, y el nombre del dueño
  // se resuelve recien cuando hace falta mostrarlo.
  return (cuerpo.agents ?? []).map((a) => ({
    ...a,
    cuenta: a.cuenta === true,
    ocupado: a.ocupado !== undefined && a.ocupado !== null,
  }));
}

/**
 * Espera a que el gateway conteste, antes de pedirle nada.
 *
 * `actualizar.sh` reconstruye el stack entero y los contenedores no vuelven
 * todos juntos. El bridge es de los primeros, y `retomarCorridas` se pone a
 * trabajar apenas arranca: le pide un turno a un gateway que todavia no existe.
 *
 * Medido en el deploy del 2026-09-18:
 *
 *   22:10:45  mc-bridge      arranca y retoma la corrida
 *   22:11:01  mc-dockerproxy todavia recreandose
 *   22:11:15  el bridge pide el primer turno
 *   22:11:21  mc-gateway     se recrea SEIS SEGUNDOS DESPUES del turno
 *   22:11:24  corrida cerrada por demasiados_fallos
 *
 * Tres fallos de entorno —`agent_start_failed` y dos `unknown_agent`— en nueve
 * segundos, y la noche entera perdida por catorce segundos de arranque.
 *
 * Con tope, y por eso devuelve un booleano en vez de esperar para siempre: un
 * gateway que no vuelve es algo que hay que ir a mirar, y el que llama tiene
 * que poder DECIRLO en vez de quedarse callado hasta la mañana.
 */
export async function esperarAlGateway(
  deps: AgentsClientDeps,
  opciones: { intentos?: number; esperaMs?: number } = {},
): Promise<boolean> {
  const intentos = opciones.intentos ?? 30;
  const esperaMs = opciones.esperaMs ?? 2000;
  const doFetch = deps.fetchImpl ?? fetch;

  for (let i = 0; i < intentos; i++) {
    try {
      // `/health` y no `/agents`: no necesita el bearer ni toca los slots, asi
      // que contesta apenas el proceso escucha. Es justo lo que se pregunta.
      const r = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return true;
    } catch {
      // Todavia no esta. No se loguea cada intento: el arranque normal tiene
      // varios y llenarian el log de ruido que no dice nada.
    }
    if (i < intentos - 1) await new Promise((r) => setTimeout(r, esperaMs));
  }
  return false;
}
