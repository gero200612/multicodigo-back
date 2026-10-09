/**
 * La API de Coolify del VPS, y nada mas.
 *
 * Ver `docs/superpowers/specs/2026-10-09-punchi-hosting-vps-design.md`.
 *
 * No sabe de corridas, repos ni proyectos de Punchi: eso es `vps.ts`. Este
 * archivo traduce "crear una base", "apagar", "borrar" a HTTP. Mismo corte que
 * `render-api.ts` / `publicar.ts`.
 *
 * Llega por Tailscale (`COOLIFY_URL=http://100.113.60.114:8000`): el panel de
 * Coolify no esta abierto a internet. Probado el 2026-10-09 desde `mc-bridge`.
 *
 * Todo devuelve `{ ok: false, motivo }` en vez de tirar, y el motivo nunca
 * lleva el token: termina en un informe o en el panel.
 *
 * Detalles de Coolify 4.4.3 que se aprendieron probando, no leyendo:
 * - start/stop son POST; con GET contesta 405 "This endpoint has changed".
 * - La base se alcanza desde las apps del mismo servidor con su uuid como host.
 * - `publish_directory` necesita la barra inicial; no se usa: los fronts van
 *   por Dockerfile (Nixpacks trae Node 22.11 y Angular pide >= 22.22).
 */

export interface CoolifyDeps {
  url: string;
  token: string;
  /** El servidor de Coolify donde se crea todo (`localhost` del VPS). */
  servidor: string;
  fetchImpl?: typeof fetch;
}

export type Fallo = { ok: false; motivo: string };
export type Resultado<T = object> = ({ ok: true } & T) | Fallo;

/** El estado de una app o base, como lo dice Coolify: `running:healthy`, `exited:unhealthy`... */
export interface Estado {
  crudo: string;
}

export type TipoDeRecurso = 'applications' | 'databases';

function sinToken(texto: string, token: string): string {
  return token ? texto.split(token).join('***') : texto;
}

async function pedir(
  deps: CoolifyDeps,
  metodo: string,
  ruta: string,
  cuerpo?: unknown,
): Promise<{ ok: true; json: any } | Fallo> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`${deps.url.replace(/\/$/, '')}/api/v1${ruta}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${deps.token}`,
        accept: 'application/json',
        ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const texto = await res.text();
    let json: any;
    try {
      json = texto ? JSON.parse(texto) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const m = json?.message ?? json?.error ?? texto;
      const errores = json?.errors ? ` ${JSON.stringify(json.errors)}` : '';
      return { ok: false, motivo: sinToken(`Coolify ${res.status}: ${String(m).slice(0, 200)}${errores.slice(0, 200)}`, deps.token) };
    }
    return { ok: true, json };
  } catch (err) {
    const m = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code ?? err.message : String(err);
    return { ok: false, motivo: sinToken(`no pude hablar con el VPS (${m})`, deps.token) };
  }
}

export async function crearProyecto(nombre: string, deps: CoolifyDeps): Promise<Resultado<{ uuid: string }>> {
  const r = await pedir(deps, 'POST', '/projects', { name: nombre, description: 'Creado por Punchi' });
  if (!r.ok) return r;
  return r.json?.uuid ? { ok: true, uuid: String(r.json.uuid) } : { ok: false, motivo: 'Coolify no devolvio el uuid del proyecto' };
}

export interface PedidoDeBase {
  proyecto: string;
  nombre: string;
  usuario: string;
  password: string;
  base: string;
}

export async function crearBase(p: PedidoDeBase, deps: CoolifyDeps): Promise<Resultado<{ uuid: string }>> {
  const r = await pedir(deps, 'POST', '/databases/postgresql', {
    server_uuid: deps.servidor,
    project_uuid: p.proyecto,
    environment_name: 'production',
    name: p.nombre,
    postgres_user: p.usuario,
    postgres_password: p.password,
    postgres_db: p.base,
    // Nunca abierta a internet: solo la ve el back por la red interna.
    is_public: false,
    instant_deploy: true,
  });
  if (!r.ok) return r;
  return r.json?.uuid ? { ok: true, uuid: String(r.json.uuid) } : { ok: false, motivo: 'Coolify no devolvio el uuid de la base' };
}

export interface PedidoDeApp {
  proyecto: string;
  nombre: string;
  /** La GitHub App de Coolify que ve la cuenta/org del repo. */
  githubApp: string;
  /** `owner/nombre`. */
  repo: string;
  buildPack: 'dockerfile' | 'nixpacks';
  puerto: number;
  /** `https://...`. */
  dominio: string;
}

export async function crearApp(p: PedidoDeApp, deps: CoolifyDeps): Promise<Resultado<{ uuid: string }>> {
  const r = await pedir(deps, 'POST', '/applications/private-github-app', {
    project_uuid: p.proyecto,
    server_uuid: deps.servidor,
    environment_name: 'production',
    github_app_uuid: p.githubApp,
    git_repository: p.repo,
    git_branch: 'main',
    build_pack: p.buildPack,
    ports_exposes: String(p.puerto),
    domains: p.dominio,
    name: p.nombre,
    // Las variables van antes del primer deploy: una que llega despues no la
    // ve el proceso que ya arranco.
    instant_deploy: false,
  });
  if (!r.ok) return r;
  const uuid = r.json?.uuid ? String(r.json.uuid) : undefined;
  if (!uuid) return { ok: false, motivo: 'Coolify no devolvio el uuid de la app' };
  // Las imagenes de .NET y nginx no traen curl: con el healthcheck prendido
  // Coolify las marca enfermas y no les manda trafico.
  await pedir(deps, 'PATCH', `/applications/${uuid}`, { health_check_enabled: false });
  return { ok: true, uuid };
}

