import { crearServicio, type RenderDeps } from './render-api.js';
import type { Store } from './store.js';

/**
 * Que se publica al cerrar una corrida, y que queda como cable suelto.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-08-deploy-render-design.md`.
 *
 * Es politica pura: no habla HTTP con nadie. El merge y la creacion del
 * servicio entran por `deps`, asi que probar las decisiones de aca no necesita
 * ni un doble de fetch ni un worktree. `render-api.ts` es el que habla con
 * Render y no sabe nada de corridas; este sabe de corridas y no sabe de HTTP.
 */

export interface Publicado {
  repo: string;
  url: string;
}

export interface PublicarDeps {
  store: Pick<Store, 'reposDeProyecto' | 'guardarRenderServiceId'>;
  render: RenderDeps;
  mergear: (req: {
    agent: string;
    project: string;
    repo: string;
    creadoPorElBot: boolean;
  }) => Promise<{ ok: boolean; output: string }>;
  /**
   * Si el worktree del repo tiene `package.json`, y si usa SQLite.
   *
   * Entran como funciones porque miran el disco del GATEWAY, no el del bridge.
   * De paso, los tests de politica no necesitan un worktree de verdad.
   */
  tienePackageJson: (project: string, repo: string) => Promise<boolean>;
  usaSqlite?: (project: string, repo: string) => Promise<boolean>;
}

/**
 * El texto que el sistema ya emite hoy, literal.
 *
 * El piso de esta feature es "nunca peor que hoy": un servidor sin Render
 * configurado tiene que dejar el mismo informe que dejaba antes.
 */
const PENDIENTE_A_MANO = (github: string) =>
  `conectar ${github} a Vercel o a Render (la primera vez es a mano; despues cada push hace un preview solo)`;

export async function publicar(
  proyectoId: string,
  proyecto: string,
  agente: string,
  deps: PublicarDeps,
): Promise<{ publicados: Publicado[]; pendientes: string[] }> {
  const publicados: Publicado[] = [];
  const pendientes: string[] = [];

  // EN SERIE y no en paralelo, por la misma razon que el bucle que crea los
  // repos en `pipeline.ts`: si el tercero falla, los dos primeros ya estan y el
  // mensaje puede decir exactamente cuales. En paralelo el estado queda mas
  // dificil de contar que de arreglar.
  for (const repo of await deps.store.reposDeProyecto(proyectoId)) {
    // Un repo que conecto una persona no se toca, y NO genera pendiente: no es
    // un cable suelto, es algo que no le corresponde a este sistema. La
    // diferencia importa — un pendiente le pide algo a alguien, y aca no hay
    // nada que pedir.
    if (!repo.creado_por_el_bot) continue;

    // Un repo vacio —como quedo `propinas-front`, que el pliego dejo sin
    // contenido— no tiene nada que arrancar. Tampoco es un pendiente: no falta
    // nada.
    if (!(await deps.tienePackageJson(proyecto, repo.nombre))) continue;

    // Idempotencia: dos corridas sobre el mismo proyecto no pueden dejar dos
    // servicios facturando. Se mira lo guardado y no se le pregunta a Render:
    // preguntar significa buscar por nombre, y un nombre repetido no dice si el
    // servicio es de este proyecto o de otro que se llamo igual.
    if (repo.render_service_id) continue;

    const m = await deps.mergear({
      agent: agente,
      project: proyecto,
      repo: repo.nombre,
      creadoPorElBot: true,
    });
    if (!m.ok) {
      // Y NO se crea el servicio: una URL que responde contra un main vacio es
      // peor que ninguna URL, porque promete algo que no esta. Se sigue con el
      // repo que viene.
      pendientes.push(`no pude mergear ${repo.nombre} a main (${m.output}): conectalo a mano`);
      continue;
    }

    const r = await crearServicio(repo.nombre, repo.github_repo, deps.render);
    if (r.estado === 'sin_render') {
      pendientes.push(PENDIENTE_A_MANO(repo.github_repo));
      continue;
    }
    if (r.estado === 'error') {
      pendientes.push(
        `no pude crear el servicio de ${repo.nombre} en Render (${r.motivo}): conectalo a mano`,
      );
      continue;
    }

    await deps.store.guardarRenderServiceId(proyectoId, repo.nombre, r.serviceId);
    publicados.push({ repo: repo.nombre, url: r.url });

    // El cable que queda. Nombra el servicio Y la URL: a la mañana, con dos
    // proyectos nuevos, "carga las env vars" sin decir de cual no alcanza.
    pendientes.push(`cargar las env vars de ${repo.nombre} en Render (${r.url})`);

    // El disco efimero, que es el que muerde sin avisar: en el plan free se
    // borra en cada deploy y en cada spin-down. Un proyecto que guarda en
    // SQLite va a andar y va a perder los datos solo. Sin este aviso, la
    // primera perdida manda a buscar un bug que no existe.
    if (await deps.usaSqlite?.(proyecto, repo.nombre)) {
      pendientes.push(
        `${repo.nombre} guarda en SQLite y el plan free borra el disco en cada deploy: ` +
          'los datos no van a sobrevivir. Para que persistan hay que pasarlo a Postgres o pagar un disco',
      );
    }
  }

  return { publicados, pendientes };
}
