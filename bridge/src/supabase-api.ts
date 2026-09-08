/**
 * Lo que el agente puede hacer en Supabase: crear un proyecto y migrar.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
 *
 * ## La contencion es que las rutas de borrar NO EXISTEN
 *
 * Es la misma forma que Drive y que `isBranchAllowed`, y es deliberado: no hay
 * un permiso que se pueda subir ni una bandera que alguien pueda prender por
 * error. Para que el agente pueda borrar una base habria que ESCRIBIR el
 * endpoint, y eso es una decision de este archivo y no un efecto de que el
 * modelo pida algo.
 *
 * La API de administracion de Supabase tiene `DELETE /v1/projects/{ref}`, y
 * `apply_migration` puede correr cualquier SQL — un `DROP TABLE` incluido. Lo
 * primero se resuelve no escribiendo la ruta; lo segundo NO se puede resolver
 * asi, y se dice abajo en `esSqlPeligroso`.
 *
 * ## El token vive SOLO aca
 *
 * El agente no tiene salida a internet y no la va a tener: el pasamanos va
 * agente -> gateway -> bridge, y recien este proceso habla con Supabase. Es la
 * misma razon por la que la clave de la GitHub App vive solo en el panel.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTokenValid } from '@multicodigo/shared';

export interface SupabaseApiDeps {
  /**
   * Como anotar un cable suelto en la corrida del turno, si hay una.
   *
   * Opcional: los endpoints funcionan sin esto —es lo que pasa cuando el turno
   * no es de una corrida— y perder un pendiente no puede voltear la creacion de
   * una base.
   */
  anotarPendiente?: (jobId: string, texto: string) => Promise<void>;
  /**
   * El token de administracion de Supabase, o ausente.
   *
   * Opcional: sin el, los endpoints no se registran y las herramientas del
   * agente contestan que no hay Supabase configurado. Una herramienta que
   * existe pero nunca puede funcionar es peor que una que no esta.
   */
  accessToken?: string;
  /** La organizacion de Supabase donde nacen los proyectos. */
  orgId?: string;
  /** El bearer del par gateway-bridge, el mismo que el resto de `/interno`. */
  apiToken: string;
  fetchImpl?: typeof fetch;
}

/** La region donde se crean los proyectos. */
const REGION = 'sa-east-1';

/**
 * SQL que este endpoint no corre, aunque la migracion lo pida.
 *
 * Es la parte incomoda del diseño y conviene decirla entera: `apply_migration`
 * manda SQL arbitrario, asi que "no escribir la ruta de borrar" no alcanza — un
 * `DROP TABLE clientes` es una migracion perfectamente valida para la API.
 *
 * Esta lista es una defensa PARCIAL y se sabe: un modelo que quiera evadirla lo
 * logra (comentarios, mayusculas raras, `EXECUTE` dinamico). No esta para
 * detener a un adversario —del otro lado hay un modelo trabajando, no un
 * atacante— sino para que el accidente mas probable no pase: una migracion que
 * "limpia" y se lleva la tabla de un cliente a las tres de la mañana.
 *
 * La contencion de verdad para esto es otra y todavia no esta: que el agente
 * trabaje contra un proyecto de Supabase que es SUYO y no el de produccion.
 * Mientras eso no exista, esta lista es lo que hay, y por eso el spec dice que
 * Supabase es lo ultimo que conviene soltar.
 */
const PELIGROSAS = [
  /\bdrop\s+(table|schema|database|column)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i,
  /\bdrop\s+owned\b/i,
];

export function esSqlPeligroso(sql: string): string | undefined {
  const encontrada = PELIGROSAS.find((r) => r.test(sql));
  if (!encontrada) return undefined;
  // El mensaje lo REPITE el modelo, asi que dice que hacer: sin esto reintenta
  // la misma migracion en loop.
  return (
    'esa migracion borra datos (DROP, TRUNCATE o un DELETE sin WHERE) y no la voy a correr. ' +
    'Escribi la migracion como algo que AGREGA, y si de verdad hay que borrar algo, ' +
    'decilo en tu respuesta para que lo haga una persona.'
  );
}

/** Un error de Supabase, con el codigo que el agente va a leer. */
export class ErrorDeSupabase extends Error {
  constructor(
    public readonly code: string,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorDeSupabase';
  }
}

async function pedir(
  ruta: string,
  init: RequestInit,
  deps: SupabaseApiDeps,
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.supabase.com${ruta}`, {
    ...init,
    headers: {
      authorization: `Bearer ${deps.accessToken}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    // Crear un proyecto tarda: Supabase levanta una base de verdad. El tope es
    // el mismo que el de leer un PDF grande por Drive.
    signal: AbortSignal.timeout(90_000),
  });
  const texto = await res.text();
  if (!res.ok) {
    // El cuerpo de Supabase NO se propaga tal cual: puede traer la connection
    // string del proyecto, y este texto termina en un chat de Telegram.
    throw new ErrorDeSupabase(
      `supabase_${res.status}`,
      res.status === 401 || res.status === 403
        ? 'el token de Supabase no alcanza para eso'
        : `Supabase rechazo el pedido (${res.status})`,
    );
  }
  try {
    return JSON.parse(texto);
  } catch {
    return {};
  }
}

