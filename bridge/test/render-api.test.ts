import { describe, it, expect } from 'vitest';
import { crearServicio } from '../src/render-api.js';

const OK = {
  apiKey: 'rnd_clave',
  ownerId: 'tea-123',
};

describe('crearServicio', () => {
  it('crea un web service de Node en main con autoDeploy y devuelve la URL', async () => {
    let visto: any = null;
    const r = await crearServicio('propinas-back', 'Sincro-arg/propinas-back', {
      ...OK,
      fetchImpl: (async (_url: string, init: any) => {
        visto = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ service: { id: 'srv-abc', serviceDetails: { url: 'https://propinas-back.onrender.com' } } }),
          { status: 201 },
        );
      }) as any,
    });

    expect(r).toEqual({ estado: 'creado', serviceId: 'srv-abc', url: 'https://propinas-back.onrender.com' });
    expect(visto.repo).toBe('https://github.com/Sincro-arg/propinas-back');
    expect(visto.branch).toBe('main');
    expect(visto.autoDeploy).toBe('yes');
    expect(visto.serviceDetails.env).toBe('node');
    expect(visto.serviceDetails.envSpecificDetails.buildCommand).toBe('npm install');
    expect(visto.serviceDetails.envSpecificDetails.startCommand).toBe('npm start');
    expect(visto.serviceDetails.plan).toBe('free');
    expect(visto.serviceDetails.region).toBe('oregon');
  });

  // Un servidor sin configurar sigue andando, solo que sin esta parte.
  it('sin apiKey devuelve sin_render en vez de explotar', async () => {
    const r = await crearServicio('x', 'org/x', { fetchImpl: (async () => { throw new Error('no'); }) as any });
    expect(r).toEqual({ estado: 'sin_render' });
  });

  it('un error de la API vuelve como error con el motivo, no como excepcion', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => new Response('{"message":"name already exists"}', { status: 400 })) as any,
    });
    expect(r.estado).toBe('error');
    expect((r as any).motivo).toContain('name already exists');
  });

  it('una respuesta sin URL vuelve como error y no como creado a medias', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => new Response(JSON.stringify({ service: { id: 'srv-1' } }), { status: 201 })) as any,
    });
    expect(r.estado).toBe('error');
  });

  // La clave no puede aparecer en ningun mensaje que despues va a un chat.
  it('la clave no aparece en el motivo del error', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => { throw new Error('conexion fallo con rnd_clave'); }) as any,
    });
    expect(r.estado).toBe('error');
    expect((r as any).motivo).not.toContain('rnd_clave');
  });
});

/**
 * El 400 de "unfetchable", traducido a lo que hay que hacer.
 *
 * Render contesta un JSON con el motivo y DESPUES la lista de formatos de URL
 * que acepta, que es larga y ocupa casi todo el mensaje. Eso llegaba crudo al
 * informe de la mañana y se leia como un problema de formato — cuando el
 * formato que mandamos es justo el primero de esa lista.
 *
 * Lo verificado el 2026-09-09, por los dos caminos: la app de Render esta
 * instalada en la org Y tiene acceso al repo, pero el WORKSPACE de Render no ve
 * ningun repositorio ("No repositories found" en su propio dashboard). Falta el
 * vinculo instalacion -> workspace, que solo se crea desde Render y necesita un
 * click de una persona.
 *
 * Un pendiente que dice que hacer vale mil veces mas que el error textual.
 */
describe('el error de repo no conectado', () => {
  const RECHAZO = JSON.stringify({
    message:
      'passed in repository URL is invalid or unfetchable: ' +
      'https://github.com/Sincro-arg/saludos5-back. Accepted formats are: ' +
      'https://github.com/{namespace}/{repository}, https://gitlab.com/{namespace}/{repository}, ' +
      'https://bitbucket.org/{namespace}/{repository}, or ' +
      'https://cursor.com/codebase/{namespace}/{repository}. ' +
      'You may pass in a branch in the branch field.',
  });

  it('dice que falta conectar el repo, y donde', async () => {
    const r = await crearServicio('saludos5-back', 'Sincro-arg/saludos5-back', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () => new Response(RECHAZO, { status: 400 })) as typeof fetch,
    });

    if (r.estado !== 'error') throw new Error(`no es error: ${r.estado}`);
    expect(r.motivo).toContain('dashboard.render.com');
    // Y no la lista de formatos, que es lo que tapaba el mensaje.
    expect(r.motivo).not.toContain('bitbucket.org');
  });

  // Cualquier otro 400 sigue llegando textual: traducir solo lo que se entiende
  // es mejor que inventar una explicacion para un error que no se conoce.
  it('otro error de Render llega tal cual', async () => {
    const r = await crearServicio('x', 'org/x', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'name already exists' }), {
          status: 400,
        })) as typeof fetch,
    });

    if (r.estado !== 'error') throw new Error(`no es error: ${r.estado}`);
    expect(r.motivo).toContain('name already exists');
  });
});
