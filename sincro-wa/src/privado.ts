import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { registrarRutasDeAdmin } from './admin-api.js';
import { registrarRutasDeApp } from './app-api.js';
import { rutaPermitida } from './capacidades.js';
import { mismaClave, negocioDeClave } from './claves.js';
import type { Contexto } from './contexto.js';
import { Rechazo } from './envio.js';
import type { Negocio } from './store.js';
import { textoDeError } from './tapar.js';

/**
 * El servidor privado: solo por VPN y por la red de Coolify. Aca viven las
 * rutas de las apps y las de admin, detras de la misma puerta.
 *
 * La puerta niega por defecto. Sin clave, 401. Con una clave valida que no
 * tiene la capacidad de la ruta, 404: para esa app la ruta no existe, igual
 * que una que no esta publicada, y el intento queda registrado.
 */

export type Acceso = { tipo: 'admin' } | { tipo: 'app'; negocio: Negocio };

declare module 'fastify' {
  interface FastifyRequest {
    acceso: Acceso | null;
  }
}

export const NO_EXISTE = { code: 'no_existe' } as const;

/** El negocio de una ruta de app. La puerta ya garantizo que hay uno. */
export function negocioDe(req: FastifyRequest): Negocio {
  if (req.acceso?.tipo !== 'app') throw new Rechazo(404, 'no_existe');
  return req.acceso.negocio;
}

function claveDe(req: FastifyRequest): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  return m?.[1];
}

const sha = (s: string) => createHash('sha256').update(s).digest();

// La ultima vez que se uso la clave se guarda como mucho una vez por minuto:
// un long-poll cada 25 s no tiene por que escribir en la base cada vez.
const USO_CADA_MS = 60_000;

export function crearPrivado(ctx: Contexto, cfg: { claveAdmin: string }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const admin = sha(cfg.claveAdmin);
  const esAdmin = (clave: string) => timingSafeEqual(sha(clave), admin);

  app.decorateRequest('acceso', null);

  app.addHook('onRequest', async (req, reply) => {
    const clave = claveDe(req);
    if (!clave) return reply.code(401).send({ code: 'sin_clave' });
    const patron = req.routeOptions.url;
    const ruta = patron ? `${req.method} ${patron}` : undefined;
    const camino = patron ?? req.url.split('?')[0] ?? '';
    const deAdmin = camino === '/admin' || camino.startsWith('/admin/');

    if (esAdmin(clave)) {
      // La de admin no usa rutas de app.
      if (!ruta || !deAdmin) return reply.code(404).send(NO_EXISTE);
      req.acceso = { tipo: 'admin' };
      return;
    }

    const id = negocioDeClave(clave);
    const negocio = id === undefined ? undefined : await ctx.store.negocio(id);
    if (!negocio || !mismaClave(clave, negocio.claveHash)) return reply.code(401).send({ code: 'sin_clave' });
    if (!negocio.activo) return reply.code(404).send(NO_EXISTE);

    const ahora = ctx.ahora();
    if (!negocio.claveUltimoUso || ahora.getTime() - negocio.claveUltimoUso.getTime() >= USO_CADA_MS) {
      await ctx.store.usoDeClave(negocio.id, ahora);
    }
    if (!ruta || deAdmin || !rutaPermitida(negocio.capacidades, ruta)) {
      await ctx.store.registrarIntentoNegado(negocio.id, req.method, camino, ahora);
      return reply.code(404).send(NO_EXISTE);
    }
    req.acceso = { tipo: 'app', negocio };
  });

  app.setErrorHandler(async (e, req, reply) => {
    if (e instanceof Rechazo) {
      // Un no_existe que sale de adentro de una ruta (una plantilla de
      // marketing pedida con `avisos`) es un intento negado igual que en la puerta.
      if (e.code === 'no_existe' && req.acceso?.tipo === 'app') {
        await ctx.store.registrarIntentoNegado(req.acceso.negocio.id, req.method, req.url.split('?')[0] ?? '', ctx.ahora());
      }
      return reply.code(e.status).send(e.detalle ? { code: e.code, detalle: e.detalle } : { code: e.code });
    }
    if (e instanceof ZodError) {
      const i = e.issues[0];
      return reply.code(400).send({ code: 'invalido', detalle: i ? `${i.path.join('.') || 'cuerpo'}: ${i.message}` : '' });
    }
    const status = (e as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ code: 'invalido', detalle: textoDeError(e) });
    ctx.log(`${req.method} ${req.url.split('?')[0]}: ${textoDeError(e)}`);
    return reply.code(500).send({ code: 'error' });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(NO_EXISTE));

  registrarRutasDeApp(app, ctx);
  registrarRutasDeAdmin(app, ctx);
  return app;
}
