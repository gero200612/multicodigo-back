import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const USUARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bot = { handleUpdate: vi.fn(async () => {}) };

/**
 * Un bridge con Drive prendido y un turno en curso.
 *
 * `respuestas` son las que va a dar el fetch de mentira, en orden: la primera
 * es SIEMPRE la del token —cada operacion saca un access token del refresh
 * token— y las que siguen son las de la API de Google.
 */
async function servidor(respuestas: Array<{ status?: number; cuerpo: unknown }> = []) {
  const store = new InMemoryStore();
  const pedidos: Array<{ url: string; init?: RequestInit }> = [];
  let n = 0;
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    pedidos.push({ url: url.toString(), init });
    const r = respuestas[n] ?? { cuerpo: {} };
    n += 1;
    const cuerpo = typeof r.cuerpo === 'string' ? r.cuerpo : JSON.stringify(r.cuerpo);
    return new Response(cuerpo, { status: r.status ?? 200 });
  });

  const app = buildWebhookServer(bot, SECRET, {
    store,
    apiToken: API_TOKEN,
    drive: {
      drive: {
        clientId: 'id',
        clientSecret: 'secret',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      panelUrl: 'https://punchi.dev',
    },
  });

  const jobId = await store.createJob({
    chatId: 1,
    agent: 'c1' as const,
    project: 'demo',
    prompt: 'hola',
    messageId: 1,
    usuarioId: USUARIO,
  });

  return { app, store, jobId, pedidos };
}

/** El token que da Google al canjear el refresh token. Va primero siempre. */
const TOKEN_OK = { cuerpo: { access_token: 'ya29.abc' } };

