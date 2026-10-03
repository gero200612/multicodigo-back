import { crearServicio, dispararDeploy } from './render-api.js';
import type { Proveedor } from './store.js';

/**
 * Publicar en la app que eligio cada persona: Render, Vercel, Netlify o
 * Railway, con SU token.
 *
 * Tres operaciones por proveedor, y nada mas:
 *
 * - `verificar`: al conectar. Prueba el token contra la API y trae el nombre
 *   de la cuenta para mostrarlo. Un token que no anda no se guarda.
 * - `vincular`: la primera vez que se publica un repo. Crea del lado del
 *   proveedor el servicio/proyecto/sitio ATADO AL REPO DE GITHUB, en `main`.
 * - `desplegar`: las siguientes. Pide un deploy de lo que hay en `main`.
 *
 * Vercel, Netlify y Railway ademas despliegan SOLOS con cada push a `main` una
 * vez vinculados (usan su propia app de GitHub, que hay que instalar una vez:
 * es lo que dice el tutorial del panel). Render se crea con autoDeploy apagado
 * —ver render-api.ts— y por eso el deploy lo dispara el sistema.
 *
 * Todo devuelve `{ ok: false, motivo }` en vez de tirar, y el motivo nunca
 * lleva el token: termina en un chat o en el panel.
 */

export interface Conexion {
  proveedor: Proveedor;
  token: string;
  extra: Record<string, string>;
}

export interface RepoAPublicar {
  nombre: string;
  /** `owner/nombre` en GitHub. */
  github_repo: string;
}

export type Fallo = { ok: false; motivo: string };
export type Verificado = { ok: true; cuenta: string; extra: Record<string, string> } | Fallo;
export type Vinculado = { ok: true; id: string; url: string } | Fallo;
export type Desplegado = { ok: true } | Fallo;

type Fetch = typeof fetch;

function sinToken(texto: string, token: string): string {
  return token ? texto.split(token).join('***') : texto;
}

