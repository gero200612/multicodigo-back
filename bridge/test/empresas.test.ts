import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { darDeAlta, crearUsuarioPorSql, type Consulta } from '../src/altas.js';

/**
 * Empresas, rangos y aislamiento, contra un Postgres de verdad (PGlite, en
 * WASM): RLS no se puede probar con dobles, lo que se prueba es que Postgres
 * le niegue filas a un usuario concreto.
 *
 * Corre TODAS las migraciones en orden, igual que el bridge al arrancar, y
 * despues las vuelve a correr: en produccion corren en cada arranque, asi que
 * la 040 tiene que ser idempotente.
 *
 * Lo de Supabase que las migraciones dan por hecho (roles, `auth`, `storage`,
 * los GRANT por defecto) se arma aca a mano.
 */

const MIGRACIONES = fileURLToPath(new URL('../migrations/', import.meta.url));
const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const ARCHIVOS = readdirSync(MIGRACIONES).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
// Tablas que en prod se crearon a mano desde `docs/` y que migraciones
// posteriores (024 en adelante) dan por existentes.
const DE_DOCS = [
  'supabase-repos.sql',
  'supabase-documentos.sql',
  'supabase-documentos-carpeta.sql',
  'supabase-github-instalaciones.sql',
  'supabase-slot-nombres.sql',
  'supabase-sin-cuota.sql',
  'supabase-db-conexion.sql',
];

const U = {
  gero: '00000000-0000-4000-8000-000000000001',
  pepe: '00000000-0000-4000-8000-000000000002',
  ana: '00000000-0000-4000-8000-000000000003',
  lucia: '00000000-0000-4000-8000-000000000004',
  otro: '00000000-0000-4000-8000-000000000005',
};
const VIEJO = '10000000-0000-4000-8000-000000000001';

let db: PGlite;
let docsHechos = false;

async function migrar(hasta?: string): Promise<void> {
  for (const f of ARCHIVOS) {
    if (hasta && f > hasta) break;
    if (f >= '024' && !docsHechos) {
      docsHechos = true;
      for (const d of DE_DOCS) await db.exec(readFileSync(DOCS + d, 'utf8'));
    }
    await db.exec(readFileSync(MIGRACIONES + f, 'utf8'));
  }
}

async function q<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  return (await db.query<R>(sql, params)).rows;
}

/** Corre `fn` como lo haria PostgREST con el JWT de `usuario` (o sin sesion). */
async function como<T>(usuario: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(
    `SELECT set_config('request.jwt.claim.sub', '${usuario ?? ''}', false);
     SET ROLE ${usuario ? 'authenticated' : 'anon'};`,
  );
  try {
    return await fn();
  } finally {
    // Sin JWT despues, como el bridge: si quedara cargado, un INSERT "de la base"
    // tomaria como dueño al ultimo usuario simulado.
    await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
  }
}

async function error(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const nombres = (u: string) =>
  como(u, () => q<{ nombre: string }>('SELECT nombre FROM proyectos ORDER BY nombre')).then((r) =>
    r.map((x) => x.nombre),
  );

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA storage;
    CREATE EXTENSION pgcrypto SCHEMA extensions;
    CREATE TABLE auth.users (
      instance_id uuid, id uuid PRIMARY KEY, aud text, role text, email text,
      encrypted_password text, email_confirmed_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb,
      created_at timestamptz, updated_at timestamptz,
      confirmation_token text, email_change text, email_change_token_new text, recovery_token text
    );
    CREATE TABLE auth.identities (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider_id text,
      identity_data jsonb, provider text, last_sign_in_at timestamptz,
      created_at timestamptz, updated_at timestamptz
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false,
                                  file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS
      $$ SELECT string_to_array(name, '/') $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    CREATE PUBLICATION supabase_realtime;
  `);
  for (const [nombre, id] of Object.entries(U)) {
    const email = nombre === 'gero' ? 'gero200612@gmail.com' : `${nombre}@multicodigo.app`;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
  }

  // El estado de antes de las empresas: gero dueño de "viejo" y pepe miembro.
  await migrar('039_despliegue.sql');
  await db.exec(`
    INSERT INTO proyectos (id, nombre) VALUES ('${VIEJO}', 'viejo');
    INSERT INTO miembros (proyecto_id, usuario_id, rol)
    VALUES ('${VIEJO}', '${U.gero}', 'dueño'), ('${VIEJO}', '${U.pepe}', 'miembro');
  `);
  await migrar();
  await migrar();
}, 120_000);

describe('migracion 040: lo que ya habia', () => {
  it('pasa todo a una empresa inicial sin que nadie gane ni pierda acceso', async () => {
    const empresas = await q<{ slug: string }>('SELECT slug FROM empresas');
    expect(empresas.map((e) => e.slug)).toEqual(['multicodigo']);

    const rangos = await q<{ usuario_id: string; rango: string }>(
      'SELECT usuario_id, rango FROM empresa_miembros',
    );
    expect(rangos).toContainEqual({ usuario_id: U.gero, rango: 'admin' });
    expect(rangos).toContainEqual({ usuario_id: U.pepe, rango: 'programador' });
    expect(await q('SELECT usuario_id FROM superadmins')).toEqual([{ usuario_id: U.gero }]);
    expect(await q('SELECT visibilidad FROM proyectos')).toEqual([{ visibilidad: 'privado' }]);
    expect(await nombres(U.pepe)).toEqual(['viejo']);
  });

  it('ninguna policy de escritura sigue con es_miembro (un lector podria escribir)', async () => {
    const pols = await q<{ qual: string | null; with_check: string | null }>(
      `SELECT qual, with_check FROM pg_policies WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE')`,
    );
    expect(pols.length).toBeGreaterThan(5);
    for (const p of pols) expect(`${p.qual} ${p.with_check}`).not.toMatch(/es_miembro\(/);
  });
});

