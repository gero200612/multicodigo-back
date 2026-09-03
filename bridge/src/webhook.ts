import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { AgentId, ApprovalDecision, RepoDelPedido, isTokenValid } from '@multicodigo/shared';
import { decidir, type DecidirDeps } from './decisiones.js';
import { ejecutarTurnoConRelevo, type PipelineDeps } from './pipeline.js';
import { z } from 'zod';
import type { Store } from './store.js';

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
  >;
  /**
   * Como decidir una aprobacion desde afuera de Telegram.
   *
   * Es el MISMO camino que usan los botones del chat: el panel no escribe la
   * tabla por su cuenta, porque decidir tambien significa avisarle al gateway y
   * editar el mensaje del chat.
   */
  decisiones?: DecidirDeps;
  /**
   * Con que ejecutar un turno pedido desde el panel.
   *
   * Es el MISMO camino que el de Telegram: mismo job, mismo poller de
   * aprobaciones, misma sesion. Es lo que hace que los dos frentes compartan
   * hilo en vez de tener cada uno el suyo.
   */
  pipeline?: PipelineDeps;
  /**
   * Credencial propia, distinta del secret del webhook.
   *
   * Son dos cosas con dueños distintos: el secret lo tiene Telegram, este token
   * lo tiene el panel. Compartirlos significaria que quien puede leer tus
   * conversaciones puede tambien inyectar updates de Telegram.
   */
  apiToken: string;
}

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
    void bot.handleUpdate(request.body as never).catch((err: unknown) => {
      app.log.error({ err }, 'fallo el procesamiento del update');
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
          const r = await ejecutarTurnoConRelevo(pipeline, { ...cuerpo.data, origen: 'panel' });
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
