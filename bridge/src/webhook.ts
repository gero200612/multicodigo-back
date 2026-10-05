import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { AgentId, ApprovalDecision, RepoDelPedido, isTokenValid } from '@multicodigo/shared';
import { decidir, type DecidirDeps } from './decisiones.js';
import { ejecutarTurnoConRelevo, type PipelineDeps } from './pipeline.js';
import { z } from 'zod';
import type { Store } from './store.js';
import { FORMATOS_GENERABLES } from './documentos.js';
import { EJES, sinRepetidas } from './corrida.js';
import { registrarDrive, type DriveApiDeps } from './drive-api.js';
import { registrarSupabase, type SupabaseApiDeps } from './supabase-api.js';
import { registrarAltas, type AltasDeps } from './altas.js';
import { registrarTrabajo, type TrabajoVisible } from './trabajo.js';
import { registrarClaudes } from './claudes.js';
import type { EstadoDeDemo, PedidoDeDemo, PedidoDeDesarrollo, ResultadoDeDemo } from './demo-homero.js';
import type { ResultadoDePublicacion } from './publicar-ticket.js';
import { PROVEEDORES, type Proveedor } from './store.js';

/** Tope duro. Sin esto, un `?limit=` de la URL deja pedir la tabla entera. */
const MAX_JOBS = 50;
const JOBS_POR_DEFECTO = 20;

/**
 * La API de lectura que consume el panel.
 *
 * Es opcional: sin esto el bridge sigue siendo solo el webhook de Telegram, que
 * es como arranco. Los tests que no la ejercitan no la pasan.
 */
export interface ApiDeps {
  store: Pick<
    Store,
    | 'recentJobs'
    | 'canjearCodigo'
    | 'usuarioDeChat'
    | 'deleteSessions'
    | 'desvincularChat'
    | 'consumoPorAgente'
    | 'contextoDeJob'
    | 'googleCuenta'
    | 'guardarGoogleCuenta'
    | 'borrarGoogleCuenta'
    | 'crearPedidoDeDrive'
    | 'canjearPedidoDeDrive'
    | 'archivoAutorizadoReciente'
    | 'corridaDeJob'
    | 'guardarConexionDeBase'
    | 'conexionDeBaseDelJob'
    | 'declararResultado'
    | 'corridasDeUsuario'
    | 'tareasDeCorrida'
    | 'marcarHuecos'
    | 'guardarVeredicto'
    | 'guardarContrato'
    | 'guardarFichas'
    | 'anotarPendiente'
    | 'guardarPreguntas'
    | 'guardarRespuestas'
    | 'encolar'
    | 'getActiveAgent'
  >;
  /**
   * Como guardar un documento que ESCRIBIO el agente.
   *
   * Se inyecta —y no se llama a `guardarDocumentoGenerado` directo— por lo
   * mismo que el resto de este archivo: asi el endpoint se testea sin un disco,
   * sin una base y sin el conversor.
   *
   * Opcional: sin esto el endpoint contesta 503 y el agente lo dice. Es mejor
   * que un 404, que le haria creer que la herramienta no existe.
   */
  /** El token de administracion de Supabase y su org. Ver `supabase-api.ts`. */
  supabase?: Omit<SupabaseApiDeps, 'apiToken'>;
  guardarGenerado?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    nombre: string;
    contenido: string;
    formato: string;
  }) => Promise<{ nombre: string; tipo: string; bytes: number }>;
  /** Análisis funcional: guarda capturas del agente (ver analisis.ts). */
  guardarCapturas?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    proyecto: string;
    capturas: { nombre: string; png: string }[];
  }) => Promise<string[]>;
  /** Análisis funcional: arma el PDF con las capturas guardadas. */
  guardarAnalisis?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    proyecto: string;
    titulo: string;
    resumen: string;
    secciones: { titulo: string; texto: string; capturas?: string[] }[];
    jobId?: string;
  }) => Promise<{ nombre: string; bytes: number; faltantes: string[] }>;
  nombreDeProyecto?: (proyectoId: string) => Promise<string | undefined>;
  /**
   * Como decidir una aprobacion desde afuera de Telegram.
   *
   * Es el MISMO camino que usan los botones del chat: el panel no escribe la
   * tabla por su cuenta, porque decidir tambien significa avisarle al gateway y
   * editar el mensaje del chat.
   */
  decisiones?: DecidirDeps;
  /** El alta de una persona en una empresa. Ver `altas.ts`. */
  altas?: AltasDeps['darDeAlta'];
  /** El trabajo en curso de la empresa de una persona. Ver `trabajo.ts`. */
  trabajo?: (usuarioId: string) => Promise<TrabajoVisible[]>;
  /** Anota un slot recien creado a nombre de quien lo pidio. Ver `claudes.ts`. */
  registrarClaude?: (usuarioId: string, proyectoId: string, slot: string) => Promise<boolean>;
  /**
   * Con que ejecutar un turno pedido desde el panel.
   *
   * Es el MISMO camino que el de Telegram: mismo job, mismo poller de
   * aprobaciones, misma sesion. Es lo que hace que los dos frentes compartan
   * hilo en vez de tener cada uno el suyo.
   */
  pipeline?: PipelineDeps;
  /**
   * Con que hablarle a Drive.
   *
   * Opcional: sin `GOOGLE_CLIENT_SECRET` no hay refresh token que canjear, asi
   * que las herramientas de Drive no se registran y el agente recibe el error
   * de "esa herramienta no esta habilitada" — que es la verdad. Registrarlas
   * igual y fallar adentro le haria creer al modelo que la cuenta esta mal
   * conectada cuando lo que falta es una variable del servidor.
   */
  drive?: Omit<DriveApiDeps, 'store' | 'apiToken'>;
  /**
   * Credencial propia, distinta del secret del webhook.
   *
   * Son dos cosas con dueños distintos: el secret lo tiene Telegram, este token
   * lo tiene el panel. Compartirlos significaria que quien puede leer tus
   * conversaciones puede tambien inyectar updates de Telegram.
   */
  apiToken: string;
  /**
   * Las demos que pide Homero. Se inyectan porque abrir una necesita el bot
   * (para avisar en el chat) y el pipeline entero. Sin esto las rutas dan 503.
   */
  /**
   * Despliegue a la app de cada persona (Render, Vercel, Netlify, Railway).
   * El panel ya validó el JWT; el bridge vuelve a mirar que el proyecto sea de
   * esa persona. Sin esto las rutas dan 503. Ver `publicar-ticket.ts`.
   */
  despliegue?: {
    conexiones: (usuarioId: string) => Promise<{ proveedor: string; cuenta: string | null; creadoEn: string }[]>;
    conectar: (
      usuarioId: string,
      proveedor: Proveedor,
      token: string,
      extra: Record<string, string>,
    ) => Promise<{ ok: true; cuenta: string } | { ok: false; motivo: string }>;
    desconectar: (usuarioId: string, proveedor: Proveedor) => Promise<void>;
    cuentaDemo?: (usuarioId: string, proyectoId: string) => Promise<{ cuenta: { ruta: string; usuario: string } | null } | undefined>;
    guardarCuentaDemo?: (
      usuarioId: string,
      proyectoId: string,
      c: { ruta: string; usuario: string; password: string },
    ) => Promise<boolean>;
    borrarCuentaDemo?: (usuarioId: string, proyectoId: string) => Promise<boolean>;
    loginDeDemo?: (proyecto: string) => Promise<{ ruta: string; email: string; password: string } | undefined>;
    elegirDestino: (
      usuarioId: string,
      proyectoId: string,
      repo: string,
      destino: Proveedor | null,
    ) => Promise<{ ok: true } | { ok: false; motivo: string }>;
    publicar: (
      usuarioId: string,
      proyectoId: string,
      agente: string,
      explicito: boolean,
    ) => Promise<{ ok: true; resultado: ResultadoDePublicacion; texto: string } | { ok: false; motivo: string }>;
  };
  demos?: {
    abrir: (p: PedidoDeDemo) => Promise<ResultadoDeDemo>;
    estado: (chatId: number, corridaId: string) => Promise<EstadoDeDemo | undefined>;
    /** Desarrollo desde el panel: ver `abrirDesarrollo`. */
    desarrollo?: (p: PedidoDeDesarrollo) => Promise<ResultadoDeDemo>;
  };
}

