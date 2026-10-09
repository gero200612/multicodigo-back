import { descifrar } from './cifrado.js';
import { desplegar, vincular, type Conexion } from './proveedores.js';
import { dispararDeploy } from './render-api.js';
import type { ConexionGuardada, RepoDelProyecto, Store } from './store.js';

/**
 * Publicar lo que hizo un ticket: su rama a `main`, y nada más.
 *
 * Desplegar es otro paso y se hace desde Repositorios (`desplegarRepo`), repo
 * por repo: Gero lo pidió así (2026-10-09). Publicar solo dice qué ramas
 * pasaron a main; dónde y cuándo se despliega lo decide él.
 *
 * Dos formas de llegar:
 *
 * - **Explícita**: la persona tocó "Publicar" en el chat del ticket. Ahí se
 *   publican TODOS los repos del proyecto, también los que conectó ella.
 * - **Automática**: el ticket terminó y la persona apagó "preguntar antes de
 *   desplegar". Ahí solo los repos que creó el bot: un repo conectado a mano
 *   puede ser el de este mismo sistema, y pasarlo a `main` sin que nadie lo
 *   pida es justo lo que el gateway se niega a hacer (ver `gitMerge`).
 */

export interface PedidoDePublicacion {
  usuarioId: string;
  proyectoId: string;
  /** El nombre del proyecto: es la carpeta del worktree. */
  proyecto: string;
  /** El agente que trabajó el ticket: su rama es la que va a `main`. */
  agente: string;
  explicito: boolean;
}

export interface PublicarDeps {
  store: Pick<Store, 'reposDeProyecto' | 'conexionesDeDespliegue' | 'guardarVinculoDeDestino'>;
  clave: Buffer;
  mergear: (req: {
    agent: string;
    project: string;
    repo: string;
    creadoPorElBot: boolean;
    autorizadoPorPersona: boolean;
  }) => Promise<{ ok: boolean; output: string }>;
  /** El Render del sistema, para los repos de antes que no eligieron app. */
  renderDelSistema?: { apiKey: string; ownerId?: string };
  fetchImpl?: typeof fetch;
}

export interface ResultadoDePublicacion {
  /** Lo que se desplegó. Publicar ya no despliega: queda vacío (ver `desplegarRepo`). */
  publicados: { repo: string; url: string; app: string }[];
  /** Lo que no se pudo, dicho para una persona. */
  pendientes: string[];
  /** Los repos cuya rama del agente quedó en main. */
  mergeados?: string[];
}

const NOMBRE_DE_APP: Record<string, string> = {
  render: 'Render',
  vercel: 'Vercel',
  netlify: 'Netlify',
  railway: 'Railway',
};

export async function publicarCambios(
  p: PedidoDePublicacion,
  deps: PublicarDeps,
): Promise<ResultadoDePublicacion> {
  const publicados: ResultadoDePublicacion['publicados'] = [];
  const pendientes: string[] = [];
  const mergeados: string[] = [];

  // En serie, como el resto de los bucles de repos: si el segundo falla, el
  // primero ya está y el mensaje puede decir cuál.
  for (const repo of await deps.store.reposDeProyecto(p.proyectoId)) {
    if (repo.solo_lectura) continue;
    if (!repo.creado_por_el_bot && !p.explicito) {
      pendientes.push(`${repo.nombre} es un repo tuyo: se publica cuando tocás "Publicar"`);
      continue;
    }

    const m = await deps.mergear({
      agent: p.agente,
      project: p.proyecto,
      repo: repo.nombre,
      creadoPorElBot: repo.creado_por_el_bot,
      autorizadoPorPersona: p.explicito,
    });
    if (!m.ok) {
      // Sin rama del agente en ese repo no hay nada que publicar: no es un
      // error, el ticket tocó otro repo.
      if (/no existe|no hay|not a git|did not match|unknown revision|no tiene/i.test(m.output)) continue;
      pendientes.push(`no pude pasar ${repo.nombre} a main (${m.output.slice(0, 200)})`);
      continue;
    }
    mergeados.push(repo.nombre);
  }
  return { publicados, pendientes, mergeados };
}