async function pedir(
  f: Fetch,
  token: string,
  url: string,
  init: { method?: string; body?: unknown; auth?: string } = {},
): Promise<{ ok: boolean; status: number; json: any; texto: string }> {
  const res = await f(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: init.auth ?? `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const texto = await res.text();
  let json: any = undefined;
  try {
    json = texto ? JSON.parse(texto) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, json, texto: sinToken(texto.slice(0, 400), token) };
}

function motivoDe(r: { status: number; json: any; texto: string }, token: string): string {
  const m = r.json?.error?.message ?? r.json?.message ?? r.json?.errors?.[0]?.message ?? r.texto;
  return sinToken(`${r.status}: ${String(m).slice(0, 300)}`, token);
}

/** Un nombre que aceptan los cuatro: minusculas, numeros y guiones. */
export function nombreDeServicio(nombre: string): string {
  return (
    nombre
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'app'
  );
}

function partirRepo(github: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = github.split('/');
  return { owner, repo };
}

// --- Render ------------------------------------------------------------------

const RENDER = 'https://api.render.com/v1';

async function verificarRender(token: string, f: Fetch): Promise<Verificado> {
  const r = await pedir(f, token, `${RENDER}/owners?limit=1`);
  if (!r.ok) return { ok: false, motivo: motivoDe(r, token) };
  const owner = r.json?.[0]?.owner;
  if (!owner?.id) return { ok: false, motivo: 'el token anda pero no veo ninguna cuenta (owner) en Render' };
  return { ok: true, cuenta: owner.name ?? owner.email ?? owner.id, extra: { ownerId: owner.id } };
}

// --- Vercel ------------------------------------------------------------------

const VERCEL = 'https://api.vercel.com';

function equipo(c: Conexion): string {
  return c.extra['teamId'] ? `?teamId=${encodeURIComponent(c.extra['teamId'])}` : '';
}

async function verificarVercel(token: string, extra: Record<string, string>, f: Fetch): Promise<Verificado> {
  const r = await pedir(f, token, `${VERCEL}/v2/user`);
  if (!r.ok) return { ok: false, motivo: motivoDe(r, token) };
  const u = r.json?.user;
  const teamId = extra['teamId']?.trim();
  if (teamId) {
    const t = await pedir(f, token, `${VERCEL}/v2/teams/${encodeURIComponent(teamId)}`);
    if (!t.ok) return { ok: false, motivo: `no encuentro el team "${teamId}" con ese token (${t.status})` };
    return { ok: true, cuenta: t.json?.name ?? teamId, extra: { teamId } };
  }
  return { ok: true, cuenta: u?.username ?? u?.email ?? 'Vercel', extra: {} };
}

async function desplegarVercel(c: Conexion, id: string, repo: RepoAPublicar, f: Fetch): Promise<Desplegado> {
  const [projectId, nombre] = id.split('|');
  const { owner, repo: nombreRepo } = partirRepo(repo.github_repo);
  const r = await pedir(f, c.token, `${VERCEL}/v13/deployments${equipo(c)}`, {
    method: 'POST',
    body: {
      name: nombre ?? nombreDeServicio(repo.nombre),
      project: projectId,
      target: 'production',
      gitSource: { type: 'github', org: owner, repo: nombreRepo, ref: 'main' },
    },
  });
  return r.ok ? { ok: true } : { ok: false, motivo: motivoDe(r, c.token) };
}

async function vincularVercel(c: Conexion, repo: RepoAPublicar, f: Fetch): Promise<Vinculado> {
  const r = await pedir(f, c.token, `${VERCEL}/v11/projects${equipo(c)}`, {
    method: 'POST',
    body: { name: nombreDeServicio(repo.nombre), gitRepository: { type: 'github', repo: repo.github_repo } },
  });
  if (!r.ok) {
    const m = motivoDe(r, c.token);
    return {
      ok: false,
      motivo: /github|install|repository/i.test(m)
        ? `Vercel no ve el repo ${repo.github_repo}: instalá la app de GitHub de Vercel en esa cuenta/organización (${m})`
        : m,
    };
  }
  const id = `${r.json.id}|${r.json.name}`;
  // El primer deploy se pide explicito: vincular solo deja el proyecto, y el
  // push que lo dispararia ya paso.
  const d = await desplegarVercel(c, id, repo, f);
  if (!d.ok) return d;
  return { ok: true, id, url: `https://${r.json.name}.vercel.app` };
}

// --- Netlify -----------------------------------------------------------------

const NETLIFY = 'https://api.netlify.com/api/v1';

async function verificarNetlify(token: string, extra: Record<string, string>, f: Fetch): Promise<Verificado> {
  const r = await pedir(f, token, `${NETLIFY}/user`);
  if (!r.ok) return { ok: false, motivo: motivoDe(r, token) };
  const inst = extra['installationId']?.trim();
  if (!inst || !/^\d+$/.test(inst)) {
    return {
      ok: false,
      motivo: 'falta el número de instalación de la app de GitHub de Netlify (está en la URL de github.com/settings/installations)',
    };
  }
  return { ok: true, cuenta: r.json?.full_name ?? r.json?.email ?? 'Netlify', extra: { installationId: inst } };
}

async function desplegarNetlify(c: Conexion, id: string, f: Fetch): Promise<Desplegado> {
  const r = await pedir(f, c.token, `${NETLIFY}/sites/${encodeURIComponent(id)}/builds`, { method: 'POST', body: {} });
  return r.ok ? { ok: true } : { ok: false, motivo: motivoDe(r, c.token) };
}

async function vincularNetlify(c: Conexion, repo: RepoAPublicar, f: Fetch): Promise<Vinculado> {
  // El nombre de un sitio es global en Netlify: con un sufijo no choca con el
  // de otra persona.
  const nombre = `${nombreDeServicio(repo.nombre)}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await pedir(f, c.token, `${NETLIFY}/sites`, {
    method: 'POST',
    body: {
      name: nombre,
      repo: {
        provider: 'github',
        repo: repo.github_repo,
        branch: 'main',
        installation_id: Number(c.extra['installationId']),
      },
    },
  });
  if (!r.ok) return { ok: false, motivo: motivoDe(r, c.token) };
  const id = String(r.json.id);
  await desplegarNetlify(c, id, f);
  return { ok: true, id, url: r.json.ssl_url ?? r.json.url ?? `https://${nombre}.netlify.app` };
}

// --- Railway -----------------------------------------------------------------

const RAILWAY = 'https://backboard.railway.app/graphql/v2';

async function gql(c: { token: string }, query: string, variables: Record<string, unknown>, f: Fetch) {
  const r = await pedir(f, c.token, RAILWAY, { method: 'POST', body: { query, variables } });
  const error = r.json?.errors?.[0]?.message;
  return { ...r, ok: r.ok && !error, data: r.json?.data };
}

async function verificarRailway(token: string, f: Fetch): Promise<Verificado> {
  const r = await gql({ token }, 'query { me { name email } }', {}, f);
  if (!r.ok) return { ok: false, motivo: motivoDe(r, token) };
  return { ok: true, cuenta: r.data?.me?.name ?? r.data?.me?.email ?? 'Railway', extra: {} };
}

async function vincularRailway(c: Conexion, repo: RepoAPublicar, f: Fetch): Promise<Vinculado> {
  const p = await gql(
    c,
    'mutation($n: String!) { projectCreate(input: { name: $n }) { id environments { edges { node { id } } } } }',
    { n: nombreDeServicio(repo.nombre) },
    f,
  );
  if (!p.ok) return { ok: false, motivo: motivoDe(p, c.token) };
  const projectId: string = p.data.projectCreate.id;
  const environmentId: string | undefined = p.data.projectCreate.environments?.edges?.[0]?.node?.id;
  if (!environmentId) return { ok: false, motivo: 'Railway creó el proyecto sin entorno' };

  const s = await gql(
    c,
    'mutation($p: String!, $n: String!, $r: String!) { serviceCreate(input: { projectId: $p, name: $n, source: { repo: $r }, branch: "main" }) { id } }',
    { p: projectId, n: nombreDeServicio(repo.nombre), r: repo.github_repo },
    f,
  );
  if (!s.ok) {
    const m = motivoDe(s, c.token);
    return {
      ok: false,
      motivo: /repo|github/i.test(m)
        ? `Railway no ve el repo ${repo.github_repo}: instalá la app de GitHub de Railway en esa cuenta/organización (${m})`
        : m,
    };
  }
  const serviceId: string = s.data.serviceCreate.id;
  const d = await gql(
    c,
    'mutation($s: String!, $e: String!) { serviceDomainCreate(input: { serviceId: $s, environmentId: $e }) { domain } }',
    { s: serviceId, e: environmentId },
    f,
  );
  const dominio: string | undefined = d.ok ? d.data?.serviceDomainCreate?.domain : undefined;
  return { ok: true, id: `${serviceId}|${environmentId}`, url: dominio ? `https://${dominio}` : 'https://railway.app/dashboard' };
}

async function desplegarRailway(c: Conexion, id: string, f: Fetch): Promise<Desplegado> {
  const [serviceId, environmentId] = id.split('|');
  const r = await gql(
    c,
    'mutation($s: String!, $e: String!) { serviceInstanceRedeploy(serviceId: $s, environmentId: $e) }',
    { s: serviceId, e: environmentId },
    f,
  );
  return r.ok ? { ok: true } : { ok: false, motivo: motivoDe(r, c.token) };
}

// --- la cara de afuera ---------------------------------------------------------

export async function verificar(
  proveedor: Proveedor,
  token: string,
  extra: Record<string, string>,
  f: Fetch = fetch,
): Promise<Verificado> {
  try {
    switch (proveedor) {
      case 'render':
        return await verificarRender(token, f);
      case 'vercel':
        return await verificarVercel(token, extra, f);
      case 'netlify':
        return await verificarNetlify(token, extra, f);
      case 'railway':
        return await verificarRailway(token, f);
    }
  } catch (err) {
    return { ok: false, motivo: sinToken(err instanceof Error ? err.message : String(err), token) };
  }
}

export async function vincular(c: Conexion, repo: RepoAPublicar, f: Fetch = fetch): Promise<Vinculado> {
  try {
    switch (c.proveedor) {
      case 'render': {
        const r = await crearServicio(repo.nombre, repo.github_repo, {
          apiKey: c.token,
          ...(c.extra['ownerId'] ? { ownerId: c.extra['ownerId'] } : {}),
          fetchImpl: f,
        });
        if (r.estado === 'creado') return { ok: true, id: r.serviceId, url: r.url };
        return { ok: false, motivo: r.estado === 'error' ? r.motivo : 'falta la cuenta de Render' };
      }
      case 'vercel':
        return await vincularVercel(c, repo, f);
      case 'netlify':
        return await vincularNetlify(c, repo, f);
      case 'railway':
        return await vincularRailway(c, repo, f);
    }
  } catch (err) {
    return { ok: false, motivo: sinToken(err instanceof Error ? err.message : String(err), c.token) };
  }
}

export async function desplegar(c: Conexion, id: string, repo: RepoAPublicar, f: Fetch = fetch): Promise<Desplegado> {
  try {
    switch (c.proveedor) {
      case 'render':
        return await dispararDeploy(id, { apiKey: c.token, fetchImpl: f });
      case 'vercel':
        return await desplegarVercel(c, id, repo, f);
      case 'netlify':
        return await desplegarNetlify(c, id, f);
      case 'railway':
        return await desplegarRailway(c, id, f);
    }
  } catch (err) {
    return { ok: false, motivo: sinToken(err instanceof Error ? err.message : String(err), c.token) };
  }
}