// El panel (C#) manda los campos vacios como `null`, no los omite: `.optional()`
// solo acepta que falten, y un ticket con `proyectoId` y `"proyecto": null`
// rebotaba como cuerpo_invalido. `null` vale lo mismo que no venir.
const opcional = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => v ?? undefined);
const CuerpoDesarrollo = z.object({
  usuarioId: z.string().uuid(),
  proyecto: opcional(z.string().regex(/^[a-zA-Z0-9._-]+$/).max(60)),
  proyectoId: opcional(z.string().uuid()),
  pliego: z.string().min(20).max(60_000),
  repos: opcional(z.array(z.string().max(100)).max(10)),
  referencia: opcional(z.array(z.string().max(100)).max(10)),
  org: opcional(z.string().max(100)),
  publico: opcional(z.boolean()),
});

const ProveedorZ = z.enum(PROVEEDORES);
const CuerpoCuentaDemo = z.object({
  usuarioId: z.string().uuid(),
  proyectoId: z.string().uuid(),
  ruta: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,99}$/).default('/login'),
  usuario: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});
const CuerpoConectar = z.object({
  usuarioId: z.string().uuid(),
  proveedor: ProveedorZ,
  token: z.string().min(8).max(500),
  extra: z.record(z.string().max(100)).optional(),
});
const CuerpoDesconectar = z.object({ usuarioId: z.string().uuid(), proveedor: ProveedorZ });
const CuerpoDestino = z.object({
  usuarioId: z.string().uuid(),
  proyectoId: z.string().uuid(),
  repo: z.string().min(1).max(100),
  destino: ProveedorZ.nullable(),
});
const CuerpoPublicar = z.object({
  usuarioId: z.string().uuid(),
  proyectoId: z.string().uuid(),
  agente: AgentId,
});

const CuerpoDemo = z.object({
  chatId: z.coerce.number().int(),
  // La misma forma que valida `/corrida proyecto=`.
  proyecto: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(60),
  pliego: z.string().min(20).max(60_000),
});

/** Cuantas corridas muestra el dashboard: la abierta y las ultimas. */
const CORRIDAS_A_MOSTRAR = 5;
/** Cuanto de cada tarea viaja al panel. */
const TOPE_TEXTO_TAREA = 400;
/**
 * Cuanto del resultado de una tarea FALLIDA viaja al panel.
 *
 * Solo el de las fallidas: el de una tarea que salio bien es la respuesta
 * entera del agente —parrafos— y multiplicado por sesenta tareas convierte el
 * panorama en un megabyte. El de una fallida es un codigo de error o un mensaje
 * corto, y es lo unico con lo que se puede ir a mirar que paso.
 */
const TOPE_RESULTADO = 300;

