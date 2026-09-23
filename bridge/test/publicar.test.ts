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

/**
 * Un repo que YA tiene servicio: no se crea otro, pero se despliega.
 *
 * Antes se salteaba completo con un `continue`, y con `autoDeploy` en `yes` eso
 * estaba bien: Render se enteraba del push y desplegaba sola. Ahora el
 * autoDeploy va en `no` —con un repo publico Render no dispara nada— asi que
 * saltear significaria que el trabajo de la SEGUNDA corrida sobre un proyecto
 * nunca se publica. El servicio sigue ahi, con la version vieja, y nada lo dice.
 *
 * El merge ya paso: cada tarea mergea a main durante la corrida.
 */
describe('publicar en un repo que ya tiene servicio', () => {
  const CON_SERVICIO: RepoDelProyecto[] = [
    {
      nombre: 'propinas-back',
      github_repo: 'Sincro-arg/propinas-back',
      creado_por_el_bot: true,
      render_service_id: 'srv-viejo',
    },
  ];

  function conServicio(over: Partial<PublicarDeps> = {}): PublicarDeps {
    return deps({
      store: {
        reposDeProyecto: async () => CON_SERVICIO,
        guardarRenderServiceId: async () => undefined,
      },
      ...over,
    });
  }

  it('dispara el deploy del servicio que ya existe', async () => {
    const desplegados: string[] = [];
    await publicar('p1', 'propinas', ['c2'], {
      ...conServicio(),
      desplegar: async (id) => {
        desplegados.push(id);
        return { ok: true };
      },
    });
    expect(desplegados).toEqual(['srv-viejo']);
  });

  // Idempotencia: sigue sin crear un segundo servicio.
  it('no crea un segundo servicio', async () => {
    let llamo = false;
    await publicar('p1', 'propinas', ['c2'], {
      ...conServicio({
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            llamo = true;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
      desplegar: async () => ({ ok: true }),
    });
    expect(llamo).toBe(false);
  });

  // El trabajo esta en main y el servicio existe: lo peor que pasa es que la
  // version nueva tarde. Se nombra y se sigue.
  it('si el deploy no arranca, queda como pendiente', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], {
      ...conServicio(),
      desplegar: async () => ({ ok: false, motivo: 'rate limited' }),
    });
    expect(r.pendientes.join(' ')).toContain('rate limited');
    expect(r.pendientes.join(' ')).toContain('propinas-back');
  });

  // Sin la dependencia cableada el sistema se comporta como antes: no se
  // dispara nada y tampoco se inventa un pendiente.
  it('sin desplegar cableado, no pasa nada', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], conServicio());
    expect(r.publicados).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });
});

/**
 * Un repo que no se puede ARRANCAR no se publica.
 *
 * El caso, entero, de la corrida `publico2` del 2026-09-09: el trabajo estaba
 * completo en main —endpoints, tests, el server— el servicio se creo, y el
 * deploy murio en 27 segundos porque el `package.json` no tenia script `start`.
 * Render arranca con `npm start`; sin ese script no hay nada que correr.
 *
 * Nadie hizo nada mal: el plan pidio "script test", el agente lo hizo, y el
 * analista comparo contra un pliego que habla de endpoints y del puerto. Lo que
 * faltaba era que el sistema verificara el contrato que EL mismo impone al
 * desplegar.
 *
 * Un servicio que nace roto es peor que ninguno: ocupa el nombre, aparece en el
 * dashboard como si algo hubiera salido, y hay que ir a borrarlo.
 */
describe('publicar solo lo que puede arrancar', () => {
  it('sin script start no crea el servicio', async () => {
    let llamo = false;
    const r = await publicar('p1', 'propinas', ['c2'], {
      ...deps({
        render: {
          apiKey: 'k',
          ownerId: 'o',
          fetchImpl: (async () => {
            llamo = true;
            return new Response(RESPUESTA_OK, { status: 201 });
          }) as typeof fetch,
        },
      }),
      puedeArrancar: async () => false,
    });

    expect(llamo).toBe(false);
    expect(r.publicados).toEqual([]);
  });

  // Y lo DICE, con lo que hay que hacer. Es un cable suelto de verdad: el
  // trabajo esta hecho y le falta una linea para poder correr.
  it('lo explica en un pendiente, con el repo', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], {
      ...deps(),
      puedeArrancar: async () => false,
    });

    const pend = r.pendientes.join(' ');
    expect(pend).toContain('propinas-back');
    expect(pend).toContain('start');
  });

  it('con script start publica normalmente', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], {
      ...deps(),
      puedeArrancar: async () => true,
    });
    expect(r.publicados).toEqual([{ repo: 'propinas-back', url: 'https://x.onrender.com' }]);
  });

  // Sin la dependencia cableada se comporta como antes: un gateway viejo no
  // devuelve el dato, y eso no puede dejar de publicar todo.
  it('sin el dato, publica igual que antes', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], deps());
    expect(r.publicados).toEqual([{ repo: 'propinas-back', url: 'https://x.onrender.com' }]);
  });
});

