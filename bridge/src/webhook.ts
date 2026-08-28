import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { isTokenValid } from '@multicodigo/shared';
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
  store: Pick<Store, 'recentJobs' | 'canjearCodigo' | 'usuarioDeChat'>;
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

    const CuerpoVinculo = z.object({
      codigo: z.string().min(1).max(32),
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
  }

  return app;
}