function pedir(app: Awaited<ReturnType<typeof servidor>>['app'], ruta: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/interno/drive/${ruta}`,
    headers: { authorization: `Bearer ${API_TOKEN}` },
    payload: body as Record<string, unknown>,
  });
}

describe('la puerta', () => {
  // Es la credencial del par gateway↔bridge. Sin esto, cualquiera que llegue al
  // bridge opera sobre el Drive de cualquiera.
  it('rechaza sin bearer', async () => {
    const { app, jobId } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/drive/buscar',
      payload: { jobId, nombre: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Sin las variables de Google el endpoint NO existe, en vez de existir y
  // fallar: "esa herramienta no esta habilitada" es la verdad, y "tu cuenta
  // esta mal conectada" mandaria a la persona a arreglar algo que esta bien.
  it('sin configurar Drive, las rutas no se registran', async () => {
    const store = new InMemoryStore();
    const app = buildWebhookServer(bot, SECRET, { store, apiToken: API_TOKEN });
    const res = await app.inject({
      method: 'POST',
      url: '/interno/drive/buscar',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { jobId: USUARIO, nombre: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('sin cuenta conectada', () => {
  // Cada herramienta EXPLICA en vez de fallar, y nombra la accion que lo
  // arregla. Es la fila de "Errores" del spec.
  it('dice que hay que conectarla en Configuracion', async () => {
    const { app, jobId } = await servidor();
    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'sin_cuenta' });
    expect(res.json().message).toMatch(/Configuracion/);
  });

  it('vale para todas las herramientas, no solo para buscar', async () => {
    const { app, jobId } = await servidor();
    for (const [ruta, cuerpo] of [
      ['leer', { jobId, id: 'f1' }],
      ['escribir', { jobId, id: 'f1', contenido: 'x' }],
      ['crear', { jobId, nombre: 'n', contenido: 'x' }],
      ['planilla', { jobId, id: 'f1', rango: 'A1', valores: [['x']] }],
      ['borrar', { jobId, id: 'f1' }],
      ['pedir-acceso', { jobId, nombre: 'n' }],
    ] as const) {
      const res = await pedir(app, ruta, cuerpo);
      expect(res.json().code, ruta).toBe('sin_cuenta');
    }
  });
});

describe('el token revocado', () => {
  // La parte importante es el efecto, no el mensaje: sin borrar la fila, cada
  // turno siguiente reintenta un token muerto y la persona nunca se entera.
  it('borra la fila', async () => {
    const { app, store, jobId } = await servidor([
      { status: 400, cuerpo: '{"error":"invalid_grant"}' },
    ]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'refresh-muerto');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'x' });
    expect(res.json().code).toBe('cuenta_revocada');
    expect(await store.googleCuenta(USUARIO)).toBeUndefined();
  });

  it('un 500 de Google NO borra la fila', async () => {
    const { app, store, jobId } = await servidor([{ status: 500, cuerpo: 'boom' }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'refresh-vivo');

    await pedir(app, 'buscar', { jobId, nombre: 'x' });
    expect(await store.googleCuenta(USUARIO)).toBeDefined();
  });
});

describe('buscar', () => {
  it('devuelve los ids, que son lo que toman las demas herramientas', async () => {
    const { app, store, jobId } = await servidor([
      TOKEN_OK,
      { cuerpo: { files: [{ id: 'f1', name: 'Balance 2026', mimeType: 'application/pdf' }] } },
    ]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance' });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toContain('f1');
    expect(res.json().output).toContain('Balance 2026');
  });

  // No corta el turno con "no lo encuentro": ofrece la accion que lo arregla.
  // Que un limite tecnico llegue a la persona como una tarea suya es lo que el
  // spec dice explicitamente que hay que evitar.
  it('un archivo que no esta ofrece pedir acceso, y es 200', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK, { cuerpo: { files: [] } }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance' });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toContain('pedir_acceso_a_drive');
  });
});

describe('borrar', () => {
  // La papelera es el "deshacer" que en el worktree da git. Se verifica que lo
  // que sale hacia Google sea un update con `trashed`, no un delete.
  it('manda a la papelera y lo dice', async () => {
    const { app, store, jobId, pedidos } = await servidor([
      TOKEN_OK,
      { cuerpo: { id: 'f1', name: 'Viejo', mimeType: 'text/plain' } },
    ]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await pedir(app, 'borrar', { jobId, id: 'f1' });
    expect(res.json().output).toMatch(/papelera/);
    expect(pedidos[1]!.init?.method).toBe('PATCH');
    expect(String(pedidos[1]!.init?.body)).toContain('trashed');
  });
});

describe('pedir acceso', () => {
  it('arma un link del panel con el codigo', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await pedir(app, 'pedir-acceso', { jobId, nombre: 'Balance 2026' });
    expect(res.json().output).toContain('https://punchi.dev/drive/autorizar?codigo=');
    // El nombre va adentro para que el Picker se abra ya buscandolo: sin eso,
    // la persona tiene que encontrarlo entre todo su Drive.
    expect(res.json().output).toContain('Balance 2026');
  });

  it('el link es de un solo uso', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await pedir(app, 'pedir-acceso', { jobId, nombre: 'Balance' });
    const codigo = new URL(
      /https:\/\/\S+/.exec(res.json().output)![0],
    ).searchParams.get('codigo')!;

    const canjear = () =>
      app.inject({
        method: 'POST',
        url: '/interno/drive/canjear',
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { codigo, id: 'elegido-1' },
      });

    expect((await canjear()).statusCode).toBe(200);
    // El segundo canje falla: un link que queda en el historial de un chat no
    // puede autorizar un segundo archivo.
    const segundo = await canjear();
    expect(segundo.statusCode).toBe(400);
    expect(segundo.json().code).toBe('link_usado');
  });

  it('un codigo que no existe no autoriza nada', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/drive/canjear',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo: 'inventado', id: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('link_desconocido');
  });

  it('el canje devuelve que archivo se habia pedido', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    const codigo = await store.crearPedidoDeDrive(USUARIO, 'Balance 2026', 30);
    void jobId;

    const res = await app.inject({
      method: 'POST',
      url: '/interno/drive/canjear',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo, id: 'elegido-1' },
    });
    expect(res.json()).toMatchObject({ nombre: 'Balance 2026', id: 'elegido-1' });
  });
});

describe('el turno sin usuario', () => {
  // Un chat de Telegram sin vincular no tiene usuario, asi que no hay cuenta de
  // Google de la cual hablar. Se dice, en vez de fallar tres capas abajo.
  it('lo explica', async () => {
    const store = new InMemoryStore();
    const app = buildWebhookServer(bot, SECRET, {
      store,
      apiToken: API_TOKEN,
      drive: {
        drive: { clientId: 'i', clientSecret: 's', fetchImpl: vi.fn() as unknown as typeof fetch },
        panelUrl: 'https://punchi.dev',
      },
    });
    const jobId = await store.createJob({
      chatId: 1,
      agent: 'c1' as const,
      project: 'demo',
      prompt: 'hola',
      messageId: 1,
    });

    const res = await pedir(app, 'buscar', { jobId, nombre: 'x' });
    expect(res.json().code).toBe('sin_contexto');
  });
});

describe('conectar la cuenta', () => {
  const REDIRECT = 'https://punchi.dev/configuracion/google';

  function conectar(app: Awaited<ReturnType<typeof servidor>>['app'], code = 'codigo-de-google') {
    return app.inject({
      method: 'POST',
      url: '/interno/google/conectar',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { usuarioId: USUARIO, code, redirectUri: REDIRECT },
    });
  }

  it('guarda el refresh token y devuelve con que cuenta quedo', async () => {
    const { app, store } = await servidor([
      { cuerpo: { refresh_token: '1//refresh', access_token: 'ya29.abc' } },
      { cuerpo: { email: 'yo@ejemplo.com' } },
    ]);

    const res = await conectar(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'yo@ejemplo.com' });
    expect(await store.googleCuenta(USUARIO)).toEqual({
      email: 'yo@ejemplo.com',
      refreshToken: '1//refresh',
    });
  });

  // La regla dura de este endpoint. El refresh token es la credencial
  // permanente de una cuenta personal: no sale por ninguna respuesta.
  it('el refresh token NO vuelve en la respuesta', async () => {
    const { app } = await servidor([
      { cuerpo: { refresh_token: '1//secretisimo', access_token: 'ya29.abc' } },
      { cuerpo: { email: 'yo@ejemplo.com' } },
    ]);
    const res = await conectar(app);
    expect(res.body).not.toContain('secretisimo');
  });

  // Sin `prompt=consent`, Google devuelve el refresh token SOLO la primera vez
  // que la cuenta autoriza la app. El sintoma seria una feature que anda para
  // las cuentas nuevas y no para la de quien ya habia conectado Drive.
  it('sin permiso permanente lo dice, y no guarda nada', async () => {
    const { app, store } = await servidor([{ cuerpo: { access_token: 'ya29.abc' } }]);
    const res = await conectar(app);
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/prompt=consent/);
    expect(await store.googleCuenta(USUARIO)).toBeUndefined();
  });

  // Es el error del servidor, no de la persona: mandarla a reconectar una
  // cuenta que esta bien seria hacerle perder el tiempo con lo que no puede
  // arreglar.
  it('un secret mal configurado se dice como problema del servidor', async () => {
    const { app } = await servidor([
      { status: 401, cuerpo: '{"error":"invalid_client"}' },
    ]);
    const res = await conectar(app);
    expect(res.json().message).toMatch(/servidor/);
  });

  it('rechaza sin bearer', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/google/conectar',
      payload: { usuarioId: USUARIO, code: 'x', redirectUri: REDIRECT },
    });
    expect(res.statusCode).toBe(401);
  });

  it('el estado dice con que cuenta, sin el token', async () => {
    const { app, store } = await servidor();
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'refresh-secretisimo');

    const res = await app.inject({
      method: 'GET',
      url: `/interno/google/estado?usuarioId=${USUARIO}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.json()).toEqual({ conectada: true, email: 'yo@ejemplo.com' });
    expect(res.body).not.toContain('secretisimo');
  });

  it('sin cuenta, el estado lo dice sin romper', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'GET',
      url: `/interno/google/estado?usuarioId=${USUARIO}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.json()).toEqual({ conectada: false, email: null });
  });

  it('desconectar borra la fila', async () => {
    const { app, store } = await servidor();
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');

    const res = await app.inject({
      method: 'DELETE',
      url: `/interno/google/conectar?usuarioId=${USUARIO}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.json()).toEqual({ desconectada: true });
    expect(await store.googleCuenta(USUARIO)).toBeUndefined();
  });
});

