import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../src/store.js';
import { claveDe, descifrar } from '../src/cifrado.js';
import {
  apagarEnVps,
  borrarDelVps,
  estadoDeCoolify,
  estadoEnVps,
  nombreDeVps,
  publicarEnVps,
  revisarDemos,
  type VpsDeps,
} from '../src/vps.js';
import { publicar } from '../src/publicar.js';

/**
 * Punchi publica en el VPS (Coolify). Ver
 * `docs/superpowers/specs/2026-10-09-punchi-hosting-vps-design.md`.
 *
 * Coolify es un fetch falso que anota cada pedido: lo que importa aca es QUE se
 * le pide (crear, desplegar, apagar, borrar) y sobre QUE uuid.
 */

const TOKEN = 'token-de-coolify-secreto-123';

function coolifyFalso(opciones: { apps?: { uuid: string; name: string; fqdn: string; status: string }[] } = {}) {
  const pedidos: { metodo: string; ruta: string; cuerpo?: any }[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const ruta = url.replace('http://coolify:8000/api/v1', '');
    const metodo = init.method ?? 'GET';
    const cuerpo = init.body ? JSON.parse(String(init.body)) : undefined;
    pedidos.push({ metodo, ruta, ...(cuerpo !== undefined ? { cuerpo } : {}) });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (metodo === 'GET' && ruta === '/applications') return json(opciones.apps ?? []);
    if (metodo === 'POST' && ruta === '/projects') return json({ uuid: `proy${++n}` }, 201);
    if (metodo === 'POST' && ruta === '/databases/postgresql') return json({ uuid: `base${++n}` }, 201);
    if (metodo === 'POST' && ruta === '/applications/private-github-app') return json({ uuid: `app${++n}` }, 201);
    if (metodo === 'PATCH') return json({});
    if (metodo === 'GET' && /\/envs$/.test(ruta)) return json([{ key: 'Jwt__Key', is_preview: false }]);
    if (metodo === 'POST' && ruta.startsWith('/deploy')) return json({ deployments: [{ deployment_uuid: `dep${++n}` }] });
    if (metodo === 'GET' && ruta.startsWith('/deployments/')) return json({ status: 'finished' });
    if (metodo === 'GET' && /^\/(applications|databases)\/[^/]+$/.test(ruta)) return json({ status: 'running:healthy' });
    if (metodo === 'POST' && /\/(start|stop)$/.test(ruta)) return json({ message: 'ok' });
    if (metodo === 'DELETE') return json({ message: 'ok' });
    return json({ message: 'no esperado' }, 500);
  }) as unknown as typeof fetch;
  return { f, pedidos };
}

const clave = claveDe('clave-de-prueba-larga-1234567890');

async function armar(opciones: Parameters<typeof coolifyFalso>[0] & { libreMb?: number } = {}) {
  const store = new InMemoryStore();
  await store.vincularRepo('p1', 'turnos-back', 'Sincro-arg/turnos-back', false, true);
  await store.vincularRepo('p1', 'turnos-front', 'Sincro-arg/turnos-front', false, true);
  const c = coolifyFalso(opciones);
  const escritos: string[] = [];
  const deps: VpsDeps = {
    config: {
      coolify: { url: 'http://coolify:8000', token: TOKEN, servidor: 'srv', fetchImpl: c.f },
      githubApps: { 'sincro-arg': 'gh-app' },
      clave,
    },
    store,
    uso: async () => ({ memTotalMb: 7751, memDisponibleMb: opciones.libreMb ?? 6000, discoTotalGb: 72, discoLibreGb: 50 }),
    asegurarDockerfileBack: async () => ({ estado: 'ya_estaba' }),
    asegurarDockerfileFront: async () => ({ estado: 'escrito' }),
    reescribirConfig: async (repo, url) => {
      escritos.push(`${repo} -> ${url}`);
      return { estado: 'cambiado' };
    },
  };
  return { store, deps, pedidos: c.pedidos, escritos };
}

