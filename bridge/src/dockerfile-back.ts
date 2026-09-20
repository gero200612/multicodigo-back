/**
 * El Dockerfile del back, escrito por el sistema y no por el modelo.
 *
 * Render no trae runtime de .NET, asi que un back .NET solo se despliega por
 * Docker. El generador de proyectos no escribe ese archivo y nadie se lo pide,
 * asi que el repo llega a la publicacion sin el: el servicio no se puede crear
 * y el proyecto queda sin back. Paso con `padel` el 2026-09-19 —lo escribi a
 * mano para poder verlo andar— y volvio a pasar con `Hoteleria` la misma noche.
 *
 * Va ACA y no en una tarea de la corrida a proposito. Es la misma clase de cosa
 * que `reescribirConfig`: infraestructura que el sistema sabe exactamente como
 * tiene que ser, no una decision de producto. Pedirsela al modelo cuesta un
 * turno de dieciocho minutos, sale distinta cada vez, y cuando no sale nadie se
 * entera hasta la mañana.
 */
import { leerArchivo, escribirArchivo, listarRaiz, type GithubDeps } from './github-contenido.js';

/** Que paso con el Dockerfile del back. */
export type ResultadoDockerfile =
  /** Lo escribio el sistema: hay que desplegar con eso. */
  | { estado: 'escrito' }
  /** Ya estaba. No se toca: si el repo lo trae, manda el repo. */
  | { estado: 'ya_estaba' }
  /** No es un back .NET, o no se pudo mirar. No es un error. */
  | { estado: 'no_aplica' }
  /** Se intento y fallo algo que una persona tiene que mirar. */
  | { estado: 'error'; motivo: string };

/**
 * El contenido, a partir del nombre del proyecto .NET.
 *
 * Es la misma receta que ya anda en `turnos-back` y en `padel-back`, con el
 * nombre del `.csproj` como unica variable. El `ASPNETCORE_URLS` es el respaldo
 * para correrlo a mano: una API que lee `PORT` ata donde la plataforma le diga.
 */
export function dockerfileDeNet(csproj: string): string {
  const dll = `${csproj.replace(/\.csproj$/, '')}.dll`;
  return [
    '# Imagen para Render: compila la API y la corre sobre el runtime de ASP.NET.',
    '# Render no trae .NET, asi que el despliegue va por Docker. Lo escribe el',
    '# sistema al publicar; si lo editas, tu version manda.',
    'FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build',
    'WORKDIR /src',
    `COPY ${csproj} ./`,
    `RUN dotnet restore ${csproj}`,
    'COPY . .',
    `RUN dotnet publish ${csproj} -c Release -o /app/publish`,
    '',
    'FROM mcr.microsoft.com/dotnet/aspnet:10.0',
    'WORKDIR /app',
    'COPY --from=build /app/publish .',
    '',
    '# La plataforma inyecta PORT; el 8080 es para correrla a mano.',
    'ENV ASPNETCORE_URLS=http://+:8080',
    'EXPOSE 8080',
    `ENTRYPOINT ["dotnet", "${dll}"]`,
    '',
  ].join('\n');
}

/**
 * Se asegura de que el back tenga Dockerfile antes de crear el servicio.
 *
 * Solo escribe si hay UN `.csproj` en la raiz. Con varios no se adivina cual es
 * la API —podria ser el de tests— y con ninguno no es .NET: los dos casos son
 * `no_aplica`, que deja todo como estaba.
 */
export async function asegurarDockerfile(
  githubRepo: string,
  deps: GithubDeps,
): Promise<ResultadoDockerfile> {
  const ya = await leerArchivo(githubRepo, 'Dockerfile', deps);
  if (ya.ok) return { estado: 'ya_estaba' };
  if (!ya.noExiste) return { estado: 'error', motivo: ya.motivo };

  const raiz = await listarRaiz(githubRepo, deps);
  const csproj = raiz.filter((n) => n.endsWith('.csproj'));
  if (csproj.length !== 1) return { estado: 'no_aplica' };

  const escrito = await escribirArchivo(
    githubRepo,
    'Dockerfile',
    dockerfileDeNet(csproj[0]!),
    // Sin sha: el archivo no existe, y GitHub rechaza la creacion si aparecio
    // en el medio. Es la misma proteccion que el sha da en una edicion.
    '',
    'chore(deploy): agregar Dockerfile para desplegar en Render\n\n' +
      'Render no trae runtime de .NET. Lo escribe el sistema al publicar, con\n' +
      'la misma receta que ya anda en los otros backs del mismo stack.',
    deps,
  );
  return escrito.ok ? { estado: 'escrito' } : { estado: 'error', motivo: escrito.motivo };
}
