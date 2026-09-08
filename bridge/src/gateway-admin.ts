/**
 * Las rutas del gateway que solo el bridge puede llamar.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-08-deploy-render-design.md`.
 *
 * Van con `GATEWAY_ADMIN_TOKEN` y no con `GATEWAY_TOKEN`, y esa es toda la
 * razon por la que existe este archivo aparte: el agente TIENE un bearer valido
 * del gateway —lo manda en cada herramienta— asi que sin un segundo token
 * `/git/merge` seria una herramienta de merge-a-main disponible para el modelo
 * en cualquier turno.
 */
export interface GatewayAdminDeps {
  gatewayUrl: string;
  /** El de admin. Si falta, no se cablea nada de esto. */
  adminToken: string;
  fetchImpl?: typeof fetch;
}

/** El tope: el merge es git local mas un push, no una espera larga. */
const TOPE_MS = 60_000;

async function pedir(
  path: string,
  cuerpo: unknown,
  deps: GatewayAdminDeps,
): Promise<{ ok: boolean; status: number; texto: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.adminToken}`,
    },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TOPE_MS),
  });
  return { ok: res.ok, status: res.status, texto: await res.text() };
}

/**
 * Mergea la rama del agente a main.
 *
 * `branch` NO se manda: el nombre lo elige el modelo al pushear y el bridge no
 * lo ve nunca —por eso el informe dice `claude/<agente>/*` con asterisco—. El
 * gateway lo resuelve leyendo el HEAD de su propio worktree, que ya esta parado
 * ahi.
 */
export async function mergearEnGateway(
  req: { agent: string; project: string; repo: string; creadoPorElBot: boolean },
  githubToken: string | undefined,
  deps: GatewayAdminDeps,
): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await pedir('/git/merge', { ...req, githubToken }, deps);
    if (r.ok) return { ok: true, output: r.texto };
    // El cuerpo del gateway trae `{ code, message }`; si no parsea, el texto
    // crudo igual dice mas que un "fallo" pelado.
    try {
      const j = JSON.parse(r.texto) as { message?: string };
      return { ok: false, output: j.message ?? r.texto };
    } catch {
      return { ok: false, output: r.texto };
    }
  } catch (err) {
    // Que el gateway no conteste no puede tirar el cierre de la corrida: se
    // devuelve como un merge fallido y el repo queda como pendiente.
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Que hay en el worktree del repo.
 *
 * Ante cualquier duda contesta que SI tiene package.json: el que decide con
 * esto es `publicar()`, y saltear un repo por un error de red seria perder
 * trabajo hecho en silencio. Si el repo de verdad esta vacio, el fallo aparece
 * despues, nombrado, en el pendiente de Render.
 */
export async function inspeccionarRepo(
  req: { agent: string; project: string; repo: string },
  deps: GatewayAdminDeps,
): Promise<{ tienePackageJson: boolean; usaSqlite: boolean }> {
  try {
    const r = await pedir('/repo/inspeccionar', req, deps);
    if (!r.ok) return { tienePackageJson: true, usaSqlite: false };
    const j = JSON.parse(r.texto) as { tienePackageJson?: unknown; usaSqlite?: unknown };
    return {
      tienePackageJson: j.tienePackageJson !== false,
      usaSqlite: j.usaSqlite === true,
    };
  } catch {
    return { tienePackageJson: true, usaSqlite: false };
  }
}
