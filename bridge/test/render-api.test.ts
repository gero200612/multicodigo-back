import { describe, it, expect } from 'vitest';
import { crearServicio, dispararDeploy, setearEnvVar } from '../src/render-api.js';

const OK = {
  apiKey: 'rnd_clave',
  ownerId: 'tea-123',
};

describe('crearServicio', () => {
  it('crea un web service de Node en main y devuelve la URL', async () => {
    let visto: any = null;
    const r = await crearServicio('propinas-back', 'Sincro-arg/propinas-back', {
      ...OK,
      fetchImpl: (async (_url: string, init: any) => {
        visto = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ service: { id: 'srv-abc', serviceDetails: { url: 'https://propinas-back.onrender.com' } } }),
          { status: 201 },
        );
      }) as any,
    });

    expect(r).toEqual({ estado: 'creado', serviceId: 'srv-abc', url: 'https://propinas-back.onrender.com' });
    expect(visto.repo).toBe('https://github.com/Sincro-arg/propinas-back');
    expect(visto.branch).toBe('main');
    // `no`: el deploy lo dispara el bridge al mergear. Antes iba en `yes`,
    // cuando la feature asumia un proveedor de Git conectado; con repos
    // publicos Render no dispara nada. Ver `dispararDeploy` mas abajo.
    expect(visto.autoDeploy).toBe('no');
    expect(visto.serviceDetails.env).toBe('node');
    expect(visto.serviceDetails.envSpecificDetails.buildCommand).toBe('npm install');
    expect(visto.serviceDetails.envSpecificDetails.startCommand).toBe('npm start');
    expect(visto.serviceDetails.plan).toBe('free');
    expect(visto.serviceDetails.region).toBe('oregon');
  });

  // Un servidor sin configurar sigue andando, solo que sin esta parte.
  it('sin apiKey devuelve sin_render en vez de explotar', async () => {
    const r = await crearServicio('x', 'org/x', { fetchImpl: (async () => { throw new Error('no'); }) as any });
    expect(r).toEqual({ estado: 'sin_render' });
  });

  it('un error de la API vuelve como error con el motivo, no como excepcion', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => new Response('{"message":"name already exists"}', { status: 400 })) as any,
    });
    expect(r.estado).toBe('error');
    expect((r as any).motivo).toContain('name already exists');
  });

  it('una respuesta sin URL vuelve como error y no como creado a medias', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => new Response(JSON.stringify({ service: { id: 'srv-1' } }), { status: 201 })) as any,
    });
    expect(r.estado).toBe('error');
  });

  // La clave no puede aparecer en ningun mensaje que despues va a un chat.
  it('la clave no aparece en el motivo del error', async () => {
    const r = await crearServicio('x', 'org/x', {
      ...OK,
      fetchImpl: (async () => { throw new Error('conexion fallo con rnd_clave'); }) as any,
    });
    expect(r.estado).toBe('error');
    expect((r as any).motivo).not.toContain('rnd_clave');
  });
});

/**
 * El 400 de "unfetchable", traducido a lo que hay que hacer.
 *
 * Render contesta un JSON con el motivo y DESPUES la lista de formatos de URL
 * que acepta, que es larga y ocupa casi todo el mensaje. Eso llegaba crudo al
 * informe de la mañana y se leia como un problema de formato — cuando el
 * formato que mandamos es justo el primero de esa lista.
 *
 * Lo verificado el 2026-09-09, por los dos caminos: la app de Render esta
 * instalada en la org Y tiene acceso al repo, pero el WORKSPACE de Render no ve
 * ningun repositorio ("No repositories found" en su propio dashboard). Falta el
 * vinculo instalacion -> workspace, que solo se crea desde Render y necesita un
 * click de una persona.
 *
 * Un pendiente que dice que hacer vale mil veces mas que el error textual.
 */
describe('el error de repo no conectado', () => {
  const RECHAZO = JSON.stringify({
    message:
      'passed in repository URL is invalid or unfetchable: ' +
      'https://github.com/Sincro-arg/saludos5-back. Accepted formats are: ' +
      'https://github.com/{namespace}/{repository}, https://gitlab.com/{namespace}/{repository}, ' +
      'https://bitbucket.org/{namespace}/{repository}, or ' +
      'https://cursor.com/codebase/{namespace}/{repository}. ' +
      'You may pass in a branch in the branch field.',
  });

  it('dice que falta conectar el repo, y donde', async () => {
    const r = await crearServicio('saludos5-back', 'Sincro-arg/saludos5-back', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () => new Response(RECHAZO, { status: 400 })) as typeof fetch,
    });

    if (r.estado !== 'error') throw new Error(`no es error: ${r.estado}`);
    expect(r.motivo).toContain('dashboard.render.com');
    // Y no la lista de formatos, que es lo que tapaba el mensaje.
    expect(r.motivo).not.toContain('bitbucket.org');
  });

  // Cualquier otro 400 sigue llegando textual: traducir solo lo que se entiende
  // es mejor que inventar una explicacion para un error que no se conoce.
  it('otro error de Render llega tal cual', async () => {
    const r = await crearServicio('x', 'org/x', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'name already exists' }), {
          status: 400,
        })) as typeof fetch,
    });

    if (r.estado !== 'error') throw new Error(`no es error: ${r.estado}`);
    expect(r.motivo).toContain('name already exists');
  });
});