/**
 * Conectar el front al back al terminar de publicar.
 *
 * Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-10-conectar-front-y-back-design.md`.
 */
describe('conectar el front con el back', () => {
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

  /** Render devuelve un id distinto por servicio, para poder distinguirlos. */
  function conDosRepos(over: Partial<PublicarDeps> = {}): PublicarDeps {
    let n = 0;
    return deps({
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
              service: {
                id: `srv-${n}`,
                serviceDetails: { url: `https://servicio-${n}.onrender.com` },
              },
            }),
            { status: 201 },
          );
        }) as typeof fetch,
      },
      ...over,
    });
  }

  it('le setea API_URL al front con la URL del back', async () => {
    const seteadas: Array<{ serviceId: string; clave: string; valor: string }> = [];
    const r = await publicar('p1', 'mesas', ['c2'], {
      ...conDosRepos(),
      setearEnvVar: async (serviceId, clave, valor) => {
        seteadas.push({ serviceId, clave, valor });
        return { ok: true };
      },
    });

    // El back tambien recibe su Jwt__Key -- ver el describe de mas abajo --
    // asi que se filtra por clave en vez de contar todas las llamadas.
    const apiUrl = seteadas.filter((s) => s.clave === 'API_URL');
    expect(apiUrl).toHaveLength(1);
    // El front es srv-1 (se publica primero) y el back srv-2.
    expect(apiUrl[0]!.serviceId).toBe('srv-1');
    expect(apiUrl[0]!.valor).toBe('https://servicio-2.onrender.com');
    expect(r.publicados).toHaveLength(2);
  });

  // Render no aplica los cambios de variables solo: hay que desplegar.
  it('despliega el front despues de setear la variable', async () => {
    const desplegados: string[] = [];
    await publicar('p1', 'mesas', ['c2'], {
      ...conDosRepos(),
      setearEnvVar: async () => ({ ok: true }),
      desplegar: async (id) => {
        desplegados.push(id);
        return { ok: true };
      },
    });

    expect(desplegados).toContain('srv-1');
  });

  it('si no se pudo setear, queda como pendiente', async () => {
    const r = await publicar('p1', 'mesas', ['c2'], {
      ...conDosRepos(),
      setearEnvVar: async () => ({ ok: false, motivo: 'no pude leer las que ya tenia' }),
    });

    const pend = r.pendientes.join(' ');
    expect(pend).toContain('mesas-front');
    expect(pend).toContain('no pude leer');
  });

  // Un proyecto de un solo servicio no tiene a quien conectarse -- pero el
  // back igual recibe su Jwt__Key, que no depende de que haya front.
  it('un proyecto sin front no intenta conectar API_URL', async () => {
    const claves: string[] = [];
    await publicar('p1', 'propinas', ['c2'], {
      ...deps(),
      setearEnvVar: async (_id, clave) => {
        claves.push(clave);
        return { ok: true };
      },
    });
    expect(claves).not.toContain('API_URL');
    expect(claves).toContain('Jwt__Key');
  });

  it('sin la dependencia cableada, publica igual que antes', async () => {
    const r = await publicar('p1', 'mesas', ['c2'], conDosRepos());
    expect(r.publicados).toHaveLength(2);
  });

  // El bug real: `taller` y `veterinaria` quedaron con el mismo pendiente
  // repetido en casi todas sus rondas -- "cargar Jwt__Key en Render, sin ella
  // el proceso arranca y muere" -- porque nada lo generaba solo. No es una
  // decision de producto, asi que el sistema la genera y la carga.
  it('le genera Jwt__Key a un back .NET sin que nadie la pida', async () => {
    const claves: Array<{ serviceId: string; clave: string; valor: string }> = [];
    await publicar('p1', 'propinas', ['c2'], {
      ...deps(),
      setearEnvVar: async (serviceId, clave, valor) => {
        claves.push({ serviceId, clave, valor });
        return { ok: true };
      },
    });

    const jwt = claves.find((c) => c.clave === 'Jwt__Key');
    expect(jwt).toBeDefined();
    expect(jwt!.serviceId).toBe('srv-1');
    // Larga y al azar: no importa el valor exacto, importa que no sea vacia
    // ni un placeholder previsible.
    expect(jwt!.valor.length).toBeGreaterThanOrEqual(32);
  });

  it('si no se pudo generar Jwt__Key, queda como pendiente con el nombre del repo', async () => {
    const r = await publicar('p1', 'propinas', ['c2'], {
      ...deps(),
      setearEnvVar: async () => ({ ok: false, motivo: 'Render dijo que no' }),
    });

    const pend = r.pendientes.join(' ');
    expect(pend).toContain('propinas-back');
    expect(pend).toContain('Jwt__Key');
    expect(pend).toContain('Render dijo que no');
  });
});