export function buildWebhookServer(
  bot: Pick<Bot, 'handleUpdate'>,
  webhookSecret: string,
  api?: ApiDeps,
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/telegram/webhook', async (request, reply) => {
    if (request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // Fire and forget: Telegram reintenta si no contestamos rapido, y el turno
    // de Claude tarda minutos. El error se loguea, no se propaga al request.
    //
    // Con `console.error` y NO con `app.log.error`: el servidor se crea con
    // `logger: false`, asi que `app.log.error` no escribe en ningun lado. O sea
    // que TODO fallo de un update se perdia — y con el, la unica pista de que
    // algo habia pasado.
    //
    // Costo real: el 2026-09-10 el mensaje del plan de `despacho2` se paso de
    // los 4096 caracteres de Telegram, se rechazo entero, y la corrida quedo
    // esperando un boton que no existia. Los logs estaban vacios y el
    // contenedor decia "Up 26 minutes", asi que no habia por donde empezar a
    // buscar.
    void bot.handleUpdate(request.body as never).catch((err: unknown) => {
      console.error('[bridge] fallo el procesamiento del update:', err);
    });
    return reply.code(200).send({ ok: true });
  });

  if (api) {
    /**
     * Cuanto gasto cada agente en las ultimas 5 horas.
     *
     * No dice cuanto QUEDA: Anthropic no publica la cuota, asi que no hay
     * total contra el cual dividir y un porcentaje seria inventado. Lo que se
     * puede medir es lo gastado, sobre la misma ventana que usa su limite.
     */
    app.get('/consumo', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const consumo = await api.store.consumoPorAgente();
      return reply.code(200).send({ consumo: Object.fromEntries(consumo) });
    });

    app.get<{ Querystring: { limit?: string } }>('/jobs', async (request, reply) => {
      // Este endpoint expone los prompts, o sea todo lo que le hablaste a tus
      // agentes. Sin bearer seria una filtracion de la conversacion entera.
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      // Un limite invalido cae al default en vez de romper: es un parametro de
      // una pagina que se refresca sola, no vale tirarle un 400 al usuario.
      const pedido = Number(request.query.limit);
      const limite = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, MAX_JOBS) : JOBS_POR_DEFECTO;

      return reply.code(200).send({ jobs: await api.store.recentJobs(limite) });
    });

    /**
     * Las corridas de una persona, con sus tareas: la cola del pliego.
     *
     * El dashboard mostraba solo la cola del GATEWAY —que build corre— y las
     * tareas de una corrida no se veian en ningun lado fuera de Telegram. El
     * `usuarioId` lo pone el panel desde el JWT, igual que en `/vinculos`.
     */
    app.get<{ Querystring: { usuarioId?: string } }>('/corridas', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const usuario = z.string().uuid().safeParse(request.query.usuarioId);
      if (!usuario.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId' });
      }
      const corridas = await api.store.corridasDeUsuario(usuario.data, CORRIDAS_A_MOSTRAR);
      const salida = await Promise.all(
        corridas.map(async (c) => ({
          id: c.id,
          proyecto: c.proyecto,
          estado: c.estado,
          motivoDeCierre: c.motivoDeCierre ?? null,
          ronda: c.ronda,
          techoRondas: c.techoRondas,
          techoHora: c.techoHora,
          creadoEn: c.creadoEn.toISOString(),
          tareas: (await api.store.tareasDeCorrida(c.id)).map((t) => ({
            posicion: t.posicion,
            agente: t.agente,
            // Las redacta el planificador para otro agente y salen largas. El
            // panel las muestra recortadas; el detalle esta en el repo.
            texto: t.texto.length > TOPE_TEXTO_TAREA ? `${t.texto.slice(0, TOPE_TEXTO_TAREA)}…` : t.texto,
            estado: t.estado,
            ronda: t.ronda ?? null,
            // El motivo, para el log de la corrida. Sin esto el panel muestra
            // "falló" y hay que ir a la base para saber si fue tiempo, tokens o
            // la sesion vencida — que son tres arreglos distintos.
            resultado:
              t.estado === 'fallida' && t.resultado
                ? t.resultado.slice(0, TOPE_RESULTADO)
                : null,
          })),
        })),
      );
      return reply.code(200).send({ corridas: salida });
    });

    const CuerpoVinculo = z.object({
      codigo: z.string().min(1).max(32),
      usuarioId: z.string().uuid(),
    });

    const CuerpoDesvinculo = z.object({
      // `chat_id` es un BIGINT y los ids de Telegram entran de sobra en un
      // double, asi que number alcanza. `int()` corta un float mandado a mano.
      chatId: z.coerce.number().int(),
      usuarioId: z.string().uuid(),
    });

    /**
     * Canjea un codigo de vinculacion a nombre de un usuario del panel.
     *
     * Lo llama el panel, no el navegador: el `usuarioId` viene del JWT que el
     * panel ya verifico. Si esto lo pudiera llamar el navegador, cualquiera
     * vincularia un chat a la cuenta de otro.
     */
    app.post('/vinculos', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      const cuerpo = CuerpoVinculo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta codigo o usuarioId' });
      }

      const r = await api.store.canjearCodigo(cuerpo.data.codigo, cuerpo.data.usuarioId);
      if (r === 'ok') return reply.code(200).send({ estado: 'ok' });

      // Los tres se explican distinto en el panel: "pedi uno nuevo" no es lo
      // mismo que "ese ya lo usaste".
      const codigos = {
        vencido: 'codigo_vencido',
        usado: 'codigo_usado',
        desconocido: 'codigo_desconocido',
      } as const;
      return reply.code(400).send({ code: codigos[r], message: 'el codigo no sirve' });
    });

    /**
     * Desata un chat de una cuenta.
     *
     * POST y no DELETE porque el cuerpo lleva el `usuarioId`, y un DELETE con
     * cuerpo es algo que algunos proxies descartan. Quien decide la forma REST
     * es el panel, que expone esto como DELETE hacia el front.
     *
     * El `usuarioId` es obligatorio y viaja al WHERE del borrado: sin eso,
     * cualquiera que llegue a este endpoint podria desatar el chat de otro.
     * Aca no hay JWT que verificar —esta detras del bearer del panel— asi que
     * la unica defensa es que el panel mande el usuario del JWT y este borrado
     * lo exija.
     */
    app.post('/vinculos/borrar', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      const cuerpo = CuerpoDesvinculo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'falta chatId o usuarioId' });
      }

      const fue = await api.store.desvincularChat(cuerpo.data.chatId, cuerpo.data.usuarioId);
      return reply.code(200).send({ desvinculado: fue });
    });

    if (api.decisiones) {
      const decisiones = api.decisiones;

      const CuerpoDecision = z.object({
        // Del contrato compartido: el conjunto de decisiones no lo define este
        // archivo.
        decision: ApprovalDecision,
        usuarioId: z.string().uuid(),
      });

      app.post<{ Params: { id: string } }>('/aprobaciones/:id/decision', async (request, reply) => {
        if (!isTokenValid(request.headers.authorization, api.apiToken)) {
          return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        }

        const cuerpo = CuerpoDecision.safeParse(request.body);
        if (!cuerpo.success) {
          return reply
            .code(400)
            .send({ code: 'cuerpo_invalido', message: 'decision o usuario invalidos' });
        }

        const r = await decidir(decisiones, {
          approvalId: request.params.id,
          decision: cuerpo.data.decision,
          usuarioId: cuerpo.data.usuarioId,
          desde: 'panel',
        });

        if (r === 'ok') return reply.send({ estado: 'ok' });
        if (r === 'ya_decidida') {
          // 409 y no 400: el pedido estaba bien, el estado del mundo cambio.
          return reply
            .code(409)
            .send({ code: 'ya_decidida', message: 'esa aprobacion ya se decidio' });
        }
        return reply.code(404).send({ code: 'desconocida', message: 'no existe esa aprobacion' });
      });
    }

    if (api.pipeline) {
      const pipeline = api.pipeline;

      const CuerpoTurno = z.object({
        proyectoId: z.string().uuid(),
        proyecto: z.string().regex(/^[a-zA-Z0-9._-]+$/),
        // Del contrato compartido: la forma del slot no la define este archivo.
        agente: AgentId,
        usuarioId: z.string().uuid(),
        prompt: z.string().min(1).max(20_000),
        // Del contrato compartido, igual que AgentId: el `nombre` termina siendo
        // un directorio en el disco de la VM y el `github_repo`, parte de una
        // URL de git. El gateway lo valida igual —es el que toca el disco— pero
        // el bridge no tiene por que reenviarle algo que ya sabe que esta mal.
        repos: z.array(RepoDelPedido).max(20).optional(),
        // El token de instalacion que firmo el panel. Se valida la forma —entra
        // en un header del lado del gateway— pero no se mira el contenido: el
        // bridge es un caño para esto.
        githubToken: z.string().regex(/^[A-Za-z0-9._~+/=-]+$/).max(512).optional(),
        // Los documentos del proyecto, con URLs firmadas. El bridge no los mira:
        // los reenvia al gateway, que los baja al worktree.
        //
        // La `url` se valida como URL a secas y no contra un host: es una URL
        // La RUTA en el disco del servidor, no una URL: el panel deja el
        // archivo en un directorio que el gateway tambien monta. El bridge solo
        // la reenvia; quien la lee es el gateway, que sabe cual es la raiz.
        documentos: z
          .array(
            z.object({
              nombre: z.string().regex(/^[A-Za-z0-9._-]+$/).max(200),
              ruta: z.string().min(1).max(500),
              ruta_texto: z.string().min(1).max(500).nullable().optional(),
              // La marca de instructivo. Opcional: un panel sin actualizar no
              // la manda, y ahi el proyecto simplemente no tiene instructivo.
              // El bridge la usa para separarlo (ver `separarInstructivo`); el
              // gateway recibe el instructivo en su propio campo.
              es_instruccion: z.boolean().optional(),
            }),
          )
          .max(50)
          .optional(),
        // Cuánto pregunta el agente en ESTE turno, de la configuración de
        // Punchi. `desatendido` entra: es lo que deja terminar un ticket solo,
        // vale para este turno y nada más, y lo seguro no cambia —el gateway
        // solo pushea a `claude/<agente>/…`—. Ausente = el default del agente.
        modo: z.enum(['preguntar', 'ediciones', 'todo', 'desatendido']).nullish(),
        // La persona apagó "preguntar antes de desplegar": al terminar bien, se
        // publica solo (solo los repos que creó el bot, ver publicar-ticket.ts).
        publicar: z.boolean().nullish(),
      });

      /**
       * Un turno pedido desde el panel.
       *
       * La membresia YA la valido el panel: este endpoint esta detras del
       * bearer y no lo alcanza el navegador. Chequearla tambien aca obligaria
       * al bridge a conocer proyectos y usuarios, que es justo lo que el spec
       * decidio evitar.
       */
      app.post('/turnos', async (request, reply) => {
        if (!isTokenValid(request.headers.authorization, api.apiToken)) {
          return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        }

        const cuerpo = CuerpoTurno.safeParse(request.body);
        if (!cuerpo.success) {
          return reply
            .code(400)
            .send({ code: 'cuerpo_invalido', message: 'faltan datos del turno' });
        }

        try {
          const { modo, publicar, ...resto } = cuerpo.data;
          const r = await ejecutarTurnoConRelevo(pipeline, {
            ...resto,
            ...(modo ? { modo } : {}),
            origen: 'panel',
          });
          // Sin await: publicar tarda (merge + deploy) y el turno ya terminó.
          // El resultado le llega por Telegram, ver `despliegue.publicar`.
          if (publicar && api.despliegue) {
            void api.despliegue
              .publicar(resto.usuarioId, resto.proyectoId, r.agente, false)
              .catch((err: unknown) => console.error('[bridge] no se pudo publicar solo:', err));
          }
          return reply.send({ jobId: r.jobId, texto: r.texto });
        } catch (e) {
          // 502 y no 500: lo que fallo es el agente del otro lado, y el `code`
          // es el suyo. El panel lo traduce a algo que se pueda leer.
          const code = e instanceof Error ? e.message : 'internal';
          return reply.code(502).send({ code, message: 'el turno fallo' });
        }
      });
    }

    /**
     * Un documento que escribio el agente.
     *
     * Vive en el bridge y no en el panel por una razon dura: el panel escribe
     * SIEMPRE con el JWT del usuario, para que RLS sea la unica autoridad, y
     * aca no hay ningun usuario conectado. Fabricarle un JWT tampoco se puede
     * —se verifican contra el JWKS— y darle al panel la service_role es
     * justo lo que el diseño le niega. El bridge ya escribe la tabla sin RLS.
     *
     * El proyecto y el usuario NO llegan en el cuerpo: se resuelven del
     * `jobId`. Es lo que impide que quien llame elija en que proyecto escribir,
     * y de paso ahorra hacerle llevar la identidad del usuario a un agente que
     * no la necesita para nada mas.
     *
     * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md`.
     */
    // El formato se valida con un enum y no con un string: es lo que arma la
    // extension del archivo en disco, y la lista tiene que coincidir con
    // `FORMATOS_GENERABLES`.
    const CuerpoDocumentoGenerado = z.object({
      jobId: z.string().uuid(),
      nombre: z.string().min(1),
      contenido: z.string().min(1),
      formato: z.enum(FORMATOS_GENERABLES),
    });

    // --- análisis funcional ---------------------------------------------
    const CuerpoCapturas = z.object({
      jobId: z.string().uuid(),
      capturas: z
        .array(z.object({ nombre: z.string().min(1).max(80), png: z.string().min(1).max(12_000_000) }))
        .min(1)
        .max(12),
    });
    const CuerpoAnalisis = z.object({
      jobId: z.string().uuid(),
      titulo: z.string().min(1).max(200),
      resumen: z.string().min(1).max(8000),
      secciones: z
        .array(
          z.object({
            titulo: z.string().min(1).max(200),
            texto: z.string().min(1).max(8000),
            capturas: z.array(z.string().max(160)).max(6).optional(),
          }),
        )
        .min(1)
        .max(20),
    });

    /** El proyecto y el usuario del turno, y el nombre del proyecto para la carpeta. */
    const apiDelAnalisis = api;
    async function contextoDelAnalisis(jobId: string) {
      const contexto = await apiDelAnalisis.store.contextoDeJob(jobId);
      if (!contexto?.proyectoId || !contexto.usuarioId) return undefined;
      const proyecto = (await apiDelAnalisis.nombreDeProyecto?.(contexto.proyectoId)) ?? 'proyecto';
      return { proyectoId: contexto.proyectoId, usuarioId: contexto.usuarioId, proyecto };
    }

    app.post('/interno/documentos/capturas', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.guardarCapturas) return reply.code(503).send({ code: 'sin_documentos', message: 'este bridge no guarda capturas' });
      const cuerpo = CuerpoCapturas.safeParse(request.body);
      if (!cuerpo.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan las capturas' });
      const ctx = await contextoDelAnalisis(cuerpo.data.jobId);
      if (!ctx) return reply.code(400).send({ code: 'sin_contexto', message: 'ese turno no tiene proyecto y usuario' });
      const nombres = await api.guardarCapturas({ ...ctx, capturas: cuerpo.data.capturas });
      return reply.code(200).send({ nombres, output: nombres.length ? `guardé: ${nombres.join(', ')}` : 'no había PNG válidos' });
    });

    app.post('/interno/documentos/analisis', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.guardarAnalisis) return reply.code(503).send({ code: 'sin_documentos', message: 'este bridge no arma análisis' });
      const cuerpo = CuerpoAnalisis.safeParse(request.body);
      if (!cuerpo.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el título, el resumen o las secciones' });
      const ctx = await contextoDelAnalisis(cuerpo.data.jobId);
      if (!ctx) return reply.code(400).send({ code: 'sin_contexto', message: 'ese turno no tiene proyecto y usuario' });
      try {
        const r = await api.guardarAnalisis({ ...ctx, ...cuerpo.data });
        const aviso = r.faltantes.length ? ` (no encontré estas capturas: ${r.faltantes.join(', ')})` : '';
        return reply.code(200).send({ output: `guardé el análisis funcional ${r.nombre} en "Análisis funcional (${ctx.proyecto})"${aviso}` });
      } catch (e) {
        return reply.code(422).send({ code: 'analisis_fallo', message: e instanceof Error ? e.message : 'no se pudo armar el PDF' });
      }
    });

    app.post('/interno/documentos/generado', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.guardarGenerado) {
        return reply
          .code(503)
          .send({ code: 'sin_documentos', message: 'este bridge no puede guardar documentos' });
      }

      const cuerpo = CuerpoDocumentoGenerado.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'faltan datos del documento' });
      }

      const contexto = await api.store.contextoDeJob(cuerpo.data.jobId);
      // Sin proyecto o sin usuario no hay fila posible: las dos columnas son
      // obligatorias. Se dice aca en vez de fallar en el INSERT tres capas
      // abajo con un error de Postgres que nadie puede leer.
      if (!contexto?.proyectoId || !contexto.usuarioId) {
        return reply.code(400).send({
          code: 'sin_contexto',
          message: 'ese turno no tiene proyecto y usuario, asi que no se puede guardar el documento',
        });
      }

      try {
        const doc = await api.guardarGenerado({
          proyectoId: contexto.proyectoId,
          usuarioId: contexto.usuarioId,
          nombre: cuerpo.data.nombre,
          contenido: cuerpo.data.contenido,
          formato: cuerpo.data.formato,
        });
        // `output` con el nombre adentro: esto vuelve al MODELO, que con eso le
        // dice a la persona como quedo el archivo.
        return reply.code(200).send({ output: `guarde ${doc.nombre} (${doc.bytes} bytes)` });
      } catch (e) {
        // 422 y no 500: el mensaje del conversor esta escrito para una persona
        // ("este servidor no puede generar un .pdf") y termina en su pantalla.
        const message = e instanceof Error ? e.message : 'no se pudo guardar el documento';
        return reply.code(422).send({ code: 'no_se_pudo_guardar', message });
      }
    });

    /**
     * Los huecos que encontro el analista de una corrida.
     *
     * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
     *
     * Entra por una HERRAMIENTA y no parseando la respuesta del turno, y esa es
     * la decision central del ciclo: un analista que escribe "parece que falta
     * el modulo de stock" en prosa se traduciria en cero tareas encoladas y una
     * corrida que cierra diciendo que esta completa. Con una tool, o llamo o no
     * llamo, y eso es verificable — es justo lo que mira `rondaDeAnalisis`.
     *
     * La corrida se resuelve del jobId y NO llega en el cuerpo: el id de la
     * corrida seria un dato que el modelo puede cambiar, y con el podria
     * encolarle trabajo a la corrida de otro chat. El jobId ya lo pone el
     * gateway.
     */
    const CuerpoHuecos = z.object({
      jobId: z.string().uuid(),
      /**
       * La ronda que el analista cree que esta corriendo.
       *
       * Se compara contra la de la base en vez de confiar en ella: un turno que
       * quedo colgado y contesta tarde reportaria contra una ronda que ya paso,
       * y esas tareas entrarian a una ronda a la que no pertenecen.
       */
      ronda: z.number().int().min(1).max(100),
      // Vacia es un valor VALIDO y significativo: es como el analista dice "no
      // falta nada", y es el unico camino a que la corrida cierre como
      // completa. Un `.min(1)` aca haria que la unica forma de terminar bien
      // fuera no llamar la herramienta, o sea lo mismo que fallar.
      huecos: z.array(z.string().min(1).max(2000)).max(50),
    });

    // --- despliegue ------------------------------------------------------
    const conBearer = (request: { headers: { authorization?: string } }) =>
      isTokenValid(request.headers.authorization, api.apiToken);

    app.get<{ Querystring: { usuarioId?: string } }>('/interno/despliegue/conexiones', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue) return reply.code(503).send({ code: 'sin_despliegue', message: 'despliegue no configurado' });
      const u = z.string().uuid().safeParse(request.query.usuarioId);
      if (!u.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId' });
      return reply.send({ conexiones: await api.despliegue.conexiones(u.data) });
    });

    app.put('/interno/despliegue/conexiones', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue) return reply.code(503).send({ code: 'sin_despliegue', message: 'despliegue no configurado' });
      const c = CuerpoConectar.safeParse(request.body);
      if (!c.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el proveedor o el token' });
      const r = await api.despliegue.conectar(c.data.usuarioId, c.data.proveedor, c.data.token.trim(), c.data.extra ?? {});
      return r.ok ? reply.send({ cuenta: r.cuenta }) : reply.code(422).send({ code: 'token_invalido', message: r.motivo });
    });

    // --- cuenta de demo (043): con la que `mirar` entra a la app ---------------

    app.get<{ Querystring: { usuarioId?: string; proyectoId?: string } }>(
      '/interno/despliegue/cuenta-demo',
      async (request, reply) => {
        if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        if (!api.despliegue?.cuentaDemo) return reply.code(503).send({ code: 'sin_despliegue', message: 'no configurado' });
        const u = z.string().uuid().safeParse(request.query.usuarioId);
        const p = z.string().uuid().safeParse(request.query.proyectoId);
        if (!u.success || !p.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId o proyectoId' });
        const r = await api.despliegue.cuentaDemo(u.data, p.data);
        return r ? reply.send(r) : reply.code(403).send({ code: 'sin_permiso', message: 'no podés escribir en ese proyecto' });
      },
    );

    app.put('/interno/despliegue/cuenta-demo', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue?.guardarCuentaDemo) return reply.code(503).send({ code: 'sin_despliegue', message: 'no configurado' });
      const c = CuerpoCuentaDemo.safeParse(request.body);
      if (!c.success) {
        return reply.code(400).send({
          code: 'cuerpo_invalido',
          message: 'falta el usuario o la contraseña, o la ruta del login no empieza con /',
        });
      }
      const { usuarioId, proyectoId, ...cuenta } = c.data;
      return (await api.despliegue.guardarCuentaDemo(usuarioId, proyectoId, cuenta))
        ? reply.send({ ok: true })
        : reply.code(403).send({ code: 'sin_permiso', message: 'no podés escribir en ese proyecto' });
    });

    app.post('/interno/despliegue/cuenta-demo/borrar', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue?.borrarCuentaDemo) return reply.code(503).send({ code: 'sin_despliegue', message: 'no configurado' });
      const c = z.object({ usuarioId: z.string().uuid(), proyectoId: z.string().uuid() }).safeParse(request.body);
      if (!c.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId o proyectoId' });
      return (await api.despliegue.borrarCuentaDemo(c.data.usuarioId, c.data.proyectoId))
        ? reply.send({ ok: true })
        : reply.code(403).send({ code: 'sin_permiso', message: 'no podés escribir en ese proyecto' });
    });

    // Del gateway, para `mirar`: la contraseña en claro, por eso solo con el
    // token interno y nunca hacia el panel.
    app.get<{ Querystring: { proyecto?: string } }>('/interno/mirar/login', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      const p = z.string().min(1).max(100).safeParse(request.query.proyecto);
      if (!p.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el proyecto' });
      const login = await api.despliegue?.loginDeDemo?.(p.data);
      return reply.send({ login: login ?? null });
    });

    app.post('/interno/despliegue/desconectar', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue) return reply.code(503).send({ code: 'sin_despliegue', message: 'despliegue no configurado' });
      const c = CuerpoDesconectar.safeParse(request.body);
      if (!c.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el proveedor' });
      await api.despliegue.desconectar(c.data.usuarioId, c.data.proveedor);
      return reply.send({ ok: true });
    });

    app.put('/interno/despliegue/destino', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue) return reply.code(503).send({ code: 'sin_despliegue', message: 'despliegue no configurado' });
      const c = CuerpoDestino.safeParse(request.body);
      if (!c.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el repo o la app' });
      const r = await api.despliegue.elegirDestino(c.data.usuarioId, c.data.proyectoId, c.data.repo, c.data.destino);
      return r.ok ? reply.send({ ok: true }) : reply.code(404).send({ code: 'no_existe', message: r.motivo });
    });

    app.post('/interno/despliegue/publicar', async (request, reply) => {
      if (!conBearer(request)) return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      if (!api.despliegue) return reply.code(503).send({ code: 'sin_despliegue', message: 'despliegue no configurado' });
      const c = CuerpoPublicar.safeParse(request.body);
      if (!c.success) return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el proyecto o el agente' });
      const r = await api.despliegue.publicar(c.data.usuarioId, c.data.proyectoId, c.data.agente, true);
      return r.ok
        ? reply.send({ ...r.resultado, texto: r.texto })
        : reply.code(409).send({ code: 'no_publicado', message: r.motivo });
    });

    /**
     * Homero pide una demo: abre la corrida y la arranca sin el boton de
     * confirmar. Ver `demo-homero.ts`.
     */
    app.post('/interno/corrida/desde-homero', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.demos) return reply.code(503).send({ code: 'sin_demos', message: 'demos no configuradas' });
      const cuerpo = CuerpoDemo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta chatId, proyecto o pliego' });
      }
      const r = await api.demos.abrir(cuerpo.data);
      return r.ok
        ? reply.code(200).send({ corridaId: r.corridaId })
        : reply.code(409).send({ code: 'no_abierta', message: r.motivo });
    });

    /**
     * Desarrollo desde el panel: el panel ya validó al usuario (el JWT), y
     * `/corrida proyecto=` solo encuentra o crea proyectos de ESA persona.
     */
    app.post('/interno/corrida/desde-panel', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.demos?.desarrollo) return reply.code(503).send({ code: 'sin_corridas', message: 'corridas no configuradas' });
      const cuerpo = CuerpoDesarrollo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el proyecto o el pliego' });
      }
      const r = await api.demos.desarrollo(cuerpo.data);
      return r.ok
        ? reply.code(200).send({ corridaId: r.corridaId })
        : reply.code(409).send({ code: 'no_abierta', message: r.motivo });
    });

    app.get<{ Params: { id: string }; Querystring: { chatId?: string } }>(
      '/interno/corrida/:id/estado',
      async (request, reply) => {
        if (!isTokenValid(request.headers.authorization, api.apiToken)) {
          return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        }
        if (!api.demos) return reply.code(503).send({ code: 'sin_demos', message: 'demos no configuradas' });
        const chatId = Number(request.query.chatId);
        if (!Number.isInteger(chatId) || !z.string().uuid().safeParse(request.params.id).success) {
          return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta chatId o id' });
        }
        const e = await api.demos.estado(chatId, request.params.id);
        return e ? reply.code(200).send(e) : reply.code(404).send({ code: 'no_existe', message: 'no esta esa corrida' });
      },
    );

    app.post('/interno/corrida/huecos', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoHuecos.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'faltan datos del reporte' });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        // El mensaje lo REPITE el modelo, asi que dice que hacer y no solo que
        // fallo: sin esto el analista reintenta la herramienta en loop.
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no pertenece a ninguna corrida abierta, asi que no hay donde anotar los ' +
            'huecos. No reintentes: contale a la persona lo que encontraste en tu respuesta.',
        });
      }
      if (cuerpo.data.ronda !== corrida.ronda) {
        return reply.code(409).send({
          code: 'otra_ronda',
          message:
            `la corrida ya esta en la ronda ${corrida.ronda} y estas reportando la ` +
            `${cuerpo.data.ronda}. No reintentes: lo que encontraste ya no corresponde a esta ronda.`,
        });
      }

      // Se marca SIEMPRE, incluso con la lista vacia. La marca no dice "hay
      // huecos": dice "el analista llamo la herramienta", que es lo que separa
      // "reviso y no falta nada" de "contesto en prosa y nadie recibio nada".
      await api.store.marcarHuecos(corrida.id, corrida.ronda);

      if (cuerpo.data.huecos.length === 0) {
        return reply.code(200).send({ output: 'anotado: no quedan huecos. Cierro la corrida.' });
      }

      // Lo que otro analista (o el plan) ya dejo encolado no se vuelve a anotar:
      // en AH los cuatro ejes de la ronda 1 encolaron la misma pantalla tres veces.
      const yaEncoladas = (await api.store.tareasDeCorrida(corrida.id).catch(() => []))
        .filter((t) => t.estado === 'pendiente' || t.estado === 'corriendo')
        .map((t) => t.texto);
      const textos = sinRepetidas(cuerpo.data.huecos, yaEncoladas);
      if (textos.length === 0) {
        return reply.code(200).send({
          output: 'anotado: todo lo que reportaste ya estaba en la cola. No repitas tareas.',
        });
      }
      const agente = (await api.store.getActiveAgent(corrida.chatId)) ?? 'c1';
      const n = await api.store.encolar(corrida.chatId, {
        agente,
        proyecto: corrida.proyecto,
        textos,
        corridaId: corrida.id,
        ronda: corrida.ronda,
      });
      return reply.code(200).send({ output: `anote ${n} tarea(s) para la ronda que sigue` });
    });

    /**
     * Lo que el planificador quiere preguntar antes de armar la cola.
     *
     * Un pliego ambiguo produce un plan sobre supuestos que nadie confirmo:
     * el modelo elige una interpretacion, arma doce tareas, y a la mañana el
     * trabajo esta hecho contra algo que no era. Preguntar cuesta un mensaje.
     *
     * El tope de 3 no es estetico: cada pregunta es un momento en que la corrida
     * espera a alguien que puede estar durmiendo, y una lista de ocho preguntas
     * en un chat de telefono no se contesta, se abandona.
     */
    const CuerpoPreguntas = z.object({
      jobId: z.string().uuid(),
      preguntas: z.array(z.string().min(1).max(300)).min(1).max(3),
    });

    app.post('/interno/corrida/preguntas', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoPreguntas.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'entre 1 y 3 preguntas, cortas' });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no es de una corrida, asi que no hay a quien preguntarle. ' +
            'No reintentes: decidi vos y segui.',
        });
      }
      // Una sola vez: si ya se pregunto y se contesto, volver a preguntar seria
      // un ciclo. El prompt ya se lo dice, y esto lo hace cumplir.
      if (corrida.respuestas) {
        return reply.code(409).send({
          code: 'ya_pregunto',
          message: 'ya preguntaste y te contestaron. No preguntes de nuevo: planifica con eso.',
        });
      }

      await api.store.guardarPreguntas(corrida.id, cuerpo.data.preguntas);
      return reply.code(200).send({
        output:
          'anotadas. Terminá tu respuesta ahora sin llamar reportar_huecos: ' +
          'te voy a volver a pedir el plan cuando tenga las respuestas.',
      });
    });

    /**
     * Un cable suelto que anota el AGENTE.
     *
     * Los otros dos los anota el sistema —crear un repo, crear una base— porque
     * los sabe con certeza. Este existe para lo que solo sabe quien escribio el
     * codigo: que variables de entorno pide, que servicio externo hay que dar de
     * alta, que dominio hay que apuntar.
     *
     * Sin esto, el informe de la mañana lista los dos cables que el sistema
     * conoce y calla los cinco que el agente inventó al construir. Y esos son
     * justo los que nadie mas puede adivinar.
     */
    const CuerpoPendiente = z.object({
      jobId: z.string().uuid(),
      // Corto a proposito: es una linea de un informe que se lee en un
      // telefono, no una explicacion.
      texto: z.string().min(1).max(300),
    });

    app.post('/interno/corrida/pendiente', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoPendiente.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el texto' });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        // El mensaje lo repite el modelo: dice que hacer en vez de solo fallar.
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no es de una corrida, asi que no hay informe donde anotarlo. ' +
            'No reintentes: decilo en tu respuesta.',
        });
      }
      // Lo que el sistema ya resolvio no se anota. El agente ve los
      // placeholders de appsettings.json y no puede ver Render, asi que en AH
      // (2026-09-27) el informe pedia cargar la conexion y el Jwt__Key -y
      // liberar un proyecto de Supabase- con todo andando.
      if (
        esPendienteDeBase(cuerpo.data.texto) &&
        (await api.store.conexionDeBaseDelJob(cuerpo.data.jobId).catch(() => undefined))
      ) {
        return reply.code(200).send({
          output:
            'no lo anote: este proyecto ya tiene la base creada y el sistema le carga ' +
            'ConnectionStrings__DefaultConnection y Jwt__Key al back en Render. Los placeholders de ' +
            'appsettings.json estan bien asi: en produccion mandan las variables de entorno.',
        });
      }
      await api.store.anotarPendiente(corrida.id, cuerpo.data.texto);
      return reply.code(200).send({ output: 'anotado para el informe' });
    });

    /**
     * Como termino la tarea, dicho por el agente. La tarea sale del jobId, como
     * en las otras: un id en el cuerpo seria un dato que el modelo puede cambiar.
     */
    const CuerpoResultado = z.object({
      jobId: z.string().uuid(),
      resultado: z.enum(['hecho', 'sin_cambios', 'bloqueada']),
      motivo: z.string().max(300).optional(),
    });

    app.post('/interno/corrida/resultado', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoResultado.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'resultado invalido' });
      }
      await api.store.declararResultado(cuerpo.data.jobId, cuerpo.data.resultado, cuerpo.data.motivo);
      return reply.code(200).send({
        output:
          cuerpo.data.resultado === 'bloqueada'
            ? 'anotado como bloqueada: va al informe como algo que tiene que resolver una persona'
            : 'anotado',
      });
    });

    /**
     * La firma de uno de los cuatro analistas sobre su eje.
     *
     * Ver
     * `multicodigo-vm/docs/superpowers/specs/2026-09-10-piso-minimo-y-cuatro-analistas-design.md`.
     *
     * Es una herramienta APARTE de `reportar_huecos` porque son dos cosas
     * distintas: los huecos son trabajo que se encola, esto es una opinion que
     * se lee. Meterlas en una sola obligaria a decidir que pasa cuando alguien
     * manda huecos sin veredicto —o al reves— y esa decision no tiene una
     * respuesta buena.
     *
     * Como en las otras tres: la corrida sale del jobId y no del cuerpo. Un id
     * de corrida que el modelo elige es un id con el que podria firmarle el
     * informe a otro chat.
     */
    const CuerpoVeredicto = z.object({
      jobId: z.string().uuid(),
      eje: z.enum(EJES),
      cumple: z.boolean(),
      // Del largo de dos lineas de un informe que se lee en un telefono. Un
      // veredicto de tres parrafos no se lee, y lo que hay que hacer con lo que
      // no cumple ya viaja como hueco por el otro endpoint.
      resumen: z.string().min(1).max(300),
    });

    app.post('/interno/corrida/veredicto', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoVeredicto.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({
          code: 'cuerpo_invalido',
          message:
            'el veredicto necesita el eje (usuario, visual, funcionamiento o testeos), si cumple, ' +
            'y un resumen de hasta 300 caracteres.',
        });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        // El mensaje lo repite el modelo: dice que hacer, no solo que fallo.
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no pertenece a ninguna corrida abierta, asi que no hay informe donde ' +
            'firmar. No reintentes: decilo en tu respuesta.',
        });
      }

      await api.store.guardarVeredicto(
        corrida.id,
        cuerpo.data.eje,
        cuerpo.data.cumple,
        cuerpo.data.resumen,
      );
      return reply
        .code(200)
        .send({ output: `anotado: tu veredicto de ${cuerpo.data.eje} va en el informe` });
    });

    /**
     * El contrato entre el front y el back, que fija el planificador.
     *
     * Ver `Corrida.contrato`. Como en las otras, la corrida sale del jobId y no
     * del cuerpo: un id de corrida que el modelo elige es uno con el que podria
     * pisarle el contrato a otro chat.
     */
    const CuerpoContrato = z.object({
      jobId: z.string().uuid(),
      // Generoso: un contrato de quince rutas con sus campos entra holgado. El
      // tope es para que un volcado accidental —un archivo entero pegado— no
      // termine inyectado en el prompt de cada tarea de la noche.
      contrato: z.string().min(1).max(20_000),
    });

    app.post('/interno/corrida/contrato', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoContrato.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({
          code: 'cuerpo_invalido',
          message: 'el contrato tiene que ser texto, de hasta 20.000 caracteres',
        });
      }
      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no pertenece a ninguna corrida abierta, asi que no hay donde fijar el ' +
            'contrato. No reintentes: segui con la lista.',
        });
      }
      await api.store.guardarContrato(corrida.id, cuerpo.data.contrato);
      return reply.code(200).send({
        output: 'contrato fijado: lo van a leer todos los agentes que construyan. Ahora arma la lista.',
      });
    });

    /** Las fichas de las caracteristicas, que fija el planificador. Ver `Corrida.fichas`. */
    const CuerpoFichas = z.object({
      jobId: z.string().uuid(),
      // Mas que el contrato: son todas las caracteristicas con sus items.
      fichas: z.string().min(1).max(40_000),
    });

    app.post('/interno/corrida/fichas', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoFichas.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({
          code: 'cuerpo_invalido',
          message: 'las fichas tienen que ser texto, de hasta 40.000 caracteres',
        });
      }
      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        return reply.code(400).send({
          code: 'sin_corrida',
          message: 'este turno no pertenece a ninguna corrida abierta. No reintentes: segui con la lista.',
        });
      }
      await api.store.guardarFichas(corrida.id, cuerpo.data.fichas);
      return reply.code(200).send({
        output: 'fichas fijadas: las van a leer las tareas y las van a verificar los analistas. Ahora arma la lista.',
      });
    });

    /**
     * Drive en vivo.
     *
     * Se registra solo si hay con que: sin el secret de Google no hay forma de
     * canjear un refresh token, y una herramienta que existe pero nunca puede
     * funcionar es peor que una que no esta.
     */
    if (api.drive) {
      registrarDrive(app, { ...api.drive, store: api.store, apiToken: api.apiToken });
    }

    /**
     * Supabase, para que una corrida pueda dejar la base creada y migrada.
     *
     * Se registra SIEMPRE, tenga o no token: los endpoints contestan 503 con un
     * mensaje que el agente puede repetir. Al reves que Drive —que no registra
     * nada sin secret— porque aca la diferencia importa: sin las rutas, el
     * gateway contestaria 404 y el modelo leeria "esa herramienta no existe",
     * que lo manda a inventar otra forma de crear la base.
     */
    registrarAltas(app, { apiToken: api.apiToken, darDeAlta: api.altas });
    registrarTrabajo(app, { apiToken: api.apiToken, trabajo: api.trabajo });
    registrarClaudes(app, { apiToken: api.apiToken, registrar: api.registrarClaude });

    registrarSupabase(app, {
      ...(api.supabase ?? {}),
      apiToken: api.apiToken,
      // Del jobId a la corrida: es el mismo salto que hace `reportar_huecos`, y
      // por lo mismo — el id de la corrida en el cuerpo seria un dato que el
      // modelo puede cambiar.
      anotarPendiente: async (jobId: string, texto: string) => {
        const corrida = await api.store.corridaDeJob(jobId);
        if (corrida) await api.store.anotarPendiente(corrida.id, texto);
      },
      // La conexion a la base queda guardada del lado del servidor, para que
      // `publicar()` se la escriba al back como variable de entorno. La
      // contraseña sigue sin pasar por el modelo: nace y muere en el bridge.
      guardarConexion: (jobId: string, conexion: string) =>
        api.store.guardarConexionDeBase(jobId, conexion),
      baseExistente: async (jobId: string) => Boolean(await api.store.conexionDeBaseDelJob(jobId)),
    });

    /**
     * Invalida las sesiones de un slot.
     *
     * Lo llama el servicio de login de la VM cuando saca o rota la cuenta de un
     * slot: los `session_id` guardados apuntan a transcripts que viven en el
     * HOME de ESA cuenta, y con la cuenta nueva ya no existen. Sin este barrido,
     * el proximo mensaje de cada chat falla en el `--resume` con un error que no
     * le dice nada a nadie.
     */
    app.delete<{ Params: { id: string } }>('/agents/:id/sessions', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      // El id entra en una consulta y sale en la respuesta: se valida contra la
      // forma de slot del contrato antes de tocar nada.
      const agent = AgentId.safeParse(request.params.id);
      if (!agent.success) {
        return reply.code(404).send({ code: 'unknown_agent', message: request.params.id });
      }
      return reply.code(200).send({ borradas: await api.store.deleteSessions(agent.data) });
    });
  }

  return app;
}

/**
 * Si un pendiente habla de la base, su conexion o el Jwt__Key: lo que el
 * sistema maneja solo cuando el proyecto ya tiene base (ver `publicar.ts`).
 */
export function esPendienteDeBase(texto: string): boolean {
  return /ConnectionStrings|connection ?string|cadena de conexi|Jwt(__|:| )?Key|base (de datos )?(de |en )?Supabase|proyecto (de|en) Supabase|crear (la|una) base|(tope|l[ií]mite) de .*proyectos/i.test(
    texto,
  );
}
