import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';

export function buildWebhookServer(
  bot: Pick<Bot, 'handleUpdate'>,
  webhookSecret: string,
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

  return app;
}
