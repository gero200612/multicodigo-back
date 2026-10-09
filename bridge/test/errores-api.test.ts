import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';
import { ErrorDelAgente } from '../src/agents-client.js';
import { RegistroEnMemoria, type RegistroDeErrores } from '../src/errores.js';

/**
 * El registro de errores visto desde HTTP: los cuatro endpoints de
 * `/interno/errores` y lo que el bridge anota de si mismo cuando `/turnos`
 * rechaza o falla. El upsert y el saneado se prueban en `errores.test.ts`.
 */

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const bot = { handleUpdate: vi.fn(async () => {}) };
const PROYECTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USUARIO = '99999999-9999-4999-8999-999999999999';
const auth = { authorization: `Bearer ${API_TOKEN}` };

function conRegistro(errores: RegistroDeErrores = new RegistroEnMemoria(), pipeline: Record<string, unknown> = {}) {
  const store = new InMemoryStore();
  const app = buildWebhookServer(bot, SECRET, {
    store,
    apiToken: API_TOKEN,
    errores,
    pipeline: {
      store,
      defaultAgent: 'c1' as const,
      project: 'demo',
      limite: new LimitePorChat(),
      ask: async (req: { jobId: string }) => ({ jobId: req.jobId, sessionId: 's', text: 'ok', turns: 1 }),
      transcribe: async () => '',
      listarAgentes: async () => [],
      ...pipeline,
    } as never,
  });
  return { app, errores };
}

const reporte = {
  servicio: 'gateway',
  codigo: 'internal',
  mensaje: 'algo se rompio',
  huella: 'gateway|internal|x',
  detalle: { ruta: '/agents/c1/prompt', token: 'no-tiene-que-quedar' },
  proyectoId: PROYECTO,
};

