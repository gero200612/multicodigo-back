import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registrarSupabase, esSqlPeligroso } from '../src/supabase-api.js';

const API_TOKEN = 'token-de-api-del-bridge';
const JOB = '00000000-0000-4000-8000-000000000001';

/**
 * Supabase, del lado del bridge.
 *
 * Lo que se prueba es sobre todo lo que NO se puede hacer: la ruta de borrar no
 * existe, y una migracion que borra se rechaza antes de salir a la red.
 */
async function servidor(
  opciones: {
    fetchImpl?: typeof fetch;
    conToken?: boolean;
    guardarConexion?: (jobId: string, conexion: string) => Promise<void>;
  } = {},
) {
  const app = Fastify();
  registrarSupabase(app, {
    apiToken: API_TOKEN,
    ...(opciones.conToken === false
      ? {}
      : { accessToken: 'sbp_falso', orgId: 'org_falsa' }),
    ...(opciones.fetchImpl ? { fetchImpl: opciones.fetchImpl } : {}),
    ...(opciones.guardarConexion ? { guardarConexion: opciones.guardarConexion } : {}),
  });
  await app.ready();
  return app;
}

const auth = { authorization: `Bearer ${API_TOKEN}` };

describe('esSqlPeligroso', () => {
  // Los cuatro accidentes que esta lista viene a atajar. No es una defensa
  // contra un adversario —del otro lado hay un modelo trabajando— sino contra
  // la migracion que "limpia" a las tres de la mañana.
  for (const sql of [
    'DROP TABLE clientes;',
    'drop table clientes;',
    'TRUNCATE pedidos;',
    'DELETE FROM pedidos;',
    'DROP SCHEMA public CASCADE;',
    'ALTER TABLE x DROP COLUMN y;',
  ]) {
    it(`rechaza: ${sql}`, () => {
      const m = esSqlPeligroso(sql);
      expect(m).toBeDefined();
      // El mensaje lo repite el modelo: sin el "no lo intentes" queda en loop.
      expect(m).toContain('una persona');
    });
  }

  // Lo que SI tiene que pasar: una migracion normal.
  for (const sql of [
    'CREATE TABLE lotes (id serial primary key);',
    'ALTER TABLE lotes ADD COLUMN vencimiento date;',
    'CREATE INDEX ON lotes (vencimiento);',
    // Un DELETE acotado no es una limpieza masiva.
    "DELETE FROM lotes WHERE id = 3;",
  ]) {
    it(`deja pasar: ${sql}`, () => {
      expect(esSqlPeligroso(sql)).toBeUndefined();
    });
  }
});

describe('POST /interno/supabase/crear', () => {
  it('crea el proyecto y devuelve la ref', async () => {
    let visto: Record<string, unknown> = {};
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      visto = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ref: 'abcdef' }), { status: 201 });
    });
    const app = await servidor({ fetchImpl: f as unknown as typeof fetch });

    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toContain('abcdef');
    expect(visto.name).toBe('acme');
  });

  // La contraseña se genera acá y NO vuelve: si viajara, quedaria en el
  // contexto del modelo y de ahi en la transcripcion del turno, que se guarda.
  it('no devuelve la contraseña de la base', async () => {
    let visto: Record<string, unknown> = {};
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      visto = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ref: 'abcdef' }), { status: 201 });
    });
    const app = await servidor({ fetchImpl: f as unknown as typeof fetch });

    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });
    expect(String(visto.db_pass).length).toBeGreaterThan(20);
    expect(res.payload).not.toContain(String(visto.db_pass));
  });

  it('sin token configurado avisa en vez de fallar', async () => {
    const app = await servidor({ conToken: false });
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('sin_supabase');
  });

  it('rechaza sin bearer', async () => {
    const app = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      payload: { jobId: JOB, nombre: 'acme' },
    });
    expect(res.statusCode).toBe(401);
  });

  // El cuerpo de Supabase puede traer la connection string del proyecto, y este
  // texto termina en un chat.
  it('no propaga el cuerpo del error de Supabase', async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'postgres://user:secreto@host/db' }), {
          status: 500,
        }),
    );
    const app = await servidor({ fetchImpl: f as unknown as typeof fetch });
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.payload).not.toContain('secreto');
  });
});

