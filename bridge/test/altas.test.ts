import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registrarAltas, crearUsuarioPorApi, darDeAlta, claveValida, type Consulta } from '../src/altas.js';

const TOKEN = 'token-interno-del-bridge-largo';

function servidor(darDeAlta?: Parameters<typeof registrarAltas>[1]['darDeAlta']) {
  const app = Fastify();
  registrarAltas(app, { apiToken: TOKEN, darDeAlta });
  return app;
}

const pedir = (app: ReturnType<typeof servidor>, cuerpo: unknown, bearer = TOKEN) =>
  app.inject({
    method: 'POST',
    url: '/interno/alta',
    headers: { authorization: `Bearer ${bearer}` },
    payload: cuerpo as Record<string, unknown>,
  });

describe('POST /interno/alta', () => {
  it('sin el token interno no entra nadie', async () => {
    const r = await pedir(servidor(async () => ({ estado: 'ok', email: 'x' })), { token: 't', clave: 'c' }, 'otro');
    expect(r.statusCode).toBe(401);
  });

  it('sin store con alta contesta 503 en vez de fingir', async () => {
    const r = await pedir(servidor(undefined), { token: 't', clave: 'una-clave-larga' });
    expect(r.statusCode).toBe(503);
  });

  it('devuelve el mail de la cuenta creada', async () => {
    const alta = vi.fn(async () => ({ estado: 'ok' as const, email: 'pedro@multicodigo.app' }));
    const r = await pedir(servidor(alta), { token: 'abc', clave: 'una-clave-larga' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ email: 'pedro@multicodigo.app' });
    expect(alta).toHaveBeenCalledWith('abc', 'una-clave-larga');
  });

  it('cada motivo de rechazo vuelve con su codigo y un mensaje para la persona', async () => {
    const r = await pedir(servidor(async () => ({ estado: 'vencida' })), { token: 'abc', clave: 'una-clave-larga' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'alta_vencida' });
    expect(r.json().message).toMatch(/venció/);
  });

  it('un error inesperado es un 503 sin detalles', async () => {
    const r = await pedir(
      servidor(async () => {
        throw new Error('detalle interno de postgres');
      }),
      { token: 'abc', clave: 'una-clave-larga' },
    );
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toMatch(/postgres/);
  });
});

describe('claveValida', () => {
  it('pide al menos 8 y no mas de 72 bytes (lo que mira bcrypt)', () => {
    expect(claveValida('1234567')).toBe(false);
    expect(claveValida('12345678')).toBe(true);
    expect(claveValida('x'.repeat(72))).toBe(true);
    expect(claveValida('x'.repeat(73))).toBe(false);
    expect(claveValida('ñ'.repeat(37))).toBe(false);
  });
});

describe('crearUsuarioPorApi', () => {
  it('crea la cuenta confirmada y, si lo que sigue falla, la borra', async () => {
    const llamadas: Array<{ url: string; metodo: string; cuerpo?: string }> = [];
    const pedir = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      llamadas.push({ url: String(url), metodo: init?.method ?? 'GET', cuerpo: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
    }) as unknown as typeof fetch;

    // Una base de mentira donde la invitacion existe y el INSERT de la
    // membresia falla: el alta tiene que deshacer la cuenta de Auth.
    const c: Consulta = {
      query: async (sql: string) => {
        if (sql.includes('FROM invitaciones')) {
          return { rows: [{ id: 'i', empresa_id: 'e', rango: 'programador', email: 'p@multicodigo.app', vencida: false, aceptada_en: null }] } as never;
        }
        if (sql.includes('FROM auth.users')) return { rows: [] };
        if (sql.includes('INSERT INTO empresa_miembros')) throw new Error('choque');
        return { rows: [] };
      },
    };

    await expect(
      darDeAlta(c, 'tok', 'una-clave-larga', crearUsuarioPorApi('https://x.supabase.co/', 'service', pedir)),
    ).rejects.toThrow('choque');

    expect(llamadas[0]).toMatchObject({ url: 'https://x.supabase.co/auth/v1/admin/users', metodo: 'POST' });
    expect(JSON.parse(llamadas[0]!.cuerpo!)).toEqual({
      email: 'p@multicodigo.app',
      password: 'una-clave-larga',
      email_confirm: true,
    });
    expect(llamadas[1]).toMatchObject({ url: 'https://x.supabase.co/auth/v1/admin/users/u-1', metodo: 'DELETE' });
  });
});
