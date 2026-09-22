import { describe, it, expect } from 'vitest';
import { asegurarOutputPathDeAngular } from '../src/angular-output.js';

/**
 * El bug real: `@angular/build:application` deja el sitio en
 * `dist/<proyecto>/browser/`, y `render-api.ts` publica `dist/` a secas.
 * Paso con `taller` el 2026-09-22: la corrida cerro "completo", el front se
 * desplego, y el sitio no tenia nada -- `/` daba 200 vacio y `/index.html` 404.
 */

/** Un GitHub de mentira: contesta por ruta, igual que en dockerfile-back.test.ts. */
function github(archivos: Record<string, unknown>, escrituras: any[] = []) {
  return {
    token: 'tok',
    fetchImpl: (async (url: string, init: any) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        escrituras.push({ url: u, body: JSON.parse(init.body) });
        return new Response('{}', { status: 201 });
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

function angularJson(outputPath: unknown): string {
  return JSON.stringify({
    projects: {
      'taller-front': {
        architect: { build: { options: { outputPath, index: 'src/index.html' } } },
      },
    },
  });
}

describe('asegurarOutputPathDeAngular', () => {
  it('corrige el outputPath por defecto que deja "ng new"', async () => {
    const escrituras: any[] = [];
    const r = await asegurarOutputPathDeAngular(
      'Sincro-arg/taller-front',
      github({ 'angular.json': angularJson('dist/taller-front') }, escrituras),
    );

    expect(r).toEqual({ estado: 'corregido' });
    expect(escrituras).toHaveLength(1);
    const escrito = JSON.parse(
      Buffer.from(escrituras[0].body.content, 'base64').toString('utf8'),
    );
    expect(escrito.projects['taller-front'].architect.build.options.outputPath).toEqual({
      base: 'dist',
      browser: '',
    });
  });

  // Un proyecto que ya viene con SSR y browser:'app' u otra forma explicita no
  // se toca a ciegas: se corrige a lo que Render espera, no se adivina.
  it('corrige tambien una forma de objeto que no calza con Render', async () => {
    const escrituras: any[] = [];
    const r = await asegurarOutputPathDeAngular(
      'Sincro-arg/taller-front',
      github({ 'angular.json': angularJson({ base: 'dist/taller-front', browser: 'browser' }) }, escrituras),
    );
    expect(r).toEqual({ estado: 'corregido' });
  });

  it('no toca el que ya apunta bien', async () => {
    const escrituras: any[] = [];
    const r = await asegurarOutputPathDeAngular(
      'Sincro-arg/taller-front',
      github({ 'angular.json': angularJson({ base: 'dist', browser: '' }) }, escrituras),
    );

    expect(r).toEqual({ estado: 'ya_estaba' });
    expect(escrituras).toHaveLength(0);
  });

  it('un repo sin angular.json no es un proyecto de Angular', async () => {
    const escrituras: any[] = [];
    const r = await asegurarOutputPathDeAngular('Sincro-arg/taller-back', github({}, escrituras));

    expect(r).toEqual({ estado: 'no_aplica' });
    expect(escrituras).toHaveLength(0);
  });

  // Con mas de un proyecto no se adivina cual se despliega, igual que
  // `asegurarDockerfile` con mas de un `.csproj`.
  it('con mas de un proyecto en angular.json no elige', async () => {
    const config = {
      projects: {
        a: { architect: { build: { options: { outputPath: 'dist/a' } } } },
        b: { architect: { build: { options: { outputPath: 'dist/b' } } } },
      },
    };
    const r = await asegurarOutputPathDeAngular(
      'Sincro-arg/multi-front',
      github({ 'angular.json': JSON.stringify(config) }),
    );
    expect(r).toEqual({ estado: 'no_aplica' });
  });

  it('un angular.json invalido no rompe la publicacion', async () => {
    const r = await asegurarOutputPathDeAngular(
      'Sincro-arg/taller-front',
      github({ 'angular.json': '{ esto no es json' }),
    );
    expect(r.estado).toBe('error');
  });
});