describe('POST /interno/supabase/migrar', () => {
  it('aplica una migracion normal', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 201 }));
    const app = await servidor({ fetchImpl: f as unknown as typeof fetch });
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/migrar',
      headers: auth,
      payload: { jobId: JOB, ref: 'abc', nombre: 'lotes', sql: 'CREATE TABLE lotes (id int);' },
    });
    expect(res.statusCode).toBe(200);
    expect(f).toHaveBeenCalled();
  });

  // El chequeo va ANTES de salir a la red: una migracion que borra no se manda
  // y despues se lamenta.
  it('un DROP no llega a Supabase', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 201 }));
    const app = await servidor({ fetchImpl: f as unknown as typeof fetch });
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/migrar',
      headers: auth,
      payload: { jobId: JOB, ref: 'abc', nombre: 'limpiar', sql: 'DROP TABLE clientes;' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('sql_peligroso');
    expect(f).not.toHaveBeenCalled();
  });

  it('rechaza sin bearer', async () => {
    const app = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/migrar',
      payload: { jobId: JOB, ref: 'a', nombre: 'x', sql: 'SELECT 1' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// La contencion entera del diseño: para que el agente pueda borrar una base
// habria que ESCRIBIR el endpoint. Si algun dia aparece, este test se rompe.
describe('las rutas que no existen', () => {
  for (const ruta of ['borrar', 'eliminar', 'pausar', 'restaurar']) {
    it(`no hay /interno/supabase/${ruta}`, async () => {
      const app = await servidor();
      const res = await app.inject({
        method: 'POST',
        url: `/interno/supabase/${ruta}`,
        headers: auth,
        payload: { jobId: JOB, ref: 'abc' },
      });
      expect(res.statusCode).toBe(404);
    });
  }
});

/**
 * La conexion a la base, guardada del lado del servidor.
 *
 * Es el tramo que faltaba: la base quedaba creada y migrada, y la connection
 * string la tenia que copiar una persona —el pendiente "configurar en
 * produccion" de todos los informes—. Ahora la guarda el bridge, que es el
 * unico que tiene la contraseña, y `publicar()` se la escribe al back.
 *
 * La regla que no cambia: la contraseña NO vuelve en la respuesta ni llega al
 * modelo.
 */
describe('la conexion a la base queda guardada, sin pasar por el modelo', () => {
  function supabaseFalso(guardadas: Array<{ jobId: string; conexion: string }>) {
    let creado: Record<string, unknown> = {};
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.includes('/config/database/pooler')) {
        return new Response(
          JSON.stringify({
            db_host: 'aws-0-sa-east-1.pooler.supabase.com',
            db_port: 5432,
            db_name: 'postgres',
            db_user: 'postgres.abcdef',
          }),
          { status: 200 },
        );
      }
      creado = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ref: 'abcdef' }), { status: 201 });
    });
    return {
      f,
      creado: () => creado,
      guardar: async (jobId: string, conexion: string) => {
        guardadas.push({ jobId, conexion });
      },
    };
  }

  it('arma la cadena del POOLER con la clave que genero', async () => {
    const guardadas: Array<{ jobId: string; conexion: string }> = [];
    const falso = supabaseFalso(guardadas);
    const app = await servidor({
      fetchImpl: falso.f as unknown as typeof fetch,
      guardarConexion: falso.guardar,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });

    expect(res.statusCode).toBe(200);
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]!.jobId).toBe(JOB);
    // Por el pooler y no por `db.<ref>.supabase.co`: la conexion directa es
    // IPv6 y las plataformas donde esto se despliega salen por IPv4.
    expect(guardadas[0]!.conexion).toContain('Host=aws-0-sa-east-1.pooler.supabase.com');
    expect(guardadas[0]!.conexion).toContain('Username=postgres.abcdef');
    // Es la MISMA clave que se le mando a Supabase al crear el proyecto.
    expect(guardadas[0]!.conexion).toContain(`Password=${String(falso.creado().db_pass)}`);
  });

  it('la clave sigue sin volver en la respuesta', async () => {
    const guardadas: Array<{ jobId: string; conexion: string }> = [];
    const falso = supabaseFalso(guardadas);
    const app = await servidor({
      fetchImpl: falso.f as unknown as typeof fetch,
      guardarConexion: falso.guardar,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });

    expect(res.payload).not.toContain(String(falso.creado().db_pass));
  });

  // Si el pooler no contesta, la base igual queda creada: lo que se pierde es
  // la comodidad, no el trabajo.
  it('si no se puede averiguar el pooler, no rompe el crear', async () => {
    const guardadas: Array<{ jobId: string; conexion: string }> = [];
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/config/database/pooler')) {
        return new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify({ ref: 'abcdef' }), { status: 201 });
    });
    const app = await servidor({
      fetchImpl: f as unknown as typeof fetch,
      guardarConexion: async (jobId, conexion) => {
        guardadas.push({ jobId, conexion });
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/interno/supabase/crear',
      headers: auth,
      payload: { jobId: JOB, nombre: 'acme' },
    });

    expect(res.statusCode).toBe(200);
    expect(guardadas).toHaveLength(0);
  });
});
