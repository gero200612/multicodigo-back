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
import { leerArchivo, escribirArchivo, listarCarpeta, type GithubDeps } from './github-contenido.js';

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
  // `csproj` puede venir con carpeta (`AH.Api/AH.Api.csproj`). El ensamblado
  // sale del nombre del archivo, no de la carpeta.
  const archivo = csproj.split('/').pop()!;
  const dll = `${archivo.replace(/\.csproj$/, '')}.dll`;
  const carpeta = csproj.includes('/') ? `${csproj.slice(0, csproj.lastIndexOf('/'))}/` : './';
  return [
    '# Imagen para Render: compila la API y la corre sobre el runtime de ASP.NET.',
    '# Render no trae .NET, asi que el despliegue va por Docker. Lo escribe el',
    `# ${MARCA}; si lo editas, tu version manda.`,
    'FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build',
    'WORKDIR /src',
    `COPY ${csproj} ${carpeta}`,
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
 * Lo que distingue un Dockerfile escrito por el sistema de uno de una persona.
 *
 * Solo el del sistema se reescribe cuando queda viejo. El de una persona manda
 * siempre: puede tener algo que el sistema no sabe.
 */
const MARCA = 'sistema al publicar';

/**
 * Donde esta el `.csproj` de la API.
 *
 * Primero la raiz, que es lo que deja `dotnet new webapi`. Si ahi no hay, las
 * carpetas de primer nivel, sin las de tests: es el layout de .NET con un
 * proyecto de tests al lado (`AH.Api/` + `AH.Tests/` + `AH.sln`), que es a lo
 * que llego AH cuando la corrida arreglo `dotnet test`.
 *
 * Con mas de un candidato no se adivina: `undefined`, igual que con ninguno.
 */
async function ubicarCsproj(githubRepo: string, deps: GithubDeps): Promise<string | undefined> {
  const raiz = await listarCarpeta(githubRepo, '', deps);
  const enRaiz = raiz.filter((e) => e.type === 'file' && e.name.endsWith('.csproj'));
  if (enRaiz.length === 1) return enRaiz[0]!.name;
  if (enRaiz.length > 1) return undefined;

  const candidatos: string[] = [];
  for (const dir of raiz.filter((e) => e.type === 'dir' && !/test/i.test(e.name))) {
    const adentro = await listarCarpeta(githubRepo, dir.name, deps);
    for (const e of adentro) {
      if (e.type === 'file' && e.name.endsWith('.csproj')) candidatos.push(`${dir.name}/${e.name}`);
    }
  }
  return candidatos.length === 1 ? candidatos[0] : undefined;
}

/**
 * Se asegura de que el back tenga un Dockerfile que compile.
 *
 * Tres casos:
 * - No hay Dockerfile: se escribe, si se encuentra UN `.csproj` de API.
 * - Hay uno del SISTEMA que apunta a un `.csproj` que ya no esta: se
 *   reescribe. Visto en AH (2026-09-25): el Dockerfile apuntaba a
 *   `AH.Api.csproj` en la raiz y la corrida movio el proyecto a `AH.Api/`.
 *   Sin esto, el deploy moria en `COPY` y "ya estaba" lo dejaba asi.
 * - Hay uno de una PERSONA: no se toca.
 */
export async function asegurarDockerfile(
  githubRepo: string,
  deps: GithubDeps,
): Promise<ResultadoDockerfile> {
  const ya = await leerArchivo(githubRepo, 'Dockerfile', deps);
  if (!ya.ok && !ya.noExiste) return { estado: 'error', motivo: ya.motivo };
  if (ya.ok && !ya.texto.includes(MARCA)) return { estado: 'ya_estaba' };

  const csproj = await ubicarCsproj(githubRepo, deps);
  if (!csproj) return ya.ok ? { estado: 'ya_estaba' } : { estado: 'no_aplica' };

  const receta = dockerfileDeNet(csproj);
  if (ya.ok && ya.texto.includes(`RUN dotnet publish ${csproj} `)) return { estado: 'ya_estaba' };

  const escrito = await escribirArchivo(
    githubRepo,
    'Dockerfile',
    receta,
    // Sin sha cuando no existe: GitHub rechaza la creacion si aparecio en el
    // medio. Con sha cuando se reescribe: rechaza si cambio desde que se leyo.
    ya.ok ? ya.sha : '',
    ya.ok
      ? `chore(deploy): el Dockerfile apunta a ${csproj}\n\n` +
          'El proyecto de la API cambio de lugar y el Dockerfile que escribio el\n' +
          'sistema seguia apuntando al viejo: el build moria en el COPY.'
      : 'chore(deploy): agregar Dockerfile para desplegar en Render\n\n' +
          'Render no trae runtime de .NET. Lo escribe el sistema al publicar, con\n' +
          'la misma receta que ya anda en los otros backs del mismo stack.',
    deps,
  );
  return escrito.ok ? { estado: 'escrito' } : { estado: 'error', motivo: escrito.motivo };
}
