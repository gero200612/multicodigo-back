/**
 * Lo poco que el bridge le pide al panel.
 *
 * La dirección normal de este sistema es panel -> bridge: el panel le pide
 * turnos y decisiones. Esta es la única llamada que va al revés, y existe por un
 * pliegue del diseño que conviene entender antes de agregarle nada.
 *
 * Los turnos de Telegram entran por acá y no pasan por el panel, pero firmar un
 * installation token necesita la clave privada de la GitHub App. Las opciones
 * eran duplicar la firma en TypeScript —dos implementaciones de la misma
 * criptografía y la clave privada en dos servicios— o pedírsela al panel. Se
 * eligió lo segundo: la clave vive en UN solo lado.
 *
 * El bridge SÍ sabe qué instalación es (la lee de su propio Postgres, donde
 * conecta como `postgres` y no pasa por RLS). Lo único que no puede hacer es
 * firmar. Por eso este cliente manda un `installation_id` y recibe un token, y
 * no al revés: si el panel tuviera que buscar la fila, necesitaría la
 * service_role key de Supabase, que administra auth y se le negó a propósito.
 */
export interface PanelDeps {
  /** Por la red interna de Docker: http://panel:8091. Nunca por el túnel. */
  panelUrl: string;
  /** El mismo BRIDGE_API_TOKEN con el que el panel le habla al bridge. */
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Le pide al panel el token de una instalación.
 *
 * **Nunca lanza**, y es deliberado: sin token el turno corre igual y el gateway
 * usa SSH con la deploy key. Que el panel esté caído tiene que degradar el push,
 * no impedir que el agente trabaje — y menos por el camino de Telegram, que es
 * el que se usa cuando algo ya anda mal.
 */
export async function firmarToken(
  installationId: number,
  deps: PanelDeps,
): Promise<string | undefined> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.panelUrl.replace(/\/$/, '')}/interno/github/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.token}`,
      },
      body: JSON.stringify({ installation_id: installationId }),
      // Corto: esto corre ANTES del turno, con el usuario esperando en Telegram.
      // Un panel colgado no puede sumarle medio minuto a cada mensaje.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;

    const cuerpo = (await res.json()) as { token?: unknown };
    return typeof cuerpo.token === 'string' && cuerpo.token !== '' ? cuerpo.token : undefined;
  } catch {
    // Sin loguear el error: el cuerpo de una respuesta del panel podria traer
    // parte de un token, y los logs del bridge no son lugar para eso.
    return undefined;
  }
}

/**
 * Le pide al panel que cree un repo en GitHub.
 *
 * Mismo pliegue que `firmarToken` y por la misma razon: la clave privada de la
 * App vive en un solo lado. El bridge sabe QUE instalacion es —la leyo de su
 * propio Postgres— y lo unico que no puede hacer es firmar.
 *
 * A diferencia de `firmarToken`, esta SI devuelve el motivo del fallo. Aquella
 * degrada en silencio porque sin token el turno corre igual por SSH; acá no hay
 * degradacion posible: si el repo no se crea, no hay repo, y la persona tiene
 * que leer por que.
 *
 * La `org` no viaja: el panel la saca de preguntarle a GitHub de quien es la
 * instalacion. Mandarla desde acá seria dejar que un id equivocado apunte a la
 * org de otro.
 */
export async function crearRepo(
  installationId: number,
  nombre: string,
  descripcion: string | undefined,
  deps: PanelDeps,
  /**
   * Si el repo nace PUBLICO. Por defecto no.
   *
   * El panel es el que decide de verdad —tiene la instalacion de la App— y su
   * default tambien es privado: esto le pide una excepcion explicita, no le
   * cambia la politica. Ver `OpcionesDeCorrida.publico` y `GitHubApp.cs`.
   */
  publico = false,
): Promise<{ ok: true; nombre: string; github: string } | { ok: false; code: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.panelUrl.replace(/\/$/, '')}/interno/github/repo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.token}`,
      },
      // `publico` va SIEMPRE, tambien cuando es false: un panel que lo lee sabe
      // que la decision se tomo, y no queda dependiendo de que el campo falte.
      body: JSON.stringify({ installation_id: installationId, nombre, descripcion, publico }),
      // Mas largo que el de firmar: crear un repo es una escritura en GitHub
      // con `auto_init`, o sea que del otro lado se arma un commit inicial.
      signal: AbortSignal.timeout(30_000),
    });
    const cuerpo = (await res.json().catch(() => ({}))) as {
      nombre?: unknown;
      github_repo?: unknown;
      code?: unknown;
    };
    if (!res.ok) {
      return { ok: false, code: typeof cuerpo.code === 'string' ? cuerpo.code : `http_${res.status}` };
    }
    return typeof cuerpo.nombre === 'string' && typeof cuerpo.github_repo === 'string'
      ? { ok: true, nombre: cuerpo.nombre, github: cuerpo.github_repo }
      : { ok: false, code: 'respuesta_incompleta' };
  } catch {
    // Sin el error crudo: puede traer parte de una URL con credenciales, y este
    // texto termina en un chat.
    return { ok: false, code: 'panel_no_responde' };
  }
}