describe('nombres', () => {
  it('limpia el nombre para el dominio', () => {
    expect(nombreDeVps('Hotelería Del Sol')).toBe('hoteleria-del-sol');
    expect(nombreDeVps('--AH__2--')).toBe('ah-2');
  });

  it('no deja usar un nombre reservado', async () => {
    const { store, deps, pedidos } = await armar();
    const r = await publicarEnVps('p1', 'SincroResto', await store.reposDeProyecto('p1'), deps);
    expect(r.pendientes[0]).toMatch(/no se puede usar/);
    expect(pedidos.filter((p) => p.metodo !== 'GET')).toEqual([]);
  });

  it('traduce los estados de Coolify', () => {
    expect(estadoDeCoolify('running:healthy')).toBe('andando');
    expect(estadoDeCoolify('exited:unhealthy')).toBe('apagado');
    expect(estadoDeCoolify('restarting')).toBe('construyendo');
  });
});

describe('publicar en el VPS', () => {
  it('crea proyecto, base, back y front, conectados, y devuelve los links', async () => {
    const { store, deps, pedidos, escritos } = await armar();
    const r = await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);

    expect(r.pendientes).toEqual([]);
    expect(r.publicados).toEqual([
      { repo: 'turnos-back', url: 'https://turnos-api.apps.punchi.dev' },
      { repo: 'turnos-front', url: 'https://turnos.apps.punchi.dev' },
    ]);

    const base = pedidos.find((p) => p.ruta === '/databases/postgresql')!;
    expect(base.cuerpo.is_public).toBe(false);
    const apps = pedidos.filter((p) => p.ruta === '/applications/private-github-app');
    expect(apps.map((a) => [a.cuerpo.git_repository, a.cuerpo.domains, a.cuerpo.ports_exposes])).toEqual([
      ['Sincro-arg/turnos-back', 'https://turnos-api.apps.punchi.dev', '8080'],
      ['Sincro-arg/turnos-front', 'https://turnos.apps.punchi.dev', '80'],
    ]);
    expect(apps.every((a) => a.cuerpo.github_app_uuid === 'gh-app' && a.cuerpo.instant_deploy === false)).toBe(true);

    // El back recibe la base y el CORS del front, sin pisar la Jwt__Key que ya tenia.
    const vars = pedidos.find((p) => p.ruta.endsWith('/envs/bulk'))!.cuerpo.data.map((d: any) => d.key);
    expect(vars).toEqual(expect.arrayContaining(['ConnectionStrings__DefaultConnection', 'DATABASE_URL', 'Cors__AllowedOrigins__0']));
    expect(vars).not.toContain('Jwt__Key');

    // El front apunta al back antes de construirse.
    expect(escritos).toEqual(['Sincro-arg/turnos-front -> https://turnos-api.apps.punchi.dev']);
    expect(pedidos.filter((p) => p.ruta.startsWith('/deploy')).length).toBe(2);

    // La conexion queda guardada CIFRADA, y el repo con su link.
    const filas = await store.recursosVps('p1');
    const fBase = filas.find((x) => x.parte === 'base')!;
    expect(fBase.secreto).not.toMatch(/Password/);
    expect(JSON.parse(descifrar(fBase.secreto!, clave)).conexion).toMatch(/^Host=base\d+;Port=5432;Database=app;Username=app;Password=/);
    const repos = await store.reposDeProyecto('p1');
    expect(repos.find((x) => x.nombre === 'turnos-front')?.destino_url).toBe('https://turnos.apps.punchi.dev');
  });

  it('la segunda vez no crea nada: solo despliega', async () => {
    const { store, deps, pedidos } = await armar();
    await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    pedidos.length = 0;
    const r = await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    expect(r.pendientes).toEqual([]);
    expect(pedidos.filter((p) => p.metodo === 'POST' && !p.ruta.startsWith('/deploy'))).toEqual([]);
    expect(pedidos.filter((p) => p.ruta.startsWith('/deploy')).length).toBe(2);
  });

  it('con el VPS lleno no crea nada', async () => {
    const { store, deps, pedidos } = await armar({ libreMb: 600 });
    const r = await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    expect(r.pendientes[0]).toMatch(/VPS está lleno/);
    expect(pedidos.filter((p) => p.metodo !== 'GET')).toEqual([]);
  });

  it('volver a desplegar lo que ya anda no pasa por el freno', async () => {
    const a = await armar();
    await publicarEnVps('p1', 'turnos', await a.store.reposDeProyecto('p1'), a.deps);
    const lleno: VpsDeps = { ...a.deps, uso: async () => ({ memTotalMb: 7751, memDisponibleMb: 300, discoTotalGb: 72, discoLibreGb: 50 }) };
    const r = await publicarEnVps('p1', 'turnos', await a.store.reposDeProyecto('p1'), lleno);
    expect(r.pendientes).toEqual([]);
  });

  it('no pisa un dominio que usa otra app del VPS', async () => {
    const { store, deps } = await armar({
      apps: [{ uuid: 'ajena', name: 'otra', fqdn: 'https://turnos.apps.punchi.dev', status: 'running:healthy' }],
    });
    const r = await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    expect(r.pendientes.join()).toMatch(/turnos\.apps\.punchi\.dev ya lo usa otra app/);
    expect(r.publicados.map((p) => p.repo)).toEqual(['turnos-back']);
  });

  it('espera los armados y nombra el que fallo', async () => {
    const a = await armar();
    const base = a.deps.config.coolify.fetchImpl!;
    a.deps.config.coolify.fetchImpl = (async (url: string, init?: RequestInit) =>
      String(url).includes('/deployments/')
        ? new Response(JSON.stringify({ status: 'failed', logs: JSON.stringify([{ output: 'npm ERR! build' }]) }))
        : base(url, init)) as unknown as typeof fetch;
    const r = await publicarEnVps('p1', 'turnos', await a.store.reposDeProyecto('p1'), {
      ...a.deps,
      esperarMs: 60_000,
      dormir: async () => undefined,
    });
    expect(r.pendientes.join()).toMatch(/armado de turnos-back falló en el VPS \(npm ERR! build\)/);
    expect((await a.store.recursosVps('p1')).find((x) => x.parte === 'back')?.estado).toBe('fallo');
  });

  it('nunca deja el token en un motivo', async () => {
    const a = await armar();
    a.deps.config.coolify.fetchImpl = (async () =>
      new Response(JSON.stringify({ message: `token ${TOKEN} invalido` }), { status: 401 })) as unknown as typeof fetch;
    const r = await publicarEnVps('p1', 'turnos', await a.store.reposDeProyecto('p1'), a.deps);
    expect(r.pendientes.join()).not.toContain(TOKEN);
    expect(r.pendientes.join()).toContain('***');
  });
});

