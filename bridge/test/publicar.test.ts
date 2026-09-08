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
    const r = await publicar('p1', 'propinas', 'c2', deps());
    expect(r.publicados).toEqual([{ repo: 'propinas-back', url: 'https://x.onrender.com' }]);
  });

  // Un repo de una persona no se toca, y tampoco genera pendiente: no es un
  // cable suelto, es algo que no le corresponde a este sistema.
  it('un repo que no creo el bot no se toca ni genera pendiente', async () => {
    let mergeo = false;
    const r = await publicar(
      'p1',
      'propinas',
      'c2',
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
      'c2',
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
    const r = await publicar('p1', 'propinas', 'c2', deps({ tienePackageJson: async () => false }));
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });

  // Una URL que responde contra un main vacio es peor que ninguna URL.
  it('si el merge falla, NO se crea el servicio y queda como pendiente', async () => {
    let llamo = false;
    const r = await publicar(
      'p1',
      'propinas',
      'c2',
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
    const r = await publicar('p1', 'propinas', 'c2', deps({ render: {} }));
    expect(r.publicados).toEqual([]);
    expect(r.pendientes.join(' ')).toContain('a mano');
  });

  it('el fallo de un repo no cancela al otro', async () => {
    const r = await publicar(
      'p1',
      'propinas',
      'c2',
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
      'c2',
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
    const r = await publicar('p1', 'propinas', 'c2', deps());
    const env = r.pendientes.find((p) => p.includes('env vars'));
    expect(env).toContain('propinas-back');
    expect(env).toContain('https://x.onrender.com');
  });

  // Sin esto, la primera perdida de datos manda a buscar un bug que no existe.
  it('avisa del disco efimero si el repo usa sqlite', async () => {
    const r = await publicar('p1', 'propinas', 'c2', deps({ usaSqlite: async () => true }));
    expect(r.pendientes.join(' ')).toContain('SQLite');
  });

  it('no avisa del disco si el repo no usa sqlite', async () => {
    const r = await publicar('p1', 'propinas', 'c2', deps({ usaSqlite: async () => false }));
    expect(r.pendientes.join(' ')).not.toContain('SQLite');
  });

  // Si Render se cae a mitad del bucle, el informe tiene que decir exactamente
  // que quedo publicado y que no.
  it('con Render caido a mitad, nombra el que salio y el que no', async () => {
    let n = 0;
    const r = await publicar(
      'p1',
      'propinas',
      'c2',
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