describe('/interno/errores', () => {
  // Es la tabla con los stacks y las rutas internas: sin bearer, nada.
  it('los cuatro endpoints piden el bearer', async () => {
    const { app } = conRegistro();
    const pedidos = [
      { method: 'POST' as const, url: '/interno/errores', payload: reporte },
      { method: 'GET' as const, url: '/interno/errores' },
      { method: 'GET' as const, url: '/interno/errores/1' },
      { method: 'POST' as const, url: '/interno/errores/1/estado', payload: { estado: 'descartado' } },
    ];
    for (const p of pedidos) {
      expect((await app.inject(p)).statusCode, `${p.method} ${p.url}`).toBe(401);
    }
  });

  it('registra, suma y lee', async () => {
    const { app } = conRegistro();
    const a = await app.inject({ method: 'POST', url: '/interno/errores', headers: auth, payload: reporte });
    const b = await app.inject({ method: 'POST', url: '/interno/errores', headers: auth, payload: reporte });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ id: 1, nuevo: true });
    expect(b.json()).toEqual({ id: 1, nuevo: false });

    const r = await app.inject({ method: 'GET', url: '/interno/errores/1', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      id: 1,
      huella: 'gateway|internal|x',
      servicio: 'gateway',
      codigo: 'internal',
      mensaje: 'algo se rompio',
      detalle: { ruta: '/agents/c1/prompt' },
      proyectoId: PROYECTO,
      usuarioId: null,
      veces: 2,
      estado: 'nuevo',
      arreglo: null,
    });
    expect(r.json().primera).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('un reporte mal armado da 400 y no se anota', async () => {
    const { app, errores } = conRegistro();
    const r = await app.inject({
      method: 'POST',
      url: '/interno/errores',
      headers: auth,
      payload: { ...reporte, servicio: 'otro' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('cuerpo_invalido');
    expect(await errores.listar('todos')).toEqual([]);
  });

  it('sin filtro lista los abiertos; con filtro, ese estado', async () => {
    const { app } = conRegistro();
    for (const huella of ['h1', 'h2', 'h3']) {
      await app.inject({ method: 'POST', url: '/interno/errores', headers: auth, payload: { ...reporte, huella } });
    }
    await app.inject({ method: 'POST', url: '/interno/errores/2/estado', headers: auth, payload: { estado: 'descartado' } });
    await app.inject({ method: 'POST', url: '/interno/errores/3/estado', headers: auth, payload: { estado: 'en_rama' } });

    const abiertos = await app.inject({ method: 'GET', url: '/interno/errores', headers: auth });
    expect(abiertos.statusCode).toBe(200);
    expect(abiertos.json().errores.map((e: { id: number }) => e.id).sort()).toEqual([1, 3]);

    const descartados = await app.inject({ method: 'GET', url: '/interno/errores?estado=descartado', headers: auth });
    expect(descartados.json().errores.map((e: { id: number }) => e.id)).toEqual([2]);

    const todos = await app.inject({ method: 'GET', url: '/interno/errores?estado=todos', headers: auth });
    expect(todos.json().errores).toHaveLength(3);

    const raro = await app.inject({ method: 'GET', url: '/interno/errores?estado=cualquiera', headers: auth });
    expect(raro.statusCode).toBe(400);
  });

  it('un id que no existe da 404 no_existe', async () => {
    const { app } = conRegistro();
    for (const url of ['/interno/errores/77', '/interno/errores/abc']) {
      const r = await app.inject({ method: 'GET', url, headers: auth });
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe('no_existe');
    }
    const e = await app.inject({
      method: 'POST',
      url: '/interno/errores/77/estado',
      headers: auth,
      payload: { estado: 'descartado' },
    });
    expect(e.statusCode).toBe(404);
  });

  it('cambiar el estado devuelve la fila con el arreglo', async () => {
    const { app } = conRegistro();
    await app.inject({ method: 'POST', url: '/interno/errores', headers: auth, payload: reporte });
    const r = await app.inject({
      method: 'POST',
      url: '/interno/errores/1/estado',
      headers: auth,
      payload: { estado: 'en_rama', arreglo: { job: 'j1', agente: 'c2', ramas: ['claude/c2/arreglo'] } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 1, estado: 'en_rama', arreglo: { job: 'j1', agente: 'c2' } });

    const malo = await app.inject({
      method: 'POST',
      url: '/interno/errores/1/estado',
      headers: auth,
      payload: { estado: 'arreglado' },
    });
    expect(malo.statusCode).toBe(400);
  });

  it('sin registro configurado da 503', async () => {
    const store = new InMemoryStore();
    const app = buildWebhookServer(bot, SECRET, { store, apiToken: API_TOKEN });
    const r = await app.inject({ method: 'GET', url: '/interno/errores', headers: auth });
    expect(r.statusCode).toBe(503);
  });
});

describe('/turnos anota sus fallas', () => {
  const cuerpoOk = { proyectoId: PROYECTO, proyecto: 'demo', agente: 'c1', usuarioId: USUARIO, prompt: 'hola' };

  // El caso del 2026-10-08: mas documentos que el tope, y un "el servidor no
  // esta respondiendo" sin pista. Ahora queda la fila con el campo que fallo.
  it('un cuerpo invalido devuelve errorId y anota los paths de zod, sin valores', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, errores } = conRegistro();
    const documentos = Array.from({ length: 501 }, (_, i) => ({ nombre: `d${i}.pdf`, ruta: `/srv/docs/d${i}.pdf` }));

    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: auth,
      payload: { ...cuerpoOk, prompt: 'el pedido secreto', documentos },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'cuerpo_invalido', errorId: 1 });
    const fila = (await errores.porId(1))!;
    expect(fila).toMatchObject({
      servicio: 'bridge',
      codigo: 'cuerpo_invalido',
      huella: 'bridge|cuerpo_invalido|/turnos documentos:too_big',
      proyectoId: PROYECTO,
      usuarioId: USUARIO,
      detalle: { ruta: '/turnos', issues: [{ path: 'documentos', code: 'too_big' }] },
    });
    expect(JSON.stringify(fila)).not.toContain('el pedido secreto');
    // El log de antes sigue: si el registro no anda, es la unica pista.
    expect(espia.mock.calls.some((c) => String(c[0]).includes('[bridge] turno rechazado'))).toBe(true);
    espia.mockRestore();
  });

  it('el mismo rechazo dos veces es una fila con veces 2', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, errores } = conRegistro();
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'POST', url: '/turnos', headers: auth, payload: { ...cuerpoOk, agente: 'c0' } });
    }
    const filas = await errores.listar('abiertos');
    expect(filas).toHaveLength(1);
    expect(filas[0]!.veces).toBe(2);
    espia.mockRestore();
  });

  // Un registro que falla no puede convertir un 400 en un 500: la persona
  // tiene que ver el mismo rechazo que antes, solo que sin numero.
  it('si el registro falla, /turnos contesta igual, sin errorId', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const roto: RegistroDeErrores = {
      registrar: async () => {
        throw new Error('la base se cayo');
      },
      listar: async () => [],
      porId: async () => undefined,
      cambiarEstado: async () => undefined,
      marcarPublicados: async () => [],
    };
    const { app } = conRegistro(roto, {
      ask: async () => {
        throw new Error('agent_unavailable');
      },
    });

    const invalido = await app.inject({ method: 'POST', url: '/turnos', headers: auth, payload: { ...cuerpoOk, agente: 'c0' } });
    expect(invalido.statusCode).toBe(400);
    expect(invalido.json().code).toBe('cuerpo_invalido');
    expect(invalido.json().errorId).toBeUndefined();

    const caido = await app.inject({ method: 'POST', url: '/turnos', headers: auth, payload: cuerpoOk });
    expect(caido.statusCode).toBe(502);
    expect(caido.json().code).toBe('agent_unavailable');
    expect(caido.json().errorId).toBeUndefined();
    espia.mockRestore();
  });

  // La red al gateway (o una excepcion del bridge) no la reporta nadie mas.
  it('un 502 por una falla del bridge se anota y devuelve errorId', async () => {
    const { app, errores } = conRegistro(undefined, {
      ask: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const r = await app.inject({ method: 'POST', url: '/turnos', headers: auth, payload: cuerpoOk });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ code: 'fetch failed', errorId: 1 });
    const fila = (await errores.porId(1))!;
    expect(fila.servicio).toBe('bridge');
    expect(fila.huella).toMatch(/^bridge\|fetch failed\|TypeError: fetch failed/);
    expect(fila.detalle).toMatchObject({ ruta: '/turnos', agente: 'c1' });
  });

  // El gateway ya lo anoto: anotarlo de nuevo seria el mismo bug dos veces.
  it('un 502 que viene del gateway no se anota de nuevo y pasa su errorId', async () => {
    const { app, errores } = conRegistro(undefined, {
      ask: async () => {
        throw new ErrorDelAgente('documentos_invalidos', undefined, undefined, 41);
      },
    });
    const r = await app.inject({ method: 'POST', url: '/turnos', headers: auth, payload: cuerpoOk });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ code: 'documentos_invalidos', errorId: 41 });
    expect(await errores.listar('todos')).toEqual([]);
  });

  it('un documento con es_instruccion en null pasa', async () => {
    const { app } = conRegistro();
    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: auth,
      payload: {
        ...cuerpoOk,
        documentos: [{ nombre: 'a.pdf', ruta: '/srv/docs/a.pdf', ruta_texto: null, es_instruccion: null }],
      },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('los demas /interno anotan sus rechazos', () => {
  it('un cuerpo invalido en /interno/corrida/pendiente queda registrado con su ruta', async () => {
    const { app, errores } = conRegistro();
    const r = await app.inject({
      method: 'POST',
      url: '/interno/corrida/pendiente',
      headers: auth,
      payload: { jobId: 'no-es-uuid' },
    });
    expect(r.statusCode).toBe(400);
    // Sin await en el endpoint: se espera a que el registro termine.
    await vi.waitFor(async () => expect(await errores.listar('todos')).toHaveLength(1));
    const [fila] = await errores.listar('todos');
    expect(fila!.huella).toMatch(/^bridge\|cuerpo_invalido\|\/interno\/corrida\/pendiente /);
  });
});
