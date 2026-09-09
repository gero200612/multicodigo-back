import { describe, it, expect } from 'vitest';
import { publicar, type PublicarDeps } from '../src/publicar.js';
import type { RepoDelProyecto } from '../src/store.js';

const RESPUESTA_OK = JSON.stringify({
  service: { id: 'srv-1', serviceDetails: { url: 'https://x.onrender.com' } },
});

const UN_REPO: RepoDelProyecto[] = [
  {
    nombre: 'propinas-back',
    github_repo: 'Sincro-arg/propinas-back',
    creado_por_el_bot: true,
    render_service_id: null,
  },
];

function deps(over: Partial<PublicarDeps> = {}): PublicarDeps {
  return {
    store: {
      reposDeProyecto: async () => UN_REPO,
      guardarRenderServiceId: async () => undefined,
    },
    render: {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () => new Response(RESPUESTA_OK, { status: 201 })) as typeof fetch,
    },
    mergear: async () => ({ ok: true, output: '' }),
    tienePackageJson: async () => true,
    ...over,
  };
}

describe('publicar', () => {
  it('mergea y publica un repo del bot, y devuelve la URL', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps());
    expect(r.publicados).toEqual([{ repo: 'propinas-back', url: 'https://x.onrender.com' }]);
  });

  // Un repo de una persona no se toca, y tampoco genera pendiente: no es un
  // cable suelto, es algo que no le corresponde a este sistema.
  it('un repo que no creo el bot no se toca ni genera pendiente', async () => {
    let mergeo = false;
    const r = await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        store: {
          reposDeProyecto: async () => [
            {
              nombre: 'multicodigo-back',
              github_repo: 'gero200612/multicodigo-back',
              creado_por_el_bot: false,
              render_service_id: null,
            },
          ],
          guardarRenderServiceId: async () => undefined,
        },
        mergear: async () => {
          mergeo = true;
          return { ok: true, output: '' };
        },
      }),
    );
    expect(mergeo).toBe(false);
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });

  // Idempotencia: dos corridas no pueden dejar dos servicios facturando.
  it('un repo que ya tiene servicio no crea otro', async () => {
    let llamo = false;
    await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        store: {
          reposDeProyecto: async () => [{ ...UN_REPO[0]!, render_service_id: 'srv-viejo' }],
          guardarRenderServiceId: async () => undefined,
        },
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            llamo = true;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
    );
    expect(llamo).toBe(false);
  });

  // El front de una corrida real quedo asi, vacio: no falta nada, no hay nada
  // que arrancar.
  it('un repo sin package.json se saltea sin ruido', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps({ tienePackageJson: async () => false }));
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });

  // Una URL que responde contra un main vacio es peor que ninguna URL.
  it('si el merge falla, NO se crea el servicio y queda como pendiente', async () => {
    let llamo = false;
    const r = await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        mergear: async () => ({ ok: false, output: 'Not possible to fast-forward' }),
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            llamo = true;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
    );
    expect(llamo).toBe(false);
    expect(r.publicados).toEqual([]);
    expect(r.pendientes.join(' ')).toContain('propinas-back');
  });

  // El piso de esta feature es "nunca peor que hoy".
  it('sin Render configurado vuelve el pendiente de siempre', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps({ render: {} }));
    expect(r.publicados).toEqual([]);
    expect(r.pendientes.join(' ')).toContain('a mano');
  });

  it('el fallo de un repo no cancela al otro', async () => {
    const r = await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        store: {
          reposDeProyecto: async () => [
            { nombre: 'a', github_repo: 'org/a', creado_por_el_bot: true, render_service_id: null },
            { nombre: 'b', github_repo: 'org/b', creado_por_el_bot: true, render_service_id: null },
          ],
          guardarRenderServiceId: async () => undefined,
        },
        mergear: async (req) =>
          req.repo === 'a' ? { ok: false, output: 'x' } : { ok: true, output: '' },
      }),
    );
    expect(r.publicados.map((p) => p.repo)).toEqual(['b']);
    expect(r.pendientes.join(' ')).toContain('a');
  });

  it('guarda el service id para que la proxima corrida no cree otro', async () => {
    let guardado = '';
    await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        store: {
          reposDeProyecto: async () => UN_REPO,
          guardarRenderServiceId: async (_p, _n, id) => {
            guardado = id;
          },
        },
      }),
    );
    expect(guardado).toBe('srv-1');
  });

  it('el pendiente de las env vars nombra el repo y la URL', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps());
    const env = r.pendientes.find((p) => p.includes('env vars'));
    expect(env).toContain('propinas-back');
    expect(env).toContain('https://x.onrender.com');
  });

  // Sin esto, la primera perdida de datos manda a buscar un bug que no existe.
  it('avisa del disco efimero si el repo usa sqlite', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps({ usaSqlite: async () => true }));
    expect(r.pendientes.join(' ')).toContain('SQLite');
  });

  it('no avisa del disco si el repo no usa sqlite', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps({ usaSqlite: async () => false }));
    expect(r.pendientes.join(' ')).not.toContain('SQLite');
  });

  // Si Render se cae a mitad del bucle, el informe tiene que decir exactamente
  // que quedo publicado y que no.
  it('con Render caido a mitad, nombra el que salio y el que no', async () => {
    let n = 0;
    const r = await publicar(
      'p1',
      'propinas',
      ['c2'],
      deps({
        store: {
          reposDeProyecto: async () => [
            { nombre: 'a', github_repo: 'org/a', creado_por_el_bot: true, render_service_id: null },
            { nombre: 'b', github_repo: 'org/b', creado_por_el_bot: true, render_service_id: null },
          ],
          guardarRenderServiceId: async () => undefined,
        },
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            n += 1;
            if (n === 1) return new Response(RESPUESTA_OK, { status: 201 });
            return new Response('{"message":"boom"}', { status: 500 });
          }) as typeof fetch,
        },
      }),
    );
    expect(r.publicados.map((p) => p.repo)).toEqual(['a']);
    expect(r.pendientes.join(' ')).toContain('b');
  });
});