const ConJob = { jobId: z.string().uuid() };

const CrearProyecto = z.object({
  ...ConJob,
  nombre: z.string().min(1).max(60),
});

const Migrar = z.object({
  ...ConJob,
  /** La referencia del proyecto, la que devolvio crear. */
  ref: z.string().min(1).max(60),
  nombre: z.string().min(1).max(120),
  sql: z.string().min(1).max(200 * 1024),
});

export function registrarSupabase(app: FastifyInstance, deps: SupabaseApiDeps): void {
  const autorizado = (auth: string | undefined) => isTokenValid(auth, deps.apiToken);

  /**
   * Crea un proyecto de Supabase.
   *
   * La contraseña de la base la genera ESTE proceso y no vuelve en la
   * respuesta: si viajara, quedaria en el contexto del modelo y de ahi en la
   * transcripcion del turno, que se guarda. El agente no la necesita — lo que
   * necesita es la `ref` para migrar, y las claves publicas las lee la persona
   * del panel de Supabase.
   */
  app.post('/interno/supabase/crear', async (request, reply) => {
    if (!autorizado(request.headers.authorization)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    if (!deps.accessToken || !deps.orgId) {
      return reply.code(503).send({
        code: 'sin_supabase',
        message: 'este servidor no tiene Supabase configurado, asi que no puedo crear la base',
      });
    }
    const cuerpo = CrearProyecto.safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos del pedido' });
    }

    try {
      const r = (await pedir(
        '/v1/projects',
        {
          method: 'POST',
          body: JSON.stringify({
            name: cuerpo.data.nombre,
            organization_id: deps.orgId,
            region: REGION,
            // 32 bytes de aleatorio real. No se devuelve ni se loguea.
            db_pass: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'),
          }),
        },
        deps,
      )) as { id?: string; ref?: string };

      const ref = r.ref ?? r.id;
      if (!ref) throw new ErrorDeSupabase('supabase_sin_ref', 'Supabase no devolvio la referencia');

      // El cable que queda, anotado para el informe de la mañana.
      //
      // Es el limite exacto de lo que este sistema automatiza: la base queda
      // creada y con su esquema, pero las CLAVES —la anon, la service_role, la
      // URL— las pone una persona en el env de la app. Sin decirlo, el informe
      // dice "18 tareas hechas" sobre algo que no se puede conectar a nada.
      //
      // El nombre y la ref van adentro del texto: a la mañana, con tres
      // proyectos nuevos, "poner las claves" sin decir DE CUAL no alcanza.
      await deps
        .anotarPendiente?.(
          cuerpo.data.jobId,
          `copiar las claves de la base "${cuerpo.data.nombre}" (ref ${ref}) al env de la app: ` +
            'la URL, la anon key y la service_role. Estan en supabase.com, en Project Settings > API',
        )
        .catch(() => undefined);

      return reply.code(200).send({
        output:
          `cree el proyecto de Supabase "${cuerpo.data.nombre}", ref ${ref}. ` +
          'Usala para aplicar migraciones. Las claves de API las ve la persona en supabase.com.',
      });
    } catch (e) {
      const err = e as ErrorDeSupabase;
      return reply.code(502).send({
        code: err.code ?? 'supabase_fallo',
        message: err.message ?? 'no se pudo hablar con Supabase',
      });
    }
  });

  /**
   * Aplica una migracion.
   *
   * Lo que NO existe al lado de esto es una ruta de borrar el proyecto, y esa
   * ausencia es la contencion. Ver el comentario de arriba del archivo.
   */
  app.post('/interno/supabase/migrar', async (request, reply) => {
    if (!autorizado(request.headers.authorization)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    if (!deps.accessToken) {
      return reply.code(503).send({
        code: 'sin_supabase',
        message: 'este servidor no tiene Supabase configurado',
      });
    }
    const cuerpo = Migrar.safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos de la migracion' });
    }

    // El chequeo va ANTES de salir a la red: una migracion que borra no se
    // manda y despues se lamenta.
    const peligro = esSqlPeligroso(cuerpo.data.sql);
    if (peligro) return reply.code(400).send({ code: 'sql_peligroso', message: peligro });

    try {
      await pedir(
        `/v1/projects/${encodeURIComponent(cuerpo.data.ref)}/database/migrations`,
        {
          method: 'POST',
          body: JSON.stringify({ name: cuerpo.data.nombre, query: cuerpo.data.sql }),
        },
        deps,
      );
      return reply.code(200).send({ output: `apliqué la migracion "${cuerpo.data.nombre}"` });
    } catch (e) {
      const err = e as ErrorDeSupabase;
      return reply.code(502).send({
        code: err.code ?? 'supabase_fallo',
        message: err.message ?? 'no se pudo aplicar la migracion',
      });
    }
  });
}
