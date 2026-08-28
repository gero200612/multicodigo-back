import { describe, it, expect, beforeAll } from 'vitest';

/**
 * RLS no se puede testear con mocks: lo que se prueba es que Postgres le
 * niegue filas a un JWT concreto. Va por PostgREST, que es el camino real del
 * panel.
 *
 * Se saltea sin credenciales para que `pnpm test` siga siendo offline.
 */
const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const usuarioA = process.env.RLS_TEST_EMAIL_A;
const claveA = process.env.RLS_TEST_PASSWORD_A;
const usuarioB = process.env.RLS_TEST_EMAIL_B;
const claveB = process.env.RLS_TEST_PASSWORD_B;

const hayCredenciales = Boolean(url && anon && usuarioA && claveA && usuarioB && claveB);

async function token(email: string, password: string): Promise<string> {
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon!, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login fallo: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function leerProyectos(jwt: string): Promise<{ nombre: string }[]> {
  const r = await fetch(`${url}/rest/v1/proyectos?select=nombre`, {
    headers: { apikey: anon!, authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`select fallo: ${r.status} ${await r.text()}`);
  return (await r.json()) as { nombre: string }[];
}

describe.skipIf(!hayCredenciales)('RLS por membresia', () => {
  let jwtA = '';
  let jwtB = '';

  beforeAll(async () => {
    jwtA = await token(usuarioA!, claveA!);
    jwtB = await token(usuarioB!, claveB!);
  });

  it('cada usuario ve solo los proyectos donde es miembro', async () => {
    const deA = await leerProyectos(jwtA);
    const deB = await leerProyectos(jwtB);

    // El fixture deja a A en 'rls-proyecto-a' y a B en 'rls-proyecto-b'.
    expect(deA.map((p) => p.nombre)).toContain('rls-proyecto-a');
    expect(deA.map((p) => p.nombre)).not.toContain('rls-proyecto-b');
    expect(deB.map((p) => p.nombre)).toContain('rls-proyecto-b');
    expect(deB.map((p) => p.nombre)).not.toContain('rls-proyecto-a');
  });

  it('un usuario no puede meterse a un proyecto ajeno escribiendo la membresia', async () => {
    const r = await fetch(`${url}/rest/v1/miembros`, {
      method: 'POST',
      headers: {
        apikey: anon!,
        authorization: `Bearer ${jwtA}`,
        'content-type': 'application/json',
      },
      // Se apunta al proyecto de B a ciegas: si RLS estuviera mal, esto entra.
      body: JSON.stringify({
        proyecto_id: '00000000-0000-4000-8000-000000000002',
        usuario_id: '00000000-0000-4000-8000-000000000009',
        rol: 'miembro',
      }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
