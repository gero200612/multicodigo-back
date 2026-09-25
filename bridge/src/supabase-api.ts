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
  /**
   * Guarda la conexion a la base, para que el despliegue la use.
   *
   * La contraseña sigue SIN viajar al agente: se genera aca, se guarda aca, y
   * de aca la lee `publicar()` para escribirla como variable de entorno del
   * servicio. El modelo nunca la ve, que es la regla que este archivo protege.
   *
   * Sin esto, la base quedaba creada y migrada y la connection string la tenia
   * que copiar una persona: es el pendiente "configurar en produccion" que
   * salia en TODOS los informes.
   */
  guardarConexion?: (jobId: string, conexion: string) => Promise<void>;
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

/**
 * Si el error de Supabase es el tope de proyectos del plan.
 *
 * Se mira el texto y no el status: Supabase lo manda como 403, igual que un
 * token sin permiso, y lo unico que los distingue es el mensaje ("...reached
 * their maximum limits for the number of active free projects"). El texto
 * se lee pero NO se reenvia.
 */
export function esLimiteDeProyectos(cuerpo: string): boolean {
  return /maximum limits?|project limit|limit of .*projects|active (free )?projects/i.test(cuerpo);
}

/**
 * Los permisos que Supabase dice que le faltan al token, o ninguno.
 *
 * Viene como `{"error":{"missing_permissions":["organizations_read"]}}`. Se
 * quedan solo los que parecen un nombre de permiso, para que nada mas del
 * cuerpo pueda colarse al mensaje.
 */
export function permisosQueFaltan(cuerpo: string): string[] {
  try {
    const j = JSON.parse(cuerpo) as { error?: { missing_permissions?: unknown } };
    const lista = j.error?.missing_permissions;
    if (!Array.isArray(lista)) return [];
    return lista.filter((p): p is string => typeof p === 'string' && /^[a-z_]{1,60}$/.test(p));
  } catch {
    return [];
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
    // El limite de proyectos del plan se reconoce ANTES que el 403 generico.
    // En AH (2026-09-24) la organizacion free ya tenia sus dos proyectos
    // activos, Supabase contesto 403, y el agente leyo "el token no alcanza":
    // lo repitio en el informe y la tarea quedo esperando un token nuevo que
    // no hacia falta. Lo que habia que hacer era liberar un lugar.
    if (esLimiteDeProyectos(texto)) {
      throw new ErrorDeSupabase(
        'supabase_limite_de_proyectos',
        'la organizacion de Supabase llego al limite de proyectos activos de su plan ' +
          '(el free permite 2). NO es un problema del token: una persona tiene que borrar ' +
          'o pausar un proyecto en supabase.com, o pasar a un plan pago, y despues se ' +
          'vuelve a correr esta tarea',
      );
    }
    // Un token con alcance limitado: Supabase dice QUE permiso falta. En AH
    // (2026-09-25) el token no tenia `organizations_read`, y cinco tareas
    // repitieron "el token no alcanza" sin decir para que. Solo se reenvian
    // los nombres de permiso, filtrados: el resto del cuerpo sigue sin salir.
    const faltan = permisosQueFaltan(texto);
    if (faltan.length > 0) {
      throw new ErrorDeSupabase(
        'supabase_permisos',
        `al token de Supabase le faltan permisos: ${faltan.join(', ')}. Una persona tiene ` +
          'que generar otro en supabase.com (Account > Access Tokens) con esos permisos o ' +
          'con acceso completo, cargarlo en SUPABASE_ACCESS_TOKEN y reiniciar el bridge',
      );
    }
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

/**
 * La connection string del pooler, en el formato que entiende Npgsql.
 *
 * Se le pregunta a Supabase por el host en vez de armarlo con la region: la
 * region no alcanza para saber cual de los pooler le toco al proyecto.
 */
async function conexionDePooler(
  ref: string,
  clave: string,
  deps: SupabaseApiDeps,
): Promise<string | undefined> {
  const r = (await pedir(`/v1/projects/${ref}/config/database/pooler`, { method: 'GET' }, deps)) as
    | { db_host?: string; db_port?: number; db_name?: string; db_user?: string }
    | Array<{ db_host?: string; db_port?: number; db_name?: string; db_user?: string }>;
  const c = Array.isArray(r) ? r[0] : r;
  if (!c?.db_host) return undefined;
  return [
    `Host=${c.db_host}`,
    `Port=${c.db_port ?? 5432}`,
    `Database=${c.db_name ?? 'postgres'}`,
    `Username=${c.db_user ?? `postgres.${ref}`}`,
    `Password=${clave}`,
    'SSL Mode=Require',
    'Trust Server Certificate=true',
  ].join(';');
}

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
      // La clave se genera ACA y se queda aca: no vuelve en la respuesta del
      // endpoint, no se loguea, y no la ve el agente. Lo unico que cambia
      // respecto de antes es que ahora tambien se GUARDA, para que el
      // despliegue pueda escribirla como variable de entorno del servicio.
      const clave = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');

      const r = (await pedir(
        '/v1/projects',
        {
          method: 'POST',
          body: JSON.stringify({
            name: cuerpo.data.nombre,
            organization_id: deps.orgId,
            region: REGION,
            // 32 bytes de aleatorio real. No se devuelve ni se loguea.
            db_pass: clave,
          }),
        },
        deps,
      )) as { id?: string; ref?: string };

      const ref = r.ref ?? r.id;
      if (!ref) throw new ErrorDeSupabase('supabase_sin_ref', 'Supabase no devolvio la referencia');

      // La conexion, armada y guardada, si se puede.
      //
      // Por el POOLER y no por la conexion directa: `db.<ref>.supabase.co`
      // resuelve solo a IPv6, y las plataformas donde esto se despliega
      // —Render entre ellas— salen por IPv4. Medido el 2026-09-19 con el back
      // de `Hoteleria`: "Failed to connect to [2600:1f1e:...]: Network is
      // unreachable".
      //
      // El host del pooler se PREGUNTA y no se arma con la region: hay mas de
      // uno por region (aws-0, aws-1...) y el que no es contesta "tenant not
      // found". Tambien medido esa noche, probando los dos.
      //
      // Si algo de esto falla, no pasa nada: queda el pendiente de siempre.
      if (deps.guardarConexion) {
        const conexion = await conexionDePooler(ref, clave, deps).catch(() => undefined);
        if (conexion) await deps.guardarConexion(cuerpo.data.jobId, conexion).catch(() => undefined);
      }

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
