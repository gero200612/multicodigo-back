import { describe, expect, it } from 'vitest';
import { cifrar, claveDe, descifrar } from '../src/cifrado.js';
import { desplegar, nombreDeServicio, verificar, vincular } from '../src/proveedores.js';
import { desplegarRepo, publicarCambios, textoDePublicacion } from '../src/publicar-ticket.js';
import { InMemoryStore, type RepoDelProyecto } from '../src/store.js';

const U = '22222222-2222-4222-8222-222222222222';
const P = '11111111-1111-4111-8111-111111111111';
const CLAVE = claveDe('secreto-de-prueba-largo');

/** Un fetch falso: contesta según la URL y anota lo pedido. */
function falso(respuestas: [RegExp, number, unknown][]) {
  const pedidos: { url: string; metodo: string; cuerpo: any; auth: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    pedidos.push({
      url,
      metodo: init?.method ?? 'GET',
      cuerpo: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers['authorization'] ?? '',
    });
    const r = respuestas.find(([re]) => re.test(url));
    const [, status, json] = r ?? [/./, 404, { message: 'no' }];
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { f, pedidos };
}

describe('cifrado de los tokens', () => {
  it('ida y vuelta, y un valor tocado no descifra', () => {
    const c = cifrar('tok_123', CLAVE);
    expect(c).not.toContain('tok_123');
    expect(descifrar(c, CLAVE)).toBe('tok_123');
    const roto = c.slice(0, -2) + (c.endsWith('A') ? 'B' : 'A') + c.slice(-1);
    expect(() => descifrar(roto, CLAVE)).toThrow();
    expect(() => descifrar(c, claveDe('otra'))).toThrow();
  });
});

describe('proveedores', () => {
  it('nombres de servicio válidos para los cuatro', () => {
    expect(nombreDeServicio('Mi Front_V2')).toBe('mi-front-v2');
  });

  it('Render: verificar trae el owner', async () => {
    const { f } = falso([[/owners/, 200, [{ owner: { id: 'own-1', name: 'Gero' } }]]]);
    expect(await verificar('render', 'rnd_x', {}, f)).toEqual({ ok: true, cuenta: 'Gero', extra: { ownerId: 'own-1' } });
  });

  it('un token malo no pasa, y el motivo no lo repite', async () => {
    const { f } = falso([[/user/, 401, { error: { message: 'token rnd_secreto inválido' } }]]);
    const r = await verificar('vercel', 'rnd_secreto', {}, f);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('rnd_secreto');
  });

  it('Netlify exige el número de instalación de GitHub', async () => {
    const { f } = falso([[/user/, 200, { full_name: 'Gero' }]]);
    expect((await verificar('netlify', 'nf_x', {}, f)).ok).toBe(false);
    expect(await verificar('netlify', 'nf_x', { installationId: '123' }, f)).toEqual({
      ok: true,
      cuenta: 'Gero',
      extra: { installationId: '123' },
    });
  });

  it('Vercel: vincular crea el proyecto atado al repo y pide el primer deploy', async () => {
    const { f, pedidos } = falso([
      [/v11\/projects/, 200, { id: 'prj_1', name: 'vete-front' }],
      [/v13\/deployments/, 200, { id: 'dpl_1' }],
    ]);
    const r = await vincular({ proveedor: 'vercel', token: 'vc', extra: { teamId: 'team_9' } }, { nombre: 'vete-front', github_repo: 'acme/vete-front' }, f);
    expect(r).toEqual({ ok: true, id: 'prj_1|vete-front', url: 'https://vete-front.vercel.app' });
    expect(pedidos[0]!.url).toContain('teamId=team_9');
    expect(pedidos[0]!.cuerpo.gitRepository).toEqual({ type: 'github', repo: 'acme/vete-front' });
    expect(pedidos[1]!.cuerpo.gitSource).toMatchObject({ org: 'acme', repo: 'vete-front', ref: 'main' });
  });

  it('Railway: crea proyecto, servicio desde el repo y dominio', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      const data =
        n === 1
          ? { projectCreate: { id: 'p1', environments: { edges: [{ node: { id: 'e1' } }] } } }
          : n === 2
            ? { serviceCreate: { id: 's1' } }
            : { serviceDomainCreate: { domain: 'vete.up.railway.app' } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await vincular({ proveedor: 'railway', token: 'rw', extra: {} }, { nombre: 'vete', github_repo: 'acme/vete' }, f);
    expect(r).toEqual({ ok: true, id: 's1|e1', url: 'https://vete.up.railway.app' });
  });

  it('Netlify: desplegar pide un build del sitio', async () => {
    const { f, pedidos } = falso([[/sites\/site-1\/builds/, 200, {}]]);
    expect(await desplegar({ proveedor: 'netlify', token: 'nf', extra: {} }, 'site-1', { nombre: 'x', github_repo: 'a/x' }, f)).toEqual({ ok: true });
    expect(pedidos[0]!.metodo).toBe('POST');
  });
});

describe('publicar un ticket', () => {
  const repo = (over: Partial<RepoDelProyecto>): RepoDelProyecto => ({
    nombre: 'front',
    github_repo: 'acme/front',
    creado_por_el_bot: true,
    render_service_id: null,
    render_url: null,
    ...over,
  });

  function armar(repos: RepoDelProyecto[]) {
    const store = new InMemoryStore();
    (store as unknown as { reposPorProyecto: Map<string, RepoDelProyecto[]> }).reposPorProyecto.set(P, repos);
    const merges: { repo: string; autorizadoPorPersona: boolean }[] = [];
    const mergear = async (req: { repo: string; autorizadoPorPersona: boolean }) => {
      merges.push({ repo: req.repo, autorizadoPorPersona: req.autorizadoPorPersona });
      return { ok: true, output: 'Fast-forward' };
    };
    return { store, merges, mergear };
  }

  it('solo, no toca los repos de la persona; con Publicar, sí', async () => {
    const { store, merges, mergear } = armar([repo({ nombre: 'mio', creado_por_el_bot: false })]);
    const solo = await publicarCambios({ usuarioId: U, proyectoId: P, proyecto: 'x', agente: 'c2', explicito: false }, { store, clave: CLAVE, mergear });
    expect(merges).toEqual([]);
    expect(solo.pendientes[0]).toContain('Publicar');
    await publicarCambios({ usuarioId: U, proyectoId: P, proyecto: 'x', agente: 'c2', explicito: true }, { store, clave: CLAVE, mergear });
    expect(merges).toEqual([{ repo: 'mio', autorizadoPorPersona: true }]);
  });

  // Publicar solo pasa ramas a main: desplegar es aparte, desde Repositorios.
  it('publicar dice qué pasó a main y no despliega nada', async () => {
    const { store, mergear } = armar([repo({ destino: 'vercel', destino_id: 'prj_1|front' }), repo({ nombre: 'back' })]);
    await store.guardarConexionDeDespliegue(U, { proveedor: 'vercel', tokenCifrado: cifrar('vc', CLAVE), extra: {}, cuenta: 'g' });
    const { f, pedidos } = falso([]);
    const r = await publicarCambios({ usuarioId: U, proyectoId: P, proyecto: 'x', agente: 'c2', explicito: true }, { store, clave: CLAVE, mergear, fetchImpl: f });
    expect(pedidos).toEqual([]);
    expect(r.mergeados).toEqual(['front', 'back']);
    expect(r.publicados).toEqual([]);
    expect(textoDePublicacion(r)).toBe('Pasaron a main:\n- front\n- back\n\nPara desplegar, andá a Repositorios.');
  });

  it('desplegar sin la cuenta conectada, lo dice', async () => {
    const { store } = armar([repo({ destino: 'vercel' })]);
    const r = await desplegarRepo(U, P, 'front', { store, clave: CLAVE });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toContain('Conexiones');
  });

  it('desplegar con la cuenta vincula la primera vez y guarda el vínculo', async () => {
    const { store } = armar([repo({ destino: 'vercel' })]);
    await store.guardarConexionDeDespliegue(U, { proveedor: 'vercel', tokenCifrado: cifrar('vc', CLAVE), extra: {}, cuenta: 'g' });
    const { f } = falso([
      [/v11\/projects/, 200, { id: 'prj_1', name: 'front' }],
      [/v13\/deployments/, 200, {}],
    ]);
    const r = await desplegarRepo(U, P, 'front', { store, clave: CLAVE, fetchImpl: f });
    expect(r).toEqual({ ok: true, url: 'https://front.vercel.app', app: 'Vercel' });
    expect((await store.reposDeProyecto(P))[0]!.destino_id).toBe('prj_1|front');
  });

  it('desplegar sin app elegida, pide elegirla; un repo que no es del proyecto, no', async () => {
    const { store } = armar([repo({})]);
    const r = await desplegarRepo(U, P, 'front', { store, clave: CLAVE });
    expect(!r.ok && r.motivo).toContain('elegí');
    expect(await desplegarRepo(U, P, 'otro', { store, clave: CLAVE })).toEqual({ ok: false, motivo: 'ese repo no está en el proyecto' });
  });
});