/** Los nombres de las variables que ya tiene una app (sin los valores). */
export async function variablesDe(uuid: string, deps: CoolifyDeps): Promise<Resultado<{ claves: string[] }>> {
  const r = await pedir(deps, 'GET', `/applications/${uuid}/envs`);
  if (!r.ok) return r;
  const lista: { key?: string; is_preview?: boolean }[] = Array.isArray(r.json) ? r.json : [];
  return { ok: true, claves: lista.filter((e) => !e.is_preview && e.key).map((e) => e.key!) };
}

/**
 * Setea variables sin borrar las demas. `soloSiFaltan` no pisa claves que ya
 * estan (la `Jwt__Key`: regenerarla en cada deploy cerraria todas las sesiones).
 */
export async function setearVariables(
  uuid: string,
  vars: Record<string, string>,
  deps: CoolifyDeps,
  soloSiFaltan: readonly string[] = [],
): Promise<Resultado> {
  let claves = Object.keys(vars);
  if (soloSiFaltan.length > 0) {
    const ya = await variablesDe(uuid, deps);
    if (!ya.ok) return ya;
    claves = claves.filter((k) => !(soloSiFaltan.includes(k) && ya.claves.includes(k)));
  }
  if (claves.length === 0) return { ok: true };
  const r = await pedir(deps, 'PATCH', `/applications/${uuid}/envs/bulk`, {
    data: claves.map((k) => ({ key: k, value: vars[k]!, is_preview: false, is_literal: true })),
  });
  return r.ok ? { ok: true } : r;
}

/** Encola un deploy de lo que hay en `main`. Devuelve el id del deploy para seguirlo. */
export async function desplegar(uuid: string, deps: CoolifyDeps): Promise<Resultado<{ despliegue?: string }>> {
  const r = await pedir(deps, 'POST', `/deploy?uuid=${encodeURIComponent(uuid)}`);
  if (!r.ok) return r;
  const d = r.json?.deployments?.[0]?.deployment_uuid;
  return { ok: true, ...(d ? { despliegue: String(d) } : {}) };
}

/** `queued` | `in_progress` | `finished` | `failed` | `cancelled-by-user`. */
export async function estadoDeDespliegue(id: string, deps: CoolifyDeps): Promise<Resultado<{ estado: string; log?: string }>> {
  const r = await pedir(deps, 'GET', `/deployments/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  let log: string | undefined;
  if (r.json?.status === 'failed' && typeof r.json?.logs === 'string') {
    // Los logs son una lista JSON de lineas; las ultimas visibles alcanzan.
    try {
      const lineas: { output?: string; hidden?: boolean }[] = JSON.parse(r.json.logs);
      log = lineas
        .filter((l) => !l.hidden && l.output)
        .slice(-4)
        .map((l) => l.output!.trim())
        .join(' | ')
        .slice(0, 300);
    } catch {
      log = undefined;
    }
  }
  return { ok: true, estado: String(r.json?.status ?? 'desconocido'), ...(log ? { log: sinToken(log, deps.token) } : {}) };
}

export async function estadoDe(tipo: TipoDeRecurso, uuid: string, deps: CoolifyDeps): Promise<Resultado<Estado>> {
  const r = await pedir(deps, 'GET', `/${tipo}/${uuid}`);
  if (!r.ok) return r;
  return { ok: true, crudo: String(r.json?.status ?? '') };
}

export async function prender(tipo: TipoDeRecurso, uuid: string, deps: CoolifyDeps): Promise<Resultado> {
  const r = await pedir(deps, 'POST', `/${tipo}/${uuid}/start`);
  return r.ok ? { ok: true } : r;
}

export async function apagar(tipo: TipoDeRecurso, uuid: string, deps: CoolifyDeps): Promise<Resultado> {
  const r = await pedir(deps, 'POST', `/${tipo}/${uuid}/stop`);
  return r.ok ? { ok: true } : r;
}

/** Borra la app o la base CON sus volumenes: los datos no vuelven. */
export async function borrar(tipo: TipoDeRecurso, uuid: string, deps: CoolifyDeps): Promise<Resultado> {
  const r = await pedir(
    deps,
    'DELETE',
    `/${tipo}/${uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`,
  );
  // Ya no estaba: el resultado que se buscaba.
  if (!r.ok && /Coolify 404/.test(r.motivo)) return { ok: true };
  return r.ok ? { ok: true } : r;
}

export async function borrarProyecto(uuid: string, deps: CoolifyDeps): Promise<Resultado> {
  const r = await pedir(deps, 'DELETE', `/projects/${uuid}`);
  if (!r.ok && /Coolify 404/.test(r.motivo)) return { ok: true };
  return r.ok ? { ok: true } : r;
}

export interface AppDelVps {
  uuid: string;
  nombre: string;
  dominios: string[];
  estado: string;
}

/** Todo lo que corre en el VPS, para mostrar lo que no es de Punchi y para no repetir dominios. */
export async function listarApps(deps: CoolifyDeps): Promise<Resultado<{ apps: AppDelVps[] }>> {
  const r = await pedir(deps, 'GET', '/applications');
  if (!r.ok) return r;
  const lista: any[] = Array.isArray(r.json) ? r.json : [];
  return {
    ok: true,
    apps: lista.map((a) => ({
      uuid: String(a.uuid),
      nombre: String(a.name ?? ''),
      dominios: String(a.fqdn ?? '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      estado: String(a.status ?? ''),
    })),
  };
}