/**
 * Lo que ya está en `main` de un repo, a su app: la primera vez se vincula
 * (crea el servicio/proyecto/sitio atado al repo), después se despliega. Lo
 * usan los tickets y el cierre de las corridas.
 */
export async function aDestino(
  repo: RepoDelProyecto,
  conexiones: readonly ConexionGuardada[],
  proyectoId: string,
  deps: Pick<PublicarDeps, 'store' | 'clave' | 'fetchImpl'>,
): Promise<{ ok: true; url: string; app: string } | { ok: false; motivo: string }> {
  if (!repo.destino) return { ok: false, motivo: `${repo.nombre} no tiene app elegida` };
  const app = NOMBRE_DE_APP[repo.destino]!;
  const guardada = conexiones.find((c) => c.proveedor === repo.destino);
  if (!guardada) {
    return { ok: false, motivo: `${repo.nombre} se publica en ${app}, pero no conectaste esa cuenta: hacelo en Configuración → Conexiones` };
  }
  let conexion: Conexion;
  try {
    conexion = { proveedor: guardada.proveedor, token: descifrar(guardada.tokenCifrado, deps.clave), extra: guardada.extra };
  } catch {
    return { ok: false, motivo: `no pude leer la conexión de ${app}: volvé a conectarla` };
  }
  if (repo.destino_id) {
    const d = await desplegar(conexion, repo.destino_id, repo, deps.fetchImpl);
    return d.ok
      ? { ok: true, url: repo.destino_url ?? '', app }
      : { ok: false, motivo: `${repo.nombre} pasó a main pero ${app} no desplegó (${d.motivo})` };
  }
  const v = await vincular(conexion, repo, deps.fetchImpl);
  if (!v.ok) return { ok: false, motivo: `no pude crear ${repo.nombre} en ${app} (${v.motivo})` };
  await deps.store.guardarVinculoDeDestino(proyectoId, repo.nombre, v.id, v.url);
  return { ok: true, url: v.url, app };
}

/**
 * Desplegar UN repo desde Repositorios: lo que ya está en su `main`, a la app
 * que eligió (la primera vez lo crea ahí), o al Render del sistema si el repo
 * es de antes y ya tenía servicio.
 */
export async function desplegarRepo(
  usuarioId: string,
  proyectoId: string,
  nombre: string,
  deps: Omit<PublicarDeps, 'mergear'>,
): Promise<{ ok: true; url: string; app: string } | { ok: false; motivo: string }> {
  const repo = (await deps.store.reposDeProyecto(proyectoId)).find((r) => r.nombre === nombre);
  if (!repo) return { ok: false, motivo: 'ese repo no está en el proyecto' };
  if (repo.destino) return aDestino(repo, await deps.store.conexionesDeDespliegue(usuarioId), proyectoId, deps);
  if (repo.render_service_id && deps.renderDelSistema) {
    const d = await dispararDeploy(repo.render_service_id, {
      ...deps.renderDelSistema,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return d.ok
      ? { ok: true, url: repo.render_url ?? '', app: 'Render' }
      : { ok: false, motivo: `Render no desplegó ${repo.nombre} (${d.motivo})` };
  }
  return { ok: false, motivo: `elegí primero en qué app se publica ${repo.nombre}` };
}

/** El resultado para mostrar: en el chat del ticket y en Telegram. */
export function textoDePublicacion(r: ResultadoDePublicacion): string {
  const lineas: string[] = [];
  if (r.mergeados?.length) {
    lineas.push('Pasaron a main:', ...r.mergeados.map((x) => `- ${x}`));
    lineas.push('', 'Para desplegar, andá a Repositorios.');
  }
  if (r.pendientes.length) {
    if (lineas.length) lineas.push('');
    lineas.push('No pasaron:', ...r.pendientes.map((x) => `- ${x}`));
  }
  return lineas.join('\n') || 'No había nada nuevo para pasar a main.';
}