describe('empresas, altas y aislamiento', () => {
  let acme = '';
  let tokenJefe = '';
  let publico = '';
  let privado = '';

  it('solo el superadmin crea empresas, y sale con el alta de su admin', async () => {
    const r = await como(U.gero, () =>
      q<{ r: { empresa_id: string; token: string } }>(`SELECT public.crear_empresa('Acme SA', 'acme', 'jefe') AS r`),
    );
    acme = r[0]!.r.empresa_id;
    tokenJefe = r[0]!.r.token;
    expect(tokenJefe).toMatch(/^[0-9a-f]{64}$/);
    expect(await error(() => como(U.pepe, () => q(`SELECT public.crear_empresa('X', 'xx', 'y')`)))).toMatch(
      /solo_superadmin/,
    );
    expect(await como(U.gero, () => q('SELECT * FROM public.empresas_resumen()'))).toHaveLength(2);
  });

  it('el alta se ve sin sesion, pero los tokens no se leen por REST', async () => {
    const v = await como(null, () => q<{ v: unknown }>('SELECT public.ver_alta($1) AS v', [tokenJefe]));
    expect(v[0]!.v).toEqual({ empresa: 'Acme SA', usuario: 'jefe', rango: 'admin' });
    expect((await como(null, () => q<{ v: unknown }>(`SELECT public.ver_alta('x') AS v`)))[0]!.v).toBeNull();
    expect(
      await como(U.pepe, () => q('SELECT token FROM invitaciones WHERE empresa_id IS NOT NULL')),
    ).toEqual([]);
  });

  it('canjear el alta crea la cuenta, la mete en la empresa y quema el link', async () => {
    await db.exec('BEGIN');
    const r = await darDeAlta(db as unknown as Consulta, tokenJefe, 'una-clave-larga', crearUsuarioPorSql);
    await db.exec('COMMIT');
    expect(r).toEqual({ estado: 'ok', email: 'jefe@multicodigo.app' });

    const u = await q<{ id: string; ok: boolean; confirmation_token: string }>(
      `SELECT id, encrypted_password = extensions.crypt('una-clave-larga', encrypted_password) AS ok,
              confirmation_token
         FROM auth.users WHERE email = 'jefe@multicodigo.app'`,
    );
    expect(u[0]!.ok).toBe(true);
    expect(u[0]!.confirmation_token).toBe('');
    expect(await q('SELECT provider FROM auth.identities WHERE user_id = $1', [u[0]!.id])).toEqual([
      { provider: 'email' },
    ]);
    expect(await q('SELECT rango FROM empresa_miembros WHERE usuario_id = $1', [u[0]!.id])).toEqual([
      { rango: 'admin' },
    ]);

    await db.exec('BEGIN');
    expect(await darDeAlta(db as unknown as Consulta, tokenJefe, 'otra-clave-larga', crearUsuarioPorSql)).toEqual({
      estado: 'usada',
    });
    await db.exec('ROLLBACK');
  });

  it('el alta rechaza claves cortas y links inventados sin tocar nada', async () => {
    await db.exec('BEGIN');
    expect(await darDeAlta(db as unknown as Consulta, 'nada', 'una-clave-larga', crearUsuarioPorSql)).toEqual({
      estado: 'desconocida',
    });
    expect(await darDeAlta(db as unknown as Consulta, tokenJefe, 'corta', crearUsuarioPorSql)).toEqual({
      estado: 'clave_invalida',
    });
    await db.exec('ROLLBACK');
  });

  it('el admin da altas en SU empresa y nadie mas', async () => {
    await db.exec(`
      INSERT INTO empresa_miembros (empresa_id, usuario_id, rango) VALUES
        ('${acme}', '${U.ana}', 'admin'), ('${acme}', '${U.lucia}', 'lector'), ('${acme}', '${U.otro}', 'programador');
    `);
    const t = await como(U.ana, () => q<{ t: string }>(`SELECT public.crear_alta($1, 'nuevo', 'programador') AS t`, [acme]));
    expect(t[0]!.t).toMatch(/^[0-9a-f]{64}$/);
    const multicodigo = (await q<{ id: string }>(`SELECT id FROM empresas WHERE slug = 'multicodigo'`))[0]!.id;
    expect(await error(() => como(U.ana, () => q(`SELECT public.crear_alta($1, 'x1', 'admin')`, [multicodigo])))).toMatch(/solo_admin/);
    expect(await error(() => como(U.otro, () => q(`SELECT public.crear_alta($1, 'x2', 'admin')`, [acme])))).toMatch(/solo_admin/);
    expect(await error(() => como(U.ana, () => q(`SELECT public.crear_alta($1, 'pepe', 'lector')`, [acme])))).toMatch(/usuario_existe/);
    expect(await error(() => como(U.ana, () => q(`SELECT public.crear_alta($1, 'nuevo', 'lector')`, [acme])))).toMatch(/alta_pendiente/);
    expect(await error(() => como(U.ana, () => q(`SELECT public.crear_alta($1, 'con espacio', 'lector')`, [acme])))).toMatch(/usuario_invalido/);
    expect(await como(U.ana, () => q('SELECT * FROM public.gente_de_empresa($1)', [acme]))).toHaveLength(4);
    expect(await error(() => como(U.ana, () => q('SELECT * FROM public.gente_de_empresa($1)', [multicodigo])))).toMatch(/solo_admin/);
    expect((await como(U.ana, () => q<{ p: { rango: string } }>('SELECT public.mi_perfil() AS p')))[0]!.p.rango).toBe('admin');
  });

  it('solo el admin crea proyectos, y cada uno ve lo que le toca', async () => {
    expect(await error(() => como(U.otro, () => q(`SELECT public.crear_proyecto_en_empresa('p-otro')`)))).toMatch(/solo_admin/);
    expect(
      await error(() => como(U.otro, () => q(`INSERT INTO proyectos (nombre, empresa_id) VALUES ('directo', $1)`, [acme]))),
    ).not.toBe('');
    publico = (await como(U.ana, () => q<{ id: string }>(`SELECT public.crear_proyecto_en_empresa('acme-web', 'publico') AS id`)))[0]!.id;
    privado = (await como(U.ana, () => q<{ id: string }>(`SELECT public.crear_proyecto_en_empresa('acme-secreto') AS id`)))[0]!.id;
    // El nombre sigue siendo unico en toda la plataforma.
    expect(await error(() => como(U.ana, () => q(`SELECT public.crear_proyecto_en_empresa('viejo')`)))).not.toBe('');

    expect(await nombres(U.otro)).toEqual(['acme-web']);
    expect(await nombres(U.lucia)).toEqual(['acme-web']);
    expect(await nombres(U.ana)).toEqual(['acme-secreto', 'acme-web']);
    expect(await nombres(U.pepe)).toEqual(['viejo']);
    expect(await nombres(U.gero)).toEqual(['acme-secreto', 'acme-web', 'viejo']);
  });

  it('por REST un programador no hace publico un privado ni se lleva el proyecto a otra empresa', async () => {
    await como(U.ana, () => q('SELECT public.asignar($1, $2)', [privado, U.otro]));
    const multicodigo = (await q<{ id: string }>(`SELECT id FROM empresas WHERE slug = 'multicodigo'`))[0]!.id;
    // Por REST nadie escribe proyectos: lo frena el GRANT.
    expect(
      await error(() => como(U.otro, () => q(`UPDATE proyectos SET visibilidad = 'publico' WHERE id = $1`, [privado]))),
    ).toMatch(/permission denied/);
    expect(
      await error(() => como(U.ana, () => q('UPDATE proyectos SET empresa_id = $1 WHERE id = $2', [multicodigo, privado]))),
    ).toMatch(/permission denied/);
    expect(
      await error(() => como(U.otro, () => q(`UPDATE proyectos SET tareas = '{"test":["sh","-c","x"]}' WHERE id = $1`, [privado]))),
    ).toMatch(/permission denied/);

    // Y si un GRANT futuro lo reabre, queda el trigger: se prueba solo,
    // dandole UPDATE a mano a `authenticated`.
    await db.exec('GRANT UPDATE ON public.proyectos TO authenticated');
    try {
      expect(
        await error(() => como(U.otro, () => q(`UPDATE proyectos SET visibilidad = 'publico' WHERE id = $1`, [privado]))),
      ).toMatch(/solo_admin/);
      expect(
        await error(() => como(U.ana, () => q('UPDATE proyectos SET empresa_id = $1 WHERE id = $2', [multicodigo, privado]))),
      ).toMatch(/no_se_cambia_de_empresa/);
    } finally {
      await db.exec('REVOKE UPDATE ON public.proyectos FROM authenticated');
    }

    await como(U.ana, () => q('SELECT public.cambiar_visibilidad($1, $2)', [privado, 'privado']));
    await como(U.ana, () => q('SELECT public.desasignar($1, $2)', [privado, U.otro]));
  });

  it('la connection string de la base del proyecto no se lee por REST', async () => {
    await db.query(`UPDATE proyectos SET db_conexion = 'postgres://x:secreta@h/db' WHERE id = $1`, [publico]);
    expect(await error(() => como(U.lucia, () => q('SELECT db_conexion FROM proyectos')))).toMatch(/permission denied/);
    expect(await error(() => como(U.ana, () => q('SELECT * FROM proyectos')))).toMatch(/permission denied/);
    expect(await como(U.lucia, () => q('SELECT id, nombre, visibilidad FROM proyectos'))).toHaveLength(1);
  });

  it('un alta es siempre de un usuario interno, nunca de un mail ajeno', async () => {
    expect(
      await error(() => como(U.ana, () => q(`SELECT public.crear_alta($1, 'alguien@gmail.com', 'lector')`, [acme]))),
    ).toMatch(/usuario_invalido/);
  });

  it('asignar abre un privado, solo a gente de la misma empresa', async () => {
    await como(U.ana, () => q('SELECT public.asignar($1, $2)', [privado, U.otro]));
    expect(await nombres(U.otro)).toEqual(['acme-secreto', 'acme-web']);
    expect(await error(() => como(U.ana, () => q('SELECT public.asignar($1, $2)', [privado, U.pepe])))).toMatch(/no_es_de_la_empresa/);
    expect(await error(() => como(U.otro, () => q('SELECT public.asignar($1, $2)', [privado, U.lucia])))).toMatch(/solo_admin/);
    await como(U.ana, () => q('SELECT public.desasignar($1, $2)', [privado, U.otro]));
    expect(await nombres(U.otro)).toEqual(['acme-web']);
  });

  it('el lector mira pero no escribe', async () => {
    await db.query(`INSERT INTO agentes (slot, proyecto_id) VALUES ('c50', $1)`, [publico]);
    expect(await como(U.lucia, () => q(`UPDATE agentes SET nombre = 'x' WHERE slot = 'c50' RETURNING slot`))).toEqual([]);
    expect(await como(U.otro, () => q(`UPDATE agentes SET nombre = 'y' WHERE slot = 'c50' RETURNING slot`))).toHaveLength(1);
    expect(await como(U.lucia, () => q('SELECT slot FROM agentes'))).toHaveLength(1);
    expect(await como(U.pepe, () => q('SELECT slot FROM agentes'))).toEqual([]);
    expect((await como(U.lucia, () => q<{ p: boolean }>('SELECT public.puede_escribir($1) AS p', [publico])))[0]!.p).toBe(false);
  });

  it('aprobar es escribir: el lector ve la aprobacion pero no la decide', async () => {
    const id = '20000000-0000-4000-8000-000000000001';
    await db.query(
      `INSERT INTO approvals (approval_id, job_id, chat_id, message_id, agent, tool, summary, proyecto_id)
       VALUES ($1, gen_random_uuid(), 1, 1, 'c50', 'Bash', 'git push', $2)`,
      [id, publico],
    );
    const decide = (u: string) =>
      como(u, () => q<{ p: boolean }>('SELECT public.puede_decidir($1) AS p', [id])).then((r) => r[0]!.p);
    expect(await como(U.lucia, () => q('SELECT approval_id FROM approvals'))).toHaveLength(1);
    expect(await decide(U.lucia)).toBe(false);
    expect(await decide(U.otro)).toBe(true);
    expect(await decide(U.pepe)).toBe(false);
  });

  it('el bridge usa la misma regla: acceso_a_proyecto', async () => {
    const acc = (u: string, p: string) =>
      q<{ a: string | null }>('SELECT public.acceso_a_proyecto($1, $2) AS a', [u, p]).then((r) => r[0]!.a);
    expect(await acc(U.otro, publico)).toBe('escribir');
    expect(await acc(U.lucia, publico)).toBe('ver');
    expect(await acc(U.otro, privado)).toBeNull();
    expect(await acc(U.pepe, publico)).toBeNull();
    expect(await acc(U.gero, privado)).toBe('escribir');
    // Cerrada para el navegador: dejaria preguntar por el acceso de otro.
    expect(await error(() => como(U.otro, () => q('SELECT public.acceso_a_proyecto($1, $2)', [U.ana, privado])))).not.toBe('');
  });

  it('una empresa nunca se queda sin admin', async () => {
    const jefe = (await q<{ id: string }>(`SELECT id FROM auth.users WHERE email = 'jefe@multicodigo.app'`))[0]!.id;
    await como(U.ana, () => q(`SELECT public.cambiar_rango($1, $2, 'lector')`, [acme, jefe]));
    expect(await error(() => como(U.ana, () => q(`SELECT public.cambiar_rango($1, $2, 'programador')`, [acme, U.ana])))).toMatch(/ultimo_admin/);
    expect(await error(() => como(U.ana, () => q('SELECT public.quitar_de_empresa($1, $2)', [acme, U.ana])))).toMatch(/ultimo_admin/);
    await como(U.ana, () => q(`SELECT public.cambiar_rango($1, $2, 'admin')`, [acme, U.otro]));
    await como(U.otro, () => q('SELECT public.quitar_de_empresa($1, $2)', [acme, U.ana]));
    expect(await nombres(U.ana)).toEqual([]);
  });

  it('las invitaciones por proyecto quedan cerradas', async () => {
    expect(await error(() => como(U.gero, () => q(`SELECT public.invitar($1, 'x@y.z', 'miembro')`, [publico])))).toMatch(/usar_altas/);
  });

  it('volver a arrancar no re-mete a nadie ni duplica la empresa inicial', async () => {
    await migrar();
    expect(await q('SELECT 1 FROM empresa_miembros WHERE usuario_id = $1', [U.ana])).toEqual([]);
    expect(await q('SELECT id FROM empresas')).toHaveLength(2);
  });
});

