import Fastify, { type FastifyInstance } from 'fastify';
import type { Contexto } from './contexto.js';
import { textoDeError } from './tapar.js';
import { firmaValida, procesarWebhook } from './webhook.js';

/**
 * El servidor publico: lo unico que llega desde internet (por Traefik). Sirve
 * el webhook de Meta y la salud, nada mas. Es otro Fastify, no un prefijo del
 * privado: una ruta privada no se puede alcanzar desde aca aunque alguien se
 * equivoque con Traefik, porque este servidor no la tiene.
 */
export function crearPublico(ctx: Contexto, cfg: { appSecret: string; verifyToken: string }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  // El cuerpo se queda crudo: la firma de Meta se calcula sobre los bytes tal
  // cual llegaron. Cualquier content-type, para que un pedido raro dé 401 y no 415.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, cuerpo, listo) => listo(null, cuerpo));

  app.get('/salud', async () => ({ ok: true }));

  // La verificacion que hace Meta al configurar el webhook.
  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === cfg.verifyToken && q['hub.challenge']) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.code(403).send({ code: 'verificacion_invalida' });
  });

  app.post('/webhook', async (req, reply) => {
    const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const firma = req.headers['x-hub-signature-256'];
    if (!firmaValida(crudo, Array.isArray(firma) ? firma[0] : firma, cfg.appSecret)) {
      return reply.code(401).send({ code: 'firma_invalida' });
    }
    let cuerpo: Record<string, unknown>;
    try {
      cuerpo = JSON.parse(crudo.toString('utf8')) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ code: 'json_invalido' });
    }
    try {
      await procesarWebhook(ctx, cuerpo);
    } catch (e) {
      // Con un 500 Meta reintenta; lo ya guardado se descarta por wamid.
      ctx.log(`webhook: ${textoDeError(e)}`);
      return reply.code(500).send({ code: 'error' });
    }
    return { ok: true };
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'no_existe' }));
  return app;
}
