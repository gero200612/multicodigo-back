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
