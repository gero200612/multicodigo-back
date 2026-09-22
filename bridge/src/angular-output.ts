/**
 * El `outputPath` del build de Angular, corregido antes de crear el servicio.
 *
 * `@angular/build:application` -- el builder que trae `ng new` desde Angular
 * 17 -- SIEMPRE anida el sitio servible bajo `<outputPath>/browser/`, incluso
 * sin SSR: lo hace para que un dia que se agregue SSR, `browser/` y `server/`
 * convivan. `render-api.ts` publica un sitio estatico con `publishPath: 'dist'`
 * fijo, y el outputPath por defecto que deja `ng new` es `dist/<proyecto>`. Las
 * dos cosas juntas hacen que Render sirva un directorio vacio: `/` contesta 200
 * sin cuerpo y `/index.html` da 404, y no hay ningun error en el deploy que lo
 * diga -- el build termina bien, el archivo esta, solo que en otro lado.
 *
 * Paso con `taller` el 2026-09-22: la corrida cerro "completo", el front se
 * desplego, y el sitio no tenia nada. Misma clase de cosa que
 * `dockerfile-back.ts`: infraestructura que el sistema sabe exactamente como
 * tiene que ser, no algo que dependa de que el agente configure `angular.json`
 * bien en un turno de dieciocho minutos.
 */
import { leerArchivo, escribirArchivo, type GithubDeps } from './github-contenido.js';

/** Que paso con el `outputPath` de Angular. */
export type ResultadoOutputPath =
  /** Lo corrigio el sistema: hay que reconstruir con eso. */
  | { estado: 'corregido' }
  /** Ya apuntaba bien. */
  | { estado: 'ya_estaba' }
  /** No es un proyecto de Angular, o tiene una forma que no se puede editar sin adivinar. */
  | { estado: 'no_aplica' }
  /** Se intento y fallo algo que una persona tiene que mirar. */
  | { estado: 'error'; motivo: string };

/**
 * Con esta forma, Angular deja `index.html` y el bundle directo en `dist/`,
 * sin el subdirectorio `browser/`: exactamente donde Render los busca.
 */
const OUTPUT_ESPERADO = { base: 'dist', browser: '' };

function apuntaBien(valor: unknown): boolean {
  return (
    typeof valor === 'object' &&
    valor !== null &&
    (valor as Record<string, unknown>)['base'] === OUTPUT_ESPERADO.base &&
    (valor as Record<string, unknown>)['browser'] === OUTPUT_ESPERADO.browser
  );
}

/**
 * Se asegura de que el `outputPath` del build de Angular calce con lo que
 * Render va a publicar.
 *
 * Con mas de un proyecto en `angular.json` no se adivina cual es el que se
 * despliega -- mismo criterio que `asegurarDockerfile` con mas de un
 * `.csproj`: mejor un pendiente que una edicion al azar.
 */
export async function asegurarOutputPathDeAngular(
  githubRepo: string,
  deps: GithubDeps,
): Promise<ResultadoOutputPath> {
  const leido = await leerArchivo(githubRepo, 'angular.json', deps);
  if (!leido.ok) {
    // Sin angular.json no es un proyecto de Angular: no hay nada que corregir.
    if (leido.noExiste) return { estado: 'no_aplica' };
    return { estado: 'error', motivo: leido.motivo };
  }

  let config: { projects?: Record<string, unknown> };
  try {
    config = JSON.parse(leido.texto) as { projects?: Record<string, unknown> };
  } catch {
    return { estado: 'error', motivo: 'angular.json no es JSON valido' };
  }

  const nombres = Object.keys(config.projects ?? {});
  if (nombres.length !== 1) return { estado: 'no_aplica' };

  const proyecto = config.projects![nombres[0]!] as {
    architect?: { build?: { options?: Record<string, unknown> } };
  };
  const opciones = proyecto.architect?.build?.options;
  if (!opciones) return { estado: 'no_aplica' };

  if (apuntaBien(opciones['outputPath'])) return { estado: 'ya_estaba' };

  opciones['outputPath'] = OUTPUT_ESPERADO;

  const escrito = await escribirArchivo(
    githubRepo,
    'angular.json',
    `${JSON.stringify(config, null, 2)}\n`,
    leido.sha,
    'chore(deploy): outputPath sin subcarpeta /browser para que calce con Render\n\n' +
      '@angular/build:application deja el sitio en dist/<proyecto>/browser/, y\n' +
      'Render publica dist/ a secas: el sitio quedaba sin nada publicado. Lo\n' +
      'escribe el sistema, misma clase de cosa que el Dockerfile del back.',
    deps,
  );
  return escrito.ok ? { estado: 'corregido' } : { estado: 'error', motivo: escrito.motivo };
}
