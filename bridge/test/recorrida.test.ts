import { describe, it, expect } from 'vitest';
import { problemasDeRecorrida, recorrerPublicado, type Recorrida } from '../src/recorrida.js';

/**
 * La recorrida del front publicado. Ver `src/recorrida.ts`.
 *
 * TallerPro (2026-10-12): seis pantallas con "Error interno del servidor" y el
 * header en tres renglones, y la corrida cerro sin enterarse.
 */
const URL_FRONT = 'https://tallerpro.apps.punchi.dev';

function recorrida(p: Partial<Recorrida>): Recorrida {
  return { entro: true, conLogin: true, rutas: ['/', '/clientes', '/ordenes'], mediciones: [], notas: [], ...p };
}

describe('problemasDeRecorrida', () => {
  it('una app sana no da trabajo', () => {
    expect(problemasDeRecorrida('TallerPro-front', URL_FRONT, recorrida({}))).toEqual([]);
  });

  it('seis pantallas con el mismo error son UNA tarea, con la lista', () => {
    const mediciones = ['/', '/clientes', '/presupuestos', '/caja', '/ordenes', '/reportes'].map(
      (r) => `⚠ ${r} (computadora): LA PANTALLA MUESTRA UN ERROR: "Error interno del servidor."`,
    );
    const p = problemasDeRecorrida('TallerPro-front', URL_FRONT, recorrida({ mediciones }));
    expect(p).toHaveLength(1);
    expect(p[0]!.resumen).toContain('6 pantalla(s)');
    expect(p[0]!.detalle).toContain('/caja (computadora)');
    expect(p[0]!.detalle).toMatch(/back publicado/);
  });

  it('el header partido y los pedidos que fallan son tareas aparte', () => {
    const mediciones = [
      '⚠ / (computadora): HEADER ROTO (132px de alto): se parte en 2 renglones (abajo quedan: Administrador, Cerrar sesión)',
      '⚠ /caja (computadora): pedidos que fallaron: GET https://x/api/caja/dia -> 500',
      '⚠ / (telefono): SE SALE DE ANCHO: 460px de contenido en 390px de pantalla',
    ];
    const p = problemasDeRecorrida('TallerPro-front', URL_FRONT, recorrida({ mediciones }));
    expect(p.map((x) => x.resumen)).toEqual([
      'TallerPro-front: el header se parte en renglones',
      'TallerPro-front: 1 pantalla(s) con pedidos al back que fallan',
      'TallerPro-front: 1 problema(s) de diseño medidos',
    ]);
  });

  it('con usuario y sin poder entrar, es trabajo', () => {
    const p = problemasDeRecorrida(
      'TallerPro-front',
      URL_FRONT,
      recorrida({ entro: false, rutas: ['/login'], notas: ['el login no entro con admin@x.com'] }),
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.resumen).toMatch(/no pude entrar/);
    expect(p[0]!.detalle).toContain('el login no entro');
  });

  it('sin usuario de prueba y sin menu para recorrer, pide la linea del contrato', () => {
    const p = problemasDeRecorrida('TallerPro-front', URL_FRONT, recorrida({ entro: false, conLogin: false, rutas: ['/login'] }));
    expect(p[0]!.detalle).toContain('USUARIO_DE_PRUEBA');
  });

  // Una app sin login (una landing) no necesita usuario: recorre su menu igual.
  it('una app sin login que recorrio su menu no pide usuario', () => {
    expect(problemasDeRecorrida('landing', URL_FRONT, recorrida({ entro: false, conLogin: false }))).toEqual([]);
  });
});

describe('recorrerPublicado', () => {
  it('le pide la recorrida al gateway con el proyecto y la URL', async () => {
    let pedido: { url: string; cuerpo: unknown; auth: string | null } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      pedido = { url, cuerpo: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') };
      return new Response(JSON.stringify(recorrida({})));
    }) as unknown as typeof fetch;
    const r = await recorrerPublicado('TallerPro', URL_FRONT, { gatewayUrl: 'http://gateway:4000/', token: 't', fetchImpl });
    expect(pedido).toEqual({ url: 'http://gateway:4000/recorrer', cuerpo: { project: 'TallerPro', publicado: URL_FRONT }, auth: 'Bearer t' });
    expect(r?.entro).toBe(true);
  });

  it('un gateway que no contesta no rompe nada', async () => {
    const fetchImpl = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    expect(await recorrerPublicado('x', URL_FRONT, { gatewayUrl: 'http://g', token: 't', fetchImpl })).toBeUndefined();
  });
});
