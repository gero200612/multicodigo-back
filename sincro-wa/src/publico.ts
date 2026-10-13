import Fastify, { type FastifyInstance } from 'fastify';
import type { Contexto } from './contexto.js';
import { recibirFormulario, TopePorIp, type ConfigDeFormulario } from './formulario.js';
import { textoDeError } from './tapar.js';
import { firmaValida, procesarWebhook } from './webhook.js';

/**
 * El servidor publico: lo unico que llega desde internet (por Traefik). Sirve
 * el webhook de Meta, la salud y, si el despliegue lo prende, el formulario de
 * contacto de la web del negocio. Es otro Fastify, no un prefijo del
 * privado: una ruta privada no se puede alcanzar desde aca aunque alguien se
 * equivoque con Traefik, porque este servidor no la tiene.
 */
export function crearPublico(
  ctx: Contexto,
  cfg: { appSecret: string; verifyToken: string; formulario?: ConfigDeFormulario },
): FastifyInstance {
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

  if (cfg.formulario) rutasDelFormulario(app, ctx, cfg.formulario);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'no_existe' }));
  return app;
}

function rutasDelFormulario(app: FastifyInstance, ctx: Contexto, cfg: ConfigDeFormulario): void {
  const tope = new TopePorIp();
  // Solo la web del negocio puede mandarlo desde un navegador. Un origen ajeno
  // no recibe los encabezados y el navegador corta.
  const cors = (origen: string | undefined): Record<string, string> =>
    origen && cfg.origenes.includes(origen)
      ? {
          'access-control-allow-origin': origen,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
          vary: 'origin',
        }
      : { vary: 'origin' };

  app.options('/formulario', async (req, reply) => reply.code(204).headers(cors(req.headers.origin)).send());

  app.post('/formulario', async (req, reply) => {
    reply.headers(cors(req.headers.origin));
    if (!req.headers.origin || !cfg.origenes.includes(req.headers.origin)) {
      return reply.code(403).send({ code: 'origen_no_permitido' });
    }
    // Detras de Traefik la IP de verdad es la primera de x-forwarded-for.
    const reenviada = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(reenviada) ? reenviada[0] : reenviada)?.split(',')[0]?.trim() || req.ip;
    if (!tope.pasa(ip, ctx.ahora().getTime())) return reply.code(429).send({ code: 'demasiados_envios' });

    const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (crudo.length > 16 * 1024) return reply.code(413).send({ code: 'muy_largo' });
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(crudo.toString('utf8'));
    } catch {
      return reply.code(400).send({ code: 'json_invalido' });
    }
    try {
      const r = await recibirFormulario(ctx, cfg, cuerpo);
      if (!r.ok) return reply.code(r.status).send({ code: r.code });
      return { ok: true };
    } catch (e) {
      ctx.log(`formulario: ${textoDeError(e)}`);
      return reply.code(500).send({ code: 'error' });
    }
  });
}