describe('el cierre de una corrida', () => {
  it('manda al VPS los repos sin app elegida, despues del merge', async () => {
    const { store, deps } = await armar();
    const r = await publicar('p1', 'turnos', ['c1'], {
      store,
      render: {},
      mergear: async () => ({ ok: true, output: '' }),
      tienePackageJson: async () => true,
      enVps: (repos) => publicarEnVps('p1', 'turnos', repos, deps),
    });
    expect(r.publicados.map((p) => p.url)).toEqual(['https://turnos-api.apps.punchi.dev', 'https://turnos.apps.punchi.dev']);
  });

  it('un repo con servicio de Render de antes sigue en Render', async () => {
    const { store, deps } = await armar();
    await store.guardarRenderServiceId('p1', 'turnos-back', 'srv-1', 'https://x.onrender.com');
    const aVps: string[] = [];
    await publicar('p1', 'turnos', ['c1'], {
      store,
      render: {},
      mergear: async () => ({ ok: true, output: '' }),
      tienePackageJson: async () => true,
      desplegar: async () => ({ ok: true }),
      enVps: async (repos) => {
        aVps.push(...repos.map((x) => x.nombre));
        return publicarEnVps('p1', 'turnos', repos, deps);
      },
    });
    expect(aVps).toEqual(['turnos-front']);
  });
});

