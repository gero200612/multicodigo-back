import { describe, it, expect } from 'vitest';
import { publicar, type PublicarDeps } from '../src/publicar.js';
import type { ResultadoDeConfig } from '../src/conectar.js';
import type { RepoDelProyecto } from '../src/store.js';

/**
 * Como se combinan los dos caminos para conectar el front con el back: la
 * variable de entorno y el `config.js`.
 *
 * El caso que los hace necesarios a los dos es `mesas` (2026-09-10): la
 * variable quedo seteada, el front no la leia, y el informe dio la conexion por
 * hecha.
 */

const DOS: RepoDelProyecto[] = [
  {
    nombre: 'mesas-front',
    github_repo: 'Sincro-arg/mesas-front',
    creado_por_el_bot: true,
    render_service_id: null,
  },
  {
    nombre: 'mesas-back',
    github_repo: 'Sincro-arg/mesas-back',
    creado_por_el_bot: true,
    render_service_id: null,
  },
];

/** El front sale como srv-1 (se publica primero) y el back como srv-2. */
function conDosRepos(over: Partial<PublicarDeps>): PublicarDeps & { desplegados: string[] } {
  let n = 0;
  const desplegados: string[] = [];
  return {
    store: {
      reposDeProyecto: async () => DOS,
      guardarRenderServiceId: async () => undefined,
    },
    render: {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () => {
        n += 1;
        return new Response(
          JSON.stringify({
            service: { id: `srv-${n}`, serviceDetails: { url: `https://servicio-${n}.onrender.com` } },
          }),
          { status: 201 },
        );
      }) as typeof fetch,
    },
    mergear: async () => ({ ok: true, output: '' }),
    tienePackageJson: async () => true,
    desplegar: async (id) => {
      desplegados.push(id);
      return { ok: true };
    },
    desplegados,
    ...over,
  };
}

const config = (r: ResultadoDeConfig) => async () => r;

describe('conectar por entorno y por config.js', () => {
  it('le pasa el repo del FRONT y la URL del BACK', async () => {
    const pedidos: Array<{ repo: string; url: string }> = [];
    await publicar('p1', 'mesas', ['c1'], conDosRepos({
      reescribirConfig: async (repo, url) => {
        pedidos.push({ repo, url });
        return { estado: 'cambiado' };
      },
    }));

    expect(pedidos).toEqual([
      { repo: 'Sincro-arg/mesas-front', url: 'https://servicio-2.onrender.com' },
    ]);
  });

  // El caso de `mesas`, ahora bien: la variable sola no alcanzaba.
  it('con los dos saliendo bien, despliega el front UNA vez y no deja pendiente', async () => {
    const d = conDosRepos({
      setearEnvVar: async () => ({ ok: true }),
      reescribirConfig: config({ estado: 'cambiado' }),
    });
    const r = await publicar('p1', 'mesas', ['c1'], d);

    expect(d.desplegados).toEqual(['srv-1']);
    const pend = r.pendientes.join(' | ');
    expect(pend).not.toContain('no pude conectar');
    // El cable de las variables del front ya esta: pedirlo mandaria a cargar
    // algo que ya esta cargado. El del back se queda.
    expect(pend).not.toContain('cargar las env vars de mesas-front');
    expect(pend).toContain('cargar las env vars de mesas-back');
  });

  it('si la variable falla pero el config se reescribio, esta conectado igual', async () => {
    const d = conDosRepos({
      setearEnvVar: async () => ({ ok: false, motivo: 'no pude leer las que ya tenia' }),
      reescribirConfig: config({ estado: 'cambiado' }),
    });
    const r = await publicar('p1', 'mesas', ['c1'], d);

    expect(r.pendientes.join(' ')).not.toContain('no pude conectar');
    // El commit del config no se despliega solo con autoDeploy en no.
    expect(d.desplegados).toEqual(['srv-1']);
  });

  // Un front sin config.js recibe la URL por otro lado: la variable alcanza.
  it('sin config.js, la variable sola conecta y no se inventa un pendiente', async () => {
    const r = await publicar('p1', 'mesas', ['c1'], conDosRepos({
      setearEnvVar: async () => ({ ok: true }),
      reescribirConfig: config({ estado: 'sin_config' }),
    }));

    const pend = r.pendientes.join(' ');
    expect(pend).not.toContain('no pude conectar');
    expect(pend).not.toContain('config.js');
  });

  // Si el front no lee el entorno, el config era lo unico que lo conectaba:
  // que la variable haya salido bien no alcanza para callarlo.
  it('un error al reescribir el config se nombra aunque la variable haya salido', async () => {
    const r = await publicar('p1', 'mesas', ['c1'], conDosRepos({
      setearEnvVar: async () => ({ ok: true }),
      reescribirConfig: config({ estado: 'error', motivo: 'GitHub contesto 409' }),
    }));

    const pend = r.pendientes.join(' ');
    expect(pend).toContain('public/config.js');
    expect(pend).toContain('GitHub contesto 409');
    expect(pend).toContain('https://servicio-2.onrender.com');
  });

  it('si ninguno de los dos conecta, queda el pendiente de hacerlo a mano', async () => {
    const d = conDosRepos({
      setearEnvVar: async () => ({ ok: false, motivo: 'no pude leer las que ya tenia' }),
      reescribirConfig: config({ estado: 'sin_config' }),
    });
    const r = await publicar('p1', 'mesas', ['c1'], d);

    const pend = r.pendientes.join(' ');
    expect(pend).toContain('no pude conectar mesas-front con mesas-back');
    expect(pend).toContain('no pude leer');
    // Nada cambio: no hay nada que desplegar.
    expect(d.desplegados).toEqual([]);
  });

  // Que explote no puede comerse la publicacion entera.
  it('si reescribir el config explota, publica igual y lo nombra', async () => {
    const r = await publicar('p1', 'mesas', ['c1'], conDosRepos({
      setearEnvVar: async () => ({ ok: true }),
      reescribirConfig: async () => {
        throw new Error('red caida');
      },
    }));

    expect(r.publicados).toHaveLength(2);
    expect(r.pendientes.join(' ')).toContain('red caida');
  });
});
