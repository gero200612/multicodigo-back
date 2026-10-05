import type { FastifyInstance } from 'fastify';
import { AgentId, isTokenValid } from '@multicodigo/shared';
import { z } from 'zod';

/**
 * `POST /interno/claudes/registrar`: anota a nombre de una persona el slot que
 * el gateway le acaba de crear (parte B de empresas, migracion 041).
 *
 * Es del bridge y no del navegador a proposito: con el INSERT abierto por REST,
 * cualquiera anotaria a su nombre un slot que ya existe —con la cuenta de
 * Claude de otra persona adentro— y se quedaria con el. Lo llama solo el
 * panel, con el token interno, despues de crear el contenedor; el usuario sale
 * del JWT que el panel ya verifico.
 */
export function registrarClaudes(
  app: FastifyInstance,
  deps: {
    apiToken: string;
    registrar?: (usuarioId: string, proyectoId: string, slot: string) => Promise<boolean>;
  },
): void {
  const Cuerpo = z.object({
    usuarioId: z.string().uuid(),
    proyectoId: z.string().uuid(),
    slot: AgentId,
  });

  app.post('/interno/claudes/registrar', async (request, reply) => {
    if (!isTokenValid(request.headers.authorization, deps.apiToken)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    if (!deps.registrar) {
      return reply.code(503).send({ code: 'registro_apagado', message: 'no se pueden registrar agentes' });
    }
    const cuerpo = Cuerpo.safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos del agente' });
    }
    const { usuarioId, proyectoId, slot } = cuerpo.data;
    if (!(await deps.registrar(usuarioId, proyectoId, slot))) {
      return reply.code(403).send({ code: 'solo_lectura', message: 'no podés crear agentes en este proyecto' });
    }
    return reply.code(200).send({ slot });
  });
}