describe('apagar y borrar', () => {
  it('apagar frena todo, del front a la base', async () => {
    const { store, deps, pedidos } = await armar();
    await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    pedidos.length = 0;
    const r = await apagarEnVps('p1', deps);
    expect(r.ok).toBe(true);
    expect(pedidos.map((p) => p.ruta.replace(/\/[a-z]+\d+\//, '/X/'))).toEqual([
      '/applications/X/stop',
      '/applications/X/stop',
      '/databases/X/stop',
    ]);
    expect((await store.recursosVps('p1')).filter((x) => x.parte !== 'proyecto').every((x) => x.estado === 'apagado')).toBe(true);
  });

  it('borrar pide el nombre escrito, tambien del lado del server', async () => {
    const { store, deps, pedidos } = await armar();
    await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    pedidos.length = 0;
    expect((await borrarDelVps('p1', 'turnos', 'turno', deps)).ok).toBe(false);
    expect(pedidos).toEqual([]);

    const r = await borrarDelVps('p1', 'turnos', 'turnos', deps);
    expect(r.ok).toBe(true);
    expect(pedidos.filter((p) => p.metodo === 'DELETE').length).toBe(4);
    expect(pedidos.find((p) => p.ruta.startsWith('/databases/'))!.ruta).toContain('delete_volumes=true');
    expect(await store.recursosVps('p1')).toEqual([]);
    // El repo sigue yendo al VPS, sin vinculo: el proximo Publicar arranca de cero.
    const front = (await store.reposDeProyecto('p1')).find((x) => x.nombre === 'turnos-front')!;
    expect([front.destino, front.destino_url]).toEqual(['vps', null]);
  });

  it('solo actua sobre lo que creo Punchi: lo demas del VPS se ve y no se toca', async () => {
    const { store, deps, pedidos } = await armar({
      apps: [{ uuid: 'sincro', name: 'sincroresto-front', fqdn: 'https://sincroresto.com', status: 'running:healthy' }],
    });
    await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    const e = await estadoEnVps('p1', deps);
    expect(e.otros).toEqual([{ nombre: 'sincroresto-front', url: 'https://sincroresto.com', estado: 'andando' }]);
    pedidos.length = 0;
    await apagarEnVps('p1', deps);
    await borrarDelVps('p1', 'turnos', 'turnos', deps);
    expect(pedidos.some((p) => p.ruta.includes('sincro'))).toBe(false);
  });
});

describe('demos de Homero', () => {
  it('avisa el dia antes una sola vez, apaga al vencer y nunca borra', async () => {
    const { store, deps, pedidos } = await armar();
    await publicarEnVps('p1', 'turnos', await store.reposDeProyecto('p1'), deps);
    for (const r of await store.recursosVps('p1')) await store.estadoRecursoVps(r.coolify_uuid, 'andando', null);
    const avisos: string[] = [];
    const ahora = Date.now();
    await store.guardarDemoApagarEl('p1', new Date(ahora + 10 * 3_600_000));
    const correr = (t: number) =>
      revisarDemos({ ...deps, demos: store, avisar: async (a) => void avisos.push(a.texto), ahora: () => t });

    await correr(ahora);
    await correr(ahora);
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toMatch(/Mañana apago la demo/);

    pedidos.length = 0;
    await store.guardarDemoApagarEl('p1', new Date(ahora - 1000));
    await correr(ahora);
    expect(avisos[1]).toMatch(/Apagué la demo/);
    expect(pedidos.some((p) => p.metodo === 'DELETE')).toBe(false);
    expect(await store.demosPorVencer(24)).toEqual([]);
  });
});
