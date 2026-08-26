import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { isTokenValid } from '@multicodigo/shared';
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
  store: Pick<Store, 'recentJobs'>;
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
  }

  return app;
}
