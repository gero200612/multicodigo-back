import type { FastifyInstance } from 'fastify';
import { isTokenValid } from '@multicodigo/shared';
import { z } from 'zod';
import type { EnCurso } from './gateway-admin.js';
import type { Store } from './store.js';

/**
 * El trabajo en curso de la empresa, para que los agentes no se pisen.
 *
 * Spec: docs/superpowers/specs/2026-10-04-empresas-design.md (parte C).
 *
 * El gateway sabe qué agentes tienen cambios sin mergear en cada repo, pero no
 * sabe de empresas. Acá se filtra: solo lo de la MISMA empresa que la persona,
 * y si el proyecto del otro agente no lo puede ver (privado sin asignar), se
 * dice que existe pero no cuál es. La protección cubre a toda la empresa
 * aunque no todos vean todo.
 */

export interface TrabajoVisible {
  agente: string;
  /** Null si es de un proyecto que esta persona no puede ver. */
  proyecto: string | null;
  repo: string;
  rama: string;
  archivos: string[];
  sinCommitear: boolean;
}

export interface TrabajoDeps {
  store: Pick<Store, 'proyectosDeMiEmpresa'>;
  trabajoEnCurso: (repos: string[]) => Promise<EnCurso[]>;
}

export async function trabajoDeMiEmpresa(
  usuarioId: string,
  repos: string[],
  deps: TrabajoDeps,
  excluirAgente?: string,
): Promise<TrabajoVisible[]> {
  const crudo = (await deps.trabajoEnCurso(repos)).filter((t) => t.agente !== excluirAgente);
  if (crudo.length === 0) return [];
  const nombres = [...new Set(crudo.map((t) => t.proyecto))];
  const deMiEmpresa = new Map(
    (await deps.store.proyectosDeMiEmpresa(usuarioId, nombres)).map((p) => [p.nombre, p.visible]),
  );
  return crudo
    .filter((t) => deMiEmpresa.has(t.proyecto))
    .map((t) => ({ ...t, proyecto: deMiEmpresa.get(t.proyecto) ? t.proyecto : null }));
}

/** Cuántos archivos se nombran por agente en el aviso: el resto se cuenta. */
const ARCHIVOS_EN_EL_AVISO = 25;

/**
 * El aviso que se le agrega a las instrucciones del agente. Undefined si no
 * hay nada que avisar: un aviso vacío es ruido en cada turno.
 */
export function avisoDeTrabajo(trabajo: TrabajoVisible[]): string | undefined {
  if (trabajo.length === 0) return undefined;
  const lineas = trabajo.map((t) => {
    const donde = t.proyecto ? `proyecto ${t.proyecto}` : 'otro proyecto de la empresa';
    const estado = t.sinCommitear ? 'escribiendo ahora' : 'con cambios sin mergear';
    const nombrados = t.archivos.slice(0, ARCHIVOS_EN_EL_AVISO).join(', ');
    const resto = t.archivos.length > ARCHIVOS_EN_EL_AVISO ? ` y ${t.archivos.length - ARCHIVOS_EN_EL_AVISO} más` : '';
    return `- ${t.agente} (${donde}), repo ${t.repo}, rama ${t.rama}, ${estado}: ${nombrados}${resto}`;
  });
  return [
    '## Trabajo en curso de otros agentes de tu empresa',
    '',
    'Estos agentes tienen cambios sin mergear en los mismos repos que vos. Para no pisarse:',
    '- Evitá modificar esos archivos. Si tu tarea los necesita, hacé el cambio mínimo y decilo en tu respuesta.',
    '- No reformatees ni muevas archivos que otro está tocando.',
    '- Si el pedido choca de frente con ese trabajo, avisalo antes de avanzar.',
    '',
    ...lineas,
  ].join('\n');
}

/**
 * `POST /interno/trabajo`: el trabajo en curso de TODA la empresa de la
 * persona, para la sección "En curso" del panel. Lo llama el panel con el
 * usuario que sale del JWT, como el resto de `/interno`.
 */
export function registrarTrabajo(
  app: FastifyInstance,
  deps: {
    apiToken: string;
    trabajo?: (usuarioId: string) => Promise<TrabajoVisible[]>;
  },
): void {
  app.post('/interno/trabajo', async (request, reply) => {
    if (!isTokenValid(request.headers.authorization, deps.apiToken)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    const cuerpo = z.object({ usuarioId: z.string().uuid() }).safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el usuario' });
    }
    // Sin gateway de admin no se puede mirar: lista vacia, no un error. La
    // pantalla dice "nadie trabajando", que es lo que se puede saber.
    if (!deps.trabajo) return reply.code(200).send({ trabajo: [] });
    return reply.code(200).send({ trabajo: await deps.trabajo(cuerpo.data.usuarioId).catch(() => []) });
  });
}
