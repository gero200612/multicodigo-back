import { describe, it, expect } from 'vitest';
import { rutasDeHumo, rutaDeLogin, credencialesDeHumo, probarEnVivo, textoDeFallas } from '../src/humo.js';

/**
 * La prueba de humo de lo publicado. Ver `src/humo.ts`.
 *
 * Prueba_completa (2026-10-10): /health daba 200 y el deploy quedo "andando",
 * pero /api/pacientes y /api/turnos daban 500 porque las tablas no existian.
 * Los tests del back corrian contra una base en memoria y no lo veian.
 */
const CONTRATO = `Prefijo fijo: todas las rutas van bajo /api.

AUTH
POST /api/auth/login
  body: { "email": string, "password": string }

PROFESIONALES (requiere JWT)
GET /api/profesionales
GET /api/profesionales/{id}
POST /api/profesionales

PACIENTES (requiere JWT)
GET /api/pacientes?buscar=texto

TURNOS (requiere JWT)
GET /api/turnos?fecha=YYYY-MM-DD&profesionalId=guid
GET /api/turnos/hoy
PUT /api/turnos/{id}/cancelar

SALUD
GET /health
`;

const HOY = new Date('2026-10-10T12:00:00Z');

describe('rutasDeHumo', () => {
  it('saca los GET del contrato, sin los que llevan id', () => {
    expect(rutasDeHumo(CONTRATO, HOY)).toEqual([
      '/api/profesionales',
      '/api/pacientes',
      '/api/turnos?fecha=2026-10-10',
      '/api/turnos/hoy',
      '/health',
    ]);
  });

  it('sin contrato no hay rutas', () => {
    expect(rutasDeHumo(undefined, HOY)).toEqual([]);
  });
});

describe('rutaDeLogin', () => {
  it('es el POST que dice login', () => {
    expect(rutaDeLogin(CONTRATO)).toBe('/api/auth/login');
  });
});

describe('credencialesDeHumo', () => {
  it('la cuenta de demo gana', () => {
    expect(
      credencialesDeHumo({ demo: { email: 'demo@x.com', password: 'd' }, md: 'admin@x.com / Admin123!' }),
    ).toEqual({ email: 'demo@x.com', password: 'd' });
  });

  it('si no hay demo, el usuario que fija el pliego', () => {
    const md = 'Login con email y contraseña (JWT). Un usuario admin sembrado: admin@turnero.com / Admin123!\n- Profesionales';
    expect(credencialesDeHumo({ md })).toEqual({ email: 'admin@turnero.com', password: 'Admin123!' });
  });

  it('sin nada de donde sacarlo, no hay', () => {
    expect(credencialesDeHumo({ md: 'una app sin login' })).toBeUndefined();
  });
});

describe('probarEnVivo', () => {
  function fetchFalso(porRuta: Record<string, { status: number; cuerpo: string }>) {
    const vistos: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const ruta = new URL(url).pathname + new URL(url).search;
      vistos.push({ url: ruta, auth: new Headers(init.headers).get('authorization') });
      const r = porRuta[ruta] ?? { status: 200, cuerpo: '[]' };
      return new Response(r.cuerpo, { status: r.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, vistos };
  }

  const BASE = 'https://prueba-completa-api.apps.punchi.dev';

  it('entra con el login y encuentra los 5xx', async () => {
    const { fetchImpl, vistos } = fetchFalso({
      '/api/auth/login': { status: 200, cuerpo: '{"token":"jwt"}' },
      '/api/pacientes': { status: 500, cuerpo: '{"error":"Ocurrió un error inesperado."}' },
    });
    const r = await probarEnVivo({ backUrl: BASE, contrato: CONTRATO, md: 'admin@turnero.com / Admin123!', hoy: HOY, fetchImpl });

    expect(r.entro).toBe(true);
    expect(r.probadas).toBe(5);
    expect(r.fallas).toEqual([{ ruta: '/api/pacientes', status: 500, cuerpo: '{"error":"Ocurrió un error inesperado."}' }]);
    expect(vistos.find((v) => v.url === '/api/pacientes')!.auth).toBe('Bearer jwt');
  });

  // Sin login las rutas protegidas dan 401, que no es un 5xx: la prueba no
  // diria nada. Tiene que quedar dicho que no pudo entrar.
  it('si no puede entrar, lo dice', async () => {
    const { fetchImpl } = fetchFalso({ '/api/auth/login': { status: 401, cuerpo: '{"error":"Credenciales incorrectas"}' } });
    const r = await probarEnVivo({ backUrl: BASE, contrato: CONTRATO, md: 'admin@x.com / mal', hoy: HOY, fetchImpl });
    expect(r.entro).toBe(false);
  });

  it('un back que no contesta es una falla', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await probarEnVivo({ backUrl: BASE, contrato: 'GET /health', md: '', hoy: HOY, fetchImpl });
    expect(r.fallas).toEqual([{ ruta: '/health', status: 0, cuerpo: expect.stringContaining('ECONNREFUSED') }]);
  });
});

describe('textoDeFallas', () => {
  it('nombra cada ruta con su status y el log del back', () => {
    const t = textoDeFallas(
      { probadas: 5, entro: true, fallas: [{ ruta: '/api/pacientes', status: 500, cuerpo: '{"error":"x"}' }] },
      'relation "Pacientes" does not exist',
    );
    expect(t).toContain('GET /api/pacientes -> 500');
    expect(t).toContain('relation "Pacientes" does not exist');
  });
});
