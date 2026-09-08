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