/**
 * El deploy lo dispara el sistema, no el push.
 *
 * Render solo hace auto-deploy con un proveedor de Git conectado: "Auto-deploys
 * require a connected Git provider. Services that use a prebuilt Docker image or
 * a public Git repository URL must be deployed manually". Y este camino existe
 * justamente porque ese proveedor NO se puede conectar sin un click.
 *
 * Asi que `autoDeploy` va en `no` explicito —aunque Render lo devuelva en `yes`
 * al crear, que es lo que hizo en la prueba— y el deploy lo pide el bridge
 * cuando mergea a main. Es el momento exacto en que hay algo nuevo, y no
 * depende de que un webhook llegue.
 */
describe('el deploy se dispara a mano', () => {
  it('el servicio se crea con autoDeploy en no', async () => {
    let cuerpo = '';
    await crearServicio('x-back', 'org/x-back', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async (_u: string, init: RequestInit) => {
        cuerpo = String(init.body);
        return new Response(
          JSON.stringify({
            service: { id: 'srv-1', serviceDetails: { url: 'https://x.onrender.com' } },
          }),
          { status: 201 },
        );
      }) as unknown as typeof fetch,
    });

    expect(JSON.parse(cuerpo).autoDeploy).toBe('no');
  });

  it('dispararDeploy le pide a Render un deploy del servicio', async () => {
    let url = '';
    let metodo = '';
    const r = await dispararDeploy('srv-1', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async (u: string, init: RequestInit) => {
        url = u;
        metodo = String(init.method);
        return new Response(JSON.stringify({ id: 'dep-1' }), { status: 201 });
      }) as unknown as typeof fetch,
    });

    expect(url).toContain('/services/srv-1/deploys');
    expect(metodo).toBe('POST');
    expect(r.ok).toBe(true);
  });

  // Que el deploy no salga NO puede tirar el cierre de la corrida: el codigo ya
  // esta en main y el servicio existe. Se reporta y sigue.
  it('un fallo al disparar se devuelve, no explota', async () => {
    const r = await dispararDeploy('srv-1', {
      apiKey: 'k',
      ownerId: 'o',
      fetchImpl: (async () => new Response('{"message":"nope"}', { status: 400 })) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('nope');
  });

  it('sin Render configurado no intenta nada', async () => {
    const r = await dispararDeploy('srv-1', {});
    expect(r.ok).toBe(false);
  });
});

/**
 * Setear una variable de entorno SIN borrar las demas.
 *
 * `PUT /services/{id}/env-vars` reemplaza la lista ENTERA: "Any environment
 * variables that are not included will be removed from the service". Mandar
 * solo `API_URL` borraria todo lo que la persona haya cargado a mano.
 *
 * Por eso se lee primero y se manda la lista completa. Y si la lectura falla no
 * se escribe nada: perder las variables de un servicio es mucho peor que no
 * conectarlo.
 */
describe('setear una env var', () => {
  const OK = { apiKey: 'k', ownerId: 'o' };

  it('conserva las que ya estaban y agrega la nueva', async () => {
    let enviado: unknown;
    const r = await setearEnvVar('srv-1', 'API_URL', 'https://back.onrender.com', {
      ...OK,
      fetchImpl: (async (u: string, init: RequestInit) => {
        if (String(init.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify([
              { envVar: { key: 'NODE_ENV', value: 'production' } },
              { envVar: { key: 'SECRETO', value: 'no-me-borres' } },
            ]),
            { status: 200 },
          );
        }
        enviado = JSON.parse(String(init.body));
        return new Response('[]', { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(r.ok).toBe(true);
    const claves = (enviado as { key: string }[]).map((v) => v.key).sort();
    expect(claves).toEqual(['API_URL', 'NODE_ENV', 'SECRETO']);
    const api = (enviado as { key: string; value: string }[]).find((v) => v.key === 'API_URL');
    expect(api?.value).toBe('https://back.onrender.com');
  });

  // Si ya estaba, se PISA y no se duplica: dos entradas con la misma clave es
  // un estado que Render no deberia recibir.
  it('si la variable ya existia, la reemplaza sin duplicarla', async () => {
    let enviado: unknown;
    await setearEnvVar('srv-1', 'API_URL', 'https://nueva.onrender.com', {
      ...OK,
      fetchImpl: (async (u: string, init: RequestInit) => {
        if (String(init.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify([{ envVar: { key: 'API_URL', value: 'https://vieja.onrender.com' } }]),
            { status: 200 },
          );
        }
        enviado = JSON.parse(String(init.body));
        return new Response('[]', { status: 200 });
      }) as unknown as typeof fetch,
    });

    const lista = enviado as { key: string; value: string }[];
    expect(lista.filter((v) => v.key === 'API_URL')).toHaveLength(1);
    expect(lista[0]!.value).toBe('https://nueva.onrender.com');
  });

  // Lo mas importante de todo: no escribir a ciegas.
  it('si no puede leer las que hay, NO escribe nada', async () => {
    let escribio = false;
    const r = await setearEnvVar('srv-1', 'API_URL', 'https://back.onrender.com', {
      ...OK,
      fetchImpl: (async (u: string, init: RequestInit) => {
        if (String(init.method ?? 'GET') === 'GET') {
          return new Response('{"message":"boom"}', { status: 500 });
        }
        escribio = true;
        return new Response('[]', { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(escribio).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('un fallo al escribir se devuelve, no explota', async () => {
    const r = await setearEnvVar('srv-1', 'API_URL', 'https://x', {
      ...OK,
      fetchImpl: (async (u: string, init: RequestInit) =>
        String(init.method ?? 'GET') === 'GET'
          ? new Response('[]', { status: 200 })
          : new Response('{"message":"nope"}', { status: 400 })) as unknown as typeof fetch,
    });

    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('nope');
  });

  it('sin Render configurado no intenta nada', async () => {
    expect((await setearEnvVar('srv-1', 'API_URL', 'https://x', {})).ok).toBe(false);
  });
});