/**
 * El ciclo entero de "pedir acceso", que es donde vive el hallazgo del spike.
 *
 * El índice de búsqueda de Drive es eventualmente consistente: un archivo
 * recién autorizado con el Picker se lee por id de inmediato y NO aparece en
 * `files.list` hasta un rato después. El turno siguiente a un "ya lo autoricé"
 * llega mucho antes que eso.
 */
describe('el archivo recien autorizado', () => {
  /** Autoriza un archivo como lo haria la persona desde el Picker. */
  async function autorizar(
    app: Awaited<ReturnType<typeof servidor>>['app'],
    store: Awaited<ReturnType<typeof servidor>>['store'],
    nombre: string,
    archivoId: string,
  ) {
    const codigo = await store.crearPedidoDeDrive(USUARIO, nombre, 30);
    await app.inject({
      method: 'POST',
      url: '/interno/drive/canjear',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo, id: archivoId },
    });
  }

  /*
   * El test que justifica toda la columna `archivo_id`.
   *
   * Sin esto, el agente contesta "no lo encuentro" JUSTO DESPUES de que la
   * persona hizo lo que le pidieron — la peor version posible de esta feature.
   */
  it('se encuentra aunque Google todavia devuelva vacio', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK, { cuerpo: { files: [] } }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    await autorizar(app, store, 'Balance 2026', 'id-del-balance');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance 2026' });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toContain('id-del-balance');
    expect(res.json().output).toContain('recien autorizado');
  });

  // El agente puede buscar con menos palabras de las que pidio, o con mas.
  it('encuentra por una parte del nombre', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK, { cuerpo: { files: [] } }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    await autorizar(app, store, 'Balance 2026', 'id-del-balance');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance' });
    expect(res.json().output).toContain('id-del-balance');
  });

  // Es un puente sobre la ventana de propagacion, no un catalogo: un archivo
  // que no tiene nada que ver no aparece por haber autorizado otro.
  it('no devuelve un archivo que no se pidio', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK, { cuerpo: { files: [] } }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    await autorizar(app, store, 'Balance 2026', 'id-del-balance');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Contrato de alquiler' });
    expect(res.json().output).not.toContain('id-del-balance');
    expect(res.json().output).toContain('pedir_acceso_a_drive');
  });

  // Lo que Google SI encuentra manda: la busqueda en vivo es la fuente de
  // verdad, y esto es solo el puente para cuando todavia no respondio.
  it('cuando Google ya lo indexo, gana la busqueda en vivo', async () => {
    const { app, store, jobId } = await servidor([
      TOKEN_OK,
      { cuerpo: { files: [{ id: 'id-de-google', name: 'Balance 2026', mimeType: 'application/pdf' }] } },
    ]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    await autorizar(app, store, 'Balance 2026', 'id-del-balance');

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance 2026' });
    expect(res.json().output).toContain('id-de-google');
    expect(res.json().output).not.toContain('recien autorizado');
  });

  // El puente es POR USUARIO: lo que autorizo alguien no se lo encuentra otro.
  it('no cruza usuarios', async () => {
    const { app, store, jobId } = await servidor([TOKEN_OK, { cuerpo: { files: [] } }]);
    await store.guardarGoogleCuenta(USUARIO, 'yo@ejemplo.com', 'r');
    // El pedido es de OTRA persona.
    const codigo = await store.crearPedidoDeDrive(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Balance 2026',
      30,
    );
    await app.inject({
      method: 'POST',
      url: '/interno/drive/canjear',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo, id: 'id-ajeno' },
    });

    const res = await pedir(app, 'buscar', { jobId, nombre: 'Balance 2026' });
    expect(res.json().output).not.toContain('id-ajeno');
  });
});