describe('041: Claudes por persona y grupos', () => {
  let acme = '';
  let web = '';
  let grupo = '';
  const usa = (u: string, slot: string) =>
    q<{ p: boolean }>('SELECT public.puede_usar_slot($1, $2) AS p', [u, slot]).then((r) => r[0]!.p);

  beforeAll(async () => {
    acme = (await q<{ id: string }>(`SELECT id FROM empresas WHERE slug = 'acme'`))[0]!.id;
    web = (await q<{ id: string }>(`SELECT id FROM proyectos WHERE nombre = 'acme-web'`))[0]!.id;
    // ana volvio a la empresa como programadora (la 040 la habia sacado).
    await db.query(`INSERT INTO empresa_miembros (empresa_id, usuario_id, rango) VALUES ($1, $2, 'programador')`, [acme, U.ana]);
  });

  it('el slot que crea una persona por REST queda a su nombre, y no puede elegir otro dueño', async () => {
    await como(U.otro, () => q(`INSERT INTO agentes (slot, proyecto_id) VALUES ('c60', $1)`, [web]));
    expect(await q('SELECT usuario_id FROM agentes WHERE slot = $1', ['c60'])).toEqual([{ usuario_id: U.otro }]);
    expect(
      await error(() => como(U.ana, () => q(`INSERT INTO agentes (slot, proyecto_id, usuario_id) VALUES ('c61', $1, $2)`, [web, U.otro]))),
    ).toMatch(/permission denied/);
    expect(
      await error(() => como(U.ana, () => q(`UPDATE agentes SET usuario_id = $1 WHERE slot = 'c60'`, [U.ana]))),
    ).toMatch(/permission denied/);
    // El nombre si se cambia.
    expect(await como(U.otro, () => q(`UPDATE agentes SET nombre = 'mio' WHERE slot = 'c60' RETURNING slot`))).toHaveLength(1);
  });

  it('un Claude propio lo usa solo su dueño; uno de antes (sin dueño), quien escribe en el proyecto', async () => {
    expect(await usa(U.otro, 'c60')).toBe(true);
    expect(await usa(U.ana, 'c60')).toBe(false);
    expect(await usa(U.lucia, 'c60')).toBe(false);
    // c50 lo inserto la base sin JWT: es de antes.
    expect(await usa(U.ana, 'c50')).toBe(true);
    expect(await usa(U.lucia, 'c50')).toBe(false);
    expect(await usa(U.pepe, 'c50')).toBe(false);
    expect(await usa(U.gero, 'c60')).toBe(true);
  });

  it('compartir con un grupo le da el Claude a los del grupo y a nadie mas', async () => {
    grupo = (await como(U.otro, () => q<{ id: string }>(`SELECT public.crear_grupo('backend') AS id`)))[0]!.id;
    await como(U.otro, () => q('SELECT public.sumar_a_grupo($1, $2)', [grupo, U.ana]));
    expect(await error(() => como(U.otro, () => q('SELECT public.sumar_a_grupo($1, $2)', [grupo, U.pepe])))).toMatch(/no_es_de_la_empresa/);
    expect(await error(() => como(U.otro, () => q('SELECT public.sumar_a_grupo($1, $2)', [grupo, U.lucia])))).toMatch(/no_es_de_la_empresa/);
    expect(await error(() => como(U.ana, () => q('SELECT public.compartir_claude($1, $2)', ['c60', grupo])))).toMatch(/no_es_tu_claude/);
    expect(await error(() => como(U.lucia, () => q(`SELECT public.crear_grupo('x')`)))).toMatch(/solo_lectura/);

    await como(U.otro, () => q('SELECT public.compartir_claude($1, $2)', ['c60', grupo]));
    expect(await usa(U.ana, 'c60')).toBe(true);
    expect(await usa(U.lucia, 'c60')).toBe(false);

    const deAna = await como(U.ana, () => q<{ slot: string; es_mio: boolean }>('SELECT slot, es_mio FROM public.mis_claudes()'));
    expect(deAna.map((x) => x.slot)).toEqual(['c50', 'c60']);
    const grupos = await como(U.ana, () => q<{ nombre: string; soy_duenio: boolean }>('SELECT nombre, soy_duenio FROM public.mis_grupos()'));
    expect(grupos).toEqual([{ nombre: 'backend', soy_duenio: false }]);
    expect(await como(U.pepe, () => q('SELECT id FROM grupos'))).toEqual([]);
  });

  it('salir del grupo, o que lo borren, le saca el Claude', async () => {
    await como(U.ana, () => q('SELECT public.sacar_de_grupo($1, $2)', [grupo, U.ana]));
    expect(await usa(U.ana, 'c60')).toBe(false);
    await como(U.otro, () => q('SELECT public.sumar_a_grupo($1, $2)', [grupo, U.ana]));
    await como(U.otro, () => q('SELECT public.borrar_grupo($1)', [grupo]));
    expect(await usa(U.ana, 'c60')).toBe(false);
    expect(await q('SELECT grupo_id FROM agentes WHERE slot = $1', ['c60'])).toEqual([{ grupo_id: null }]);
  });

  it('companeros lista la gente de mi empresa, no la de otras', async () => {
    const c = await como(U.ana, () => q<{ usuario_id: string }>('SELECT usuario_id FROM public.companeros()'));
    expect(c.map((x) => x.usuario_id)).toContain(U.otro);
    expect(c.map((x) => x.usuario_id)).not.toContain(U.pepe);
    expect(await error(() => como(U.ana, () => q('SELECT public.puede_usar_slot($1, $2)', [U.otro, 'c60'])))).not.toBe('');
  });
});
