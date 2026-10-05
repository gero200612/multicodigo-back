import type { FastifyInstance } from 'fastify';
import { isTokenValid } from '@multicodigo/shared';
import { z } from 'zod';

/**
 * El alta de una persona en una empresa: canjea el link que armó el admin y
 * crea la cuenta.
 *
 * Spec: docs/superpowers/specs/2026-10-04-empresas-design.md
 *
 * Vive en el bridge y no en el panel porque crear una cuenta de Supabase pide
 * algo que el panel no tiene a propósito: la `service_role`, o escribir en el
 * esquema `auth`. El bridge ya entra a la base como `postgres`.
 *
 * El registro libre de Supabase está APAGADO (`disable_signup`): este es el
 * único camino para que exista una cuenta nueva, y solo se abre con un token
 * que dio un admin.
 */

/** Lo que hace falta de un cliente de `pg` adentro de una transacción. */
export interface Consulta {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface UsuarioCreado {
  id: string;
  /**
   * Si la cuenta se creó FUERA de la transacción (Admin API), cómo borrarla
   * cuando lo que sigue falla. Sin esto quedaría una cuenta sin empresa con
   * el usuario tomado, y el alta no se podría reintentar.
   */
  deshacer?: () => Promise<void>;
}

export type CrearUsuario = (c: Consulta, email: string, password: string) => Promise<UsuarioCreado>;

export type ResultadoAlta =
  | { estado: 'ok'; email: string }
  | { estado: 'desconocida' | 'usada' | 'vencida' | 'usuario_existe' | 'clave_invalida' };

/** bcrypt solo mira los primeros 72 bytes: más largo daría una falsa sensación de seguridad. */
export const CLAVE_MINIMA = 8;
export const CLAVE_MAXIMA = 72;

export function claveValida(clave: string): boolean {
  return clave.length >= CLAVE_MINIMA && Buffer.byteLength(clave, 'utf8') <= CLAVE_MAXIMA;
}

/**
 * Canjea el token y crea la cuenta. Corre adentro de una transacción que abre
 * quien llama: si cualquier paso falla, no queda ni la cuenta ni la membresía
 * ni el token quemado.
 */
export async function darDeAlta(
  c: Consulta,
  token: string,
  clave: string,
  crearUsuario: CrearUsuario,
): Promise<ResultadoAlta> {
  if (!claveValida(clave)) return { estado: 'clave_invalida' };

  // FOR UPDATE: dos pestañas abriendo el mismo link no pueden pasar las dos.
  const inv = (
    await c.query<{
      id: string;
      empresa_id: string;
      rango: string;
      email: string;
      vencida: boolean;
      aceptada_en: Date | null;
    }>(
      `SELECT id, empresa_id, rango, email, expira_en <= now() AS vencida, aceptada_en
         FROM invitaciones
        WHERE token = $1 AND empresa_id IS NOT NULL
        FOR UPDATE`,
      [token],
    )
  ).rows[0];

  if (!inv) return { estado: 'desconocida' };
  if (inv.aceptada_en) return { estado: 'usada' };
  if (inv.vencida) return { estado: 'vencida' };

  const ya = await c.query(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [inv.email]);
  if (ya.rows.length > 0) return { estado: 'usuario_existe' };

  const usuario = await crearUsuario(c, inv.email, clave);
  try {
    await c.query(
      `INSERT INTO empresa_miembros (empresa_id, usuario_id, rango) VALUES ($1, $2, $3)`,
      [inv.empresa_id, usuario.id, inv.rango],
    );
    await c.query(`UPDATE invitaciones SET aceptada_en = now() WHERE id = $1`, [inv.id]);
  } catch (e) {
    await usuario.deshacer?.().catch(() => undefined);
    throw e;
  }
  return { estado: 'ok', email: inv.email };
}

/**
 * Crea la cuenta escribiendo en `auth.users` y `auth.identities`, en la misma
 * transacción que el resto del alta.
 *
 * Es el camino sin `SUPABASE_SERVICE_KEY`. Las columnas de texto van en `''` y
 * no en NULL a propósito: GoTrue las lee como string y con NULL el login
 * falla con "Database error querying schema".
 */
export const crearUsuarioPorSql: CrearUsuario = async (c, email, clave) => {
  const r = await c.query<{ id: string }>(
    `INSERT INTO auth.users
       (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token)
     VALUES
       ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        $1, extensions.crypt($2, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
        '', '', '', '')
     RETURNING id`,
    [email, clave],
  );
  const id = r.rows[0]!.id;
  await c.query(
    `INSERT INTO auth.identities
       (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     VALUES
       (gen_random_uuid(), $1::uuid, $1::text,
        jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true),
        'email', now(), now(), now())`,
    [id, email],
  );
  return { id };
};

/**
 * Crea la cuenta con la Admin API de Supabase. Es el camino oficial, y el que
 * se usa cuando el bridge tiene `SUPABASE_SERVICE_KEY`.
 */
export function crearUsuarioPorApi(
  supabaseUrl: string,
  serviceKey: string,
  pedir: typeof fetch = fetch,
): CrearUsuario {
  const base = supabaseUrl.replace(/\/$/, '');
  const cabeceras = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  };
  return async (_c, email, clave) => {
    const r = await pedir(`${base}/auth/v1/admin/users`, {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify({ email, password: clave, email_confirm: true }),
    });
    if (!r.ok) throw new Error(`supabase admin ${r.status}`);
    const { id } = (await r.json()) as { id: string };
    return {
      id,
      deshacer: async () => {
        await pedir(`${base}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: cabeceras });
      },
    };
  };
}

export interface AltasDeps {
  apiToken: string;
  /** Sin esto (store en memoria, tests viejos) la ruta contesta 503. */
  darDeAlta?: (token: string, clave: string) => Promise<ResultadoAlta>;
}

const Cuerpo = z.object({
  token: z.string().min(1).max(128),
  clave: z.string().min(1).max(512),
});

const MENSAJES: Record<Exclude<ResultadoAlta['estado'], 'ok'>, string> = {
  desconocida: 'ese link no sirve: pedile uno nuevo a tu admin.',
  usada: 'ese link ya se usó. Si ya tenés cuenta, entrá con tu usuario.',
  vencida: 'ese link venció: pedile uno nuevo a tu admin.',
  usuario_existe: 'ya existe una cuenta con ese usuario. Pedile a tu admin un alta con otro nombre.',
  clave_invalida: `la contraseña tiene que tener entre ${CLAVE_MINIMA} y ${CLAVE_MAXIMA} caracteres.`,
};

/**
 * `POST /interno/alta`. Lo llama el panel, que es el que recibe el pedido del
 * navegador; el token interno impide que alguien de afuera le pegue directo.
 */
export function registrarAltas(app: FastifyInstance, deps: AltasDeps): void {
  app.post('/interno/alta', async (request, reply) => {
    if (!isTokenValid(request.headers.authorization, deps.apiToken)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    if (!deps.darDeAlta) {
      return reply.code(503).send({ code: 'alta_apagada', message: 'el alta no está disponible' });
    }
    const cuerpo = Cuerpo.safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos del alta' });
    }

    try {
      const r = await deps.darDeAlta(cuerpo.data.token, cuerpo.data.clave);
      if (r.estado === 'ok') return reply.code(200).send({ email: r.email });
      return reply.code(400).send({ code: `alta_${r.estado}`, message: MENSAJES[r.estado] });
    } catch (e) {
      request.log.error(e, 'no se pudo dar de alta');
      return reply.code(503).send({ code: 'alta_fallo', message: 'no pudimos crear la cuenta. Probá de nuevo.' });
    }
  });
}
