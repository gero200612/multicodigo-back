import { describe, it, expect } from 'vitest';
import { asegurarDockerfile, dockerfileDeNet } from '../src/dockerfile-back.js';

/**
 * El Dockerfile del back lo escribe el sistema.
 *
 * Render no trae runtime de .NET, asi que sin Dockerfile el servicio no se
 * puede crear y el proyecto queda sin back. Paso dos veces el 2026-09-19:
 * `padel` y `Hoteleria`, las dos veces con el repo entero construido y sin
 * forma de desplegarlo.
 */
describe('dockerfileDeNet', () => {
  it('compila y ejecuta el proyecto que se le pasa', () => {
    const d = dockerfileDeNet('Hoteleria.Api.csproj');
    expect(d).toContain('RUN dotnet restore Hoteleria.Api.csproj');
    expect(d).toContain('RUN dotnet publish Hoteleria.Api.csproj -c Release -o /app/publish');
    // El ensamblado sale del nombre del csproj, no del nombre del repo:
    // `Hoteleria-back` tiene adentro `Hoteleria.Api`.
    expect(d).toContain('ENTRYPOINT ["dotnet", "Hoteleria.Api.dll"]');
  });
});

/** Un GitHub de mentira: contesta por ruta. */
function github(archivos: Record<string, unknown>, raiz: string[] = [], escrituras: any[] = []) {
  return {
    token: 'tok',
    fetchImpl: (async (url: string, init: any) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        escrituras.push({ url: u, body: JSON.parse(init.body) });
        return new Response('{}', { status: 201 });
      }
      if (u.endsWith('/contents?ref=main')) {
        return new Response(JSON.stringify(raiz.map((name) => ({ name }))), { status: 200 });
      }
      const ruta = decodeURIComponent(u.split('/contents/')[1]!.split('?')[0]!);
      const hay = archivos[ruta];
      if (hay === undefined) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({ content: Buffer.from(String(hay)).toString('base64'), sha: 'sha1' }),
        { status: 200 },
      );
    }) as any,
  };
}

describe('asegurarDockerfile', () => {
  it('lo escribe cuando falta y hay un solo csproj', async () => {
    const escrituras: any[] = [];
    const r = await asegurarDockerfile(
      'Sincro-arg/Hoteleria-back',
      github({}, ['Hoteleria.Api.csproj', 'Program.cs', 'Controllers'], escrituras),
    );

    expect(r).toEqual({ estado: 'escrito' });
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0].url).toContain('/contents/Dockerfile');
    const texto = Buffer.from(escrituras[0].body.content, 'base64').toString('utf8');
    expect(texto).toContain('Hoteleria.Api.dll');
  });

  // Si el repo lo trae, manda el repo: puede tener algo que el sistema no sabe.
  it('no toca el que ya estaba', async () => {
    const escrituras: any[] = [];
    const r = await asegurarDockerfile(
      'Sincro-arg/x-back',
      github({ Dockerfile: 'FROM mio' }, ['x.csproj'], escrituras),
    );

    expect(r).toEqual({ estado: 'ya_estaba' });
    expect(escrituras).toHaveLength(0);
  });

  it('un back que no es .NET no se toca', async () => {
    const escrituras: any[] = [];
    const r = await asegurarDockerfile(
      'Sincro-arg/nodeish-back',
      github({}, ['package.json', 'src'], escrituras),
    );

    expect(r).toEqual({ estado: 'no_aplica' });
    expect(escrituras).toHaveLength(0);
  });

  // Con dos no se adivina: uno puede ser el de tests.
  it('con mas de un csproj no elige', async () => {
    const r = await asegurarDockerfile(
      'Sincro-arg/y-back',
      github({}, ['A.csproj', 'B.csproj']),
    );
    expect(r).toEqual({ estado: 'no_aplica' });
  });
});
