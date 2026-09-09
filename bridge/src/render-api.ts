/**
 * El cliente de la API de Render.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-08-deploy-render-design.md`.
 *
 * Igual que `supabase-api.ts`, y por la misma razon: la clave vive en el
 * entorno del bridge y el agente nunca la ve.
 *
 * Lo que NO existe al lado de esto es una ruta de borrar, y esa ausencia es la
 * contencion: el sistema crea servicios, destruirlos es de la persona.
 *
 * Este modulo no sabe nada de corridas ni de repos: recibe un nombre y un
 * "org/repo" y devuelve que paso. La politica —a quien se le crea servicio y
 * que se hace si falla— vive en `publicar.ts`.
 */
const API = 'https://api.render.com/v1';

/**
 * Constantes y no parametros.
 *
 * Nadie va a querer una region distinta por proyecto, y un parametro seria una
 * decision mas que alguien tiene que tomar a las cuatro de la mañana.
 *
 * Los comandos son los mismos que `TAREAS_POR_DEFECTO` del runner del gateway.
 * La simetria no es estetica: si `run test` anduvo en la corrida, el servicio
 * arranca con comandos que ya se probaron.
 */
const REGION = 'oregon';
const PLAN = 'free';
const BUILD = 'npm install';
const START = 'npm start';

export interface RenderDeps {
  apiKey?: string;
  ownerId?: string;
  fetchImpl?: typeof fetch;
}

export type ResultadoDeServicio =
  | { estado: 'creado'; serviceId: string; url: string }
  | { estado: 'sin_render' }
  | { estado: 'error'; motivo: string };

/** Que ningun mensaje que va a un chat lleve la clave adentro. */
function sinClave(texto: string, apiKey: string | undefined): string {
  if (!apiKey) return texto;
  return texto.split(apiKey).join('***');
}

export async function crearServicio(
  nombre: string,
  github: string,
  deps: RenderDeps,
): Promise<ResultadoDeServicio> {
  // Un servidor sin Render configurado sigue andando: la corrida cierra igual y
  // el informe trae el pendiente de siempre. Nunca peor que hoy.
  if (!deps.apiKey || !deps.ownerId) return { estado: 'sin_render' };

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${API}/services`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'web_service',
        name: nombre,
        ownerId: deps.ownerId,
        repo: `https://github.com/${github}`,
        // main y no la rama del agente: para cuando esto corre, el merge ya paso.
        branch: 'main',
        // Lo que hace que el sistema no tenga que volver a intervenir nunca:
        // de aca en adelante cada push lo publica Render sola.
        autoDeploy: 'yes',
        serviceDetails: {
          env: 'node',
          plan: PLAN,
          region: REGION,
          envSpecificDetails: { buildCommand: BUILD, startCommand: START },
        },
      }),
    });

    const texto = await res.text();
    if (!res.ok) {
      // Un error conocido se TRADUCE a lo que hay que hacer.
      //
      // Render contesta el motivo y despues la lista de formatos de URL que
      // acepta, que es larga y ocupa casi todo el mensaje: llegaba crudo al
      // informe de la mañana y se leia como un problema de formato, cuando el
      // que mandamos es el primero de esa lista.
      //
      // Verificado el 2026-09-09 por los dos caminos: la app de Render esta
      // instalada en la org Y tiene acceso al repo, pero el WORKSPACE no ve
      // ningun repositorio —"No repositories found" en su propio dashboard—.
      // Falta el vinculo instalacion -> workspace, que solo se crea desde
      // Render y necesita un click de una persona: no hay forma de hacerlo
      // desde la API.
      //
      // Por eso el pendiente dice DONDE ir. Un cable suelto que explica como
      // conectarse vale mil veces mas que el error textual del tercero.
      if (texto.includes('invalid or unfetchable')) {
        return {
          estado: 'error',
          motivo:
            'Render no tiene tus repos conectados. Entra a ' +
            'https://dashboard.render.com/web/new, elegi el workspace y apreta GitHub: ' +
            'cuando esa pantalla liste los repos, esto anda solo. Es una vez.',
        };
      }

      // Lo que no se reconoce llega textual, cortado a 600. Traducir solo lo
      // que se entiende es mejor que inventarle una explicacion a un error
      // desconocido. El tope existe para que un error de Render no se coma el
      // mensaje de la mañana.
      return { estado: 'error', motivo: sinClave(texto.slice(0, 600), deps.apiKey) };
    }

    const cuerpo = JSON.parse(texto) as {
      service?: { id?: string; serviceDetails?: { url?: string } };
    };
    const serviceId = cuerpo.service?.id;
    const url = cuerpo.service?.serviceDetails?.url;
    // Sin URL no se reporta un exito a medias: un "publicado" sin link es peor
    // que un fallo, porque nadie sabe que ir a mirar.
    if (!serviceId || !url) {
      return { estado: 'error', motivo: 'Render creo el servicio pero no devolvio la URL' };
    }
    return { estado: 'creado', serviceId, url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { estado: 'error', motivo: sinClave(msg, deps.apiKey) };
  }
}
