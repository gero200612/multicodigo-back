import type { UsoDelVps } from './vps.js';

/**
 * Memoria y disco del VPS, de `mc-uso`: un servicio minimo en el VPS que solo
 * escucha en la IP de Tailscale (Coolify no da memoria libre sin Sentinel, que
 * esta apagado). Ver `docs/vps/mc-uso.py`.
 *
 * Devuelve `undefined` si no responde: sin dato no se frena, se publica igual.
 */
export async function usoDelVps(
  deps: { url: string; token: string; fetchImpl?: typeof fetch },
): Promise<UsoDelVps | undefined> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(`${deps.url.replace(/\/$/, '')}/uso`, {
      headers: { authorization: `Bearer ${deps.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return undefined;
    const j = (await r.json()) as Partial<UsoDelVps>;
    if (typeof j.memDisponibleMb !== 'number' || typeof j.memTotalMb !== 'number') return undefined;
    return {
      memTotalMb: j.memTotalMb,
      memDisponibleMb: j.memDisponibleMb,
      discoTotalGb: Number(j.discoTotalGb ?? 0),
      discoLibreGb: Number(j.discoLibreGb ?? 0),
    };
  } catch {
    return undefined;
  }
}