/**
 * Varios slots con trabajo en el mismo repo.
 *
 * Pasa por dos caminos: el relevo —un slot se queda sin tokens y otro sigue— y
 * cowork, donde dos slots construyen el mismo proyecto a la vez. En los dos, el
 * trabajo esta repartido en ramas distintas y TODAS van a main: elegir una
 * seria tirar la otra.
 *
 * Ver `multicodigo-vm/docs/RETOMAR-relevo-agente.md`.
 */
describe('publicar con varios agentes', () => {
  it('mergea la rama de cada uno, en orden, y crea UN solo servicio', async () => {
    const mergeados: string[] = [];
    let servicios = 0;
    const r = await publicar(
      'p1',
      'propinas',
      ['c2', 'c1'],
      deps({
        mergear: async (req) => {
          mergeados.push(req.agent);
          return { ok: true, output: '' };
        },
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            servicios += 1;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
    );
    expect(mergeados).toEqual(['c2', 'c1']);
    expect(servicios).toBe(1);
    expect(r.publicados).toEqual([{ repo: 'propinas-back', url: 'https://x.onrender.com' }]);
  });

  // El worktree de un slot que no toco ESTE repo no tiene nada: es el caso del
  // relevo, donde el slot original quedo con el repo vacio. Mergear ahi no
  // aporta nada y el gateway ni tiene rama que resolver.
  it('el slot que no tiene nada en ese repo no se mergea', async () => {
    const mergeados: string[] = [];
    await publicar(
      'p1',
      'propinas',
      ['c2', 'c1'],
      deps({
        tienePackageJson: async (agent) => agent === 'c1',
        mergear: async (req) => {
          mergeados.push(req.agent);
          return { ok: true, output: '' };
        },
      }),
    );
    expect(mergeados).toEqual(['c1']);
  });

  it('si ninguno tiene nada en ese repo, se saltea sin ruido', async () => {
    const r = await publicar(
      'p1',
      'propinas',
      ['c2', 'c1'],
      deps({ tienePackageJson: async () => false }),
    );
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });

  // El segundo merge puede conflictuar con el primero si tocaron los mismos
  // archivos. Que main tenga UNA de las dos ramas no es un main vacio: hay
  // codigo real corriendo, asi que la URL vale y lo que falta se nombra.
  it('si un merge falla y otro anda, publica igual y nombra el que falto', async () => {
    const r = await publicar(
      'p1',
      'propinas',
      ['c2', 'c1'],
      deps({
        mergear: async (req) =>
          req.agent === 'c1'
            ? { ok: false, output: 'CONFLICT (content)' }
            : { ok: true, output: '' },
      }),
    );
    expect(r.publicados.map((p) => p.repo)).toEqual(['propinas-back']);
    const pend = r.pendientes.join(' ');
    expect(pend).toContain('c1');
    expect(pend).toContain('CONFLICT');
  });

  // Si NINGUNA rama entro, main quedo como estaba y una URL contra eso promete
  // algo que no esta. Es la misma regla que con un solo agente.
  it('si fallan todos los merges, NO se crea el servicio', async () => {
    let llamo = false;
    const r = await publicar(
      'p1',
      'propinas',
      ['c2', 'c1'],
      deps({
        mergear: async () => ({ ok: false, output: 'CONFLICT (content)' }),
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            llamo = true;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
    );
    expect(llamo).toBe(false);
    expect(r.publicados).toEqual([]);
    expect(r.pendientes.join(' ')).toContain('propinas-back');
  });

  // Sin ningun agente no hay worktree que mirar. Pasa con una corrida que cerro
  // completa sin ninguna tarea hecha, y el piso es no tocar nada.
  it('sin agentes no mergea ni publica nada', async () => {
    let mergeo = false;
    const r = await publicar(
      'p1',
      'propinas',
      [],
      deps({
        mergear: async () => {
          mergeo = true;
          return { ok: true, output: '' };
        },
      }),
    );
    expect(mergeo).toBe(false);
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });
});
