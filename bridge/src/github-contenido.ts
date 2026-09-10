/**
 * Leer y escribir UN archivo de un repo por la API de contenidos de GitHub.
 *
 * Existe para una sola cosa: apuntar el `config.js` del front al back cuando
 * cierra una corrida (ver `conectar.ts`). El bridge no ve los worktrees —viven
 * en el gateway— y abrir alla un endpoint de escritura para cambiar una linea
 * seria darle al gateway una ruta que escribe codigo del cliente por fuera de
 * un turno.
 *
 * ## Por que escribir directo a main no rompe el merge
 *
 * El merge por tarea es `--ff-only` y empuja `rama:main`: un commit en main que
 * no esta en la rama de ningun slot haria que el proximo push se rechace. No
 * pasa porque el gateway hace `fetch` y `rebase origin/main` al arrancar cada
 * turno (`worktree.ts` en multicodigo-vm), asi que la rama del slot absorbe el
 * commit antes de trabajar. Verificado antes de escribir esto, no supuesto.
 *
 * El token es el de la instalacion de la GitHub App, el mismo con que el
 * gateway pushea. Nunca aparece en un `motivo`: aca solo se devuelve el status.
 */

const API = 'https://api.github.com';

export interface GithubDeps {
  token: string;
  fetchImpl?: typeof fetch;
}

function cabeceras(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    // GitHub rechaza los pedidos sin user-agent.
    'user-agent': 'multicodigo-bridge',
  };
}

export type Leido =
  | { ok: true; texto: string; sha: string }
  | { ok: false; noExiste: boolean; motivo: string };

export async function leerArchivo(repo: string, ruta: string, deps: GithubDeps): Promise<Leido> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${API}/repos/${repo}/contents/${ruta}?ref=main`, {
      headers: cabeceras(deps.token),
    });
    // 404 no es un error: es la respuesta. Un front sin ese archivo recibe la
    // URL por otro lado, y eso es "no hay nada que tocar".
    if (res.status === 404) return { ok: false, noExiste: true, motivo: `${ruta} no existe` };
    if (!res.ok) {
      return { ok: false, noExiste: false, motivo: `GitHub contesto ${res.status} al leer ${ruta}` };
    }
    const j = (await res.json()) as { content?: unknown; sha?: unknown };
    // Un directorio vuelve como lista, sin `content`.
    if (typeof j.content !== 'string' || typeof j.sha !== 'string') {
      return { ok: false, noExiste: false, motivo: `${ruta} no es un archivo` };
    }
    return { ok: true, texto: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
  } catch (err) {
    return { ok: false, noExiste: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Escribe el archivo en main.
 *
 * El `sha` es obligatorio y no un detalle: es lo que hace que GitHub rechace la
 * escritura (409) si el archivo cambio entre la lectura y ahora. Sin el, un
 * push que entro en el medio se pisaria sin aviso.
 */
export async function escribirArchivo(
  repo: string,
  ruta: string,
  texto: string,
  sha: string,
  mensaje: string,
  deps: GithubDeps,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${API}/repos/${repo}/contents/${ruta}`, {
      method: 'PUT',
      headers: cabeceras(deps.token),
      body: JSON.stringify({
        message: mensaje,
        content: Buffer.from(texto, 'utf8').toString('base64'),
        sha,
        branch: 'main',
      }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, motivo: `GitHub contesto ${res.status} al escribir ${ruta}` };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}
