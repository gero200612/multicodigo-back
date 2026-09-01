import { describe, it, expect, vi } from 'vitest';
import { buildWebhookServer } from '../src/webhook.js';
import { InMemoryStore } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';

const SECRET = 'secreto-de-webhook-largo';
const API_TOKEN = 'token-de-api-del-bridge';
const bot = { handleUpdate: vi.fn(async () => {}) };
const PROYECTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTRO_PROYECTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function servidor() {
  const store = new InMemoryStore();
  const app = buildWebhookServer(bot, SECRET, { store, apiToken: API_TOKEN });
  return { app, store };
}

describe('GET /jobs', () => {
  // Las "ultimas peticiones" del panel. Salen de la MISMA tabla que usa el
  // flujo de Telegram, asi que no hay un segundo registro que se desincronice.
  it('devuelve las ultimas peticiones', async () => {
    const { app, store } = await servidor();
    await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'hola', messageId: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs[0]).toMatchObject({ agent: 'c1' as const, project: 'demo', status: 'running' });
  });

  // Este endpoint expone lo que le pediste al sistema: los prompts. Sin bearer
  // seria una filtracion de todo lo que hablaste con tus agentes.
  it('rechaza sin bearer', async () => {
    const { app } = await servidor();
    expect((await app.inject({ method: 'GET', url: '/jobs' })).statusCode).toBe(401);
  });

  it('rechaza un bearer equivocado', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: 'Bearer otro' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Un limite que venga de la URL sin tope deja pedir la tabla entera.
  it('acota el limite', async () => {
    const { app, store } = await servidor();
    for (let i = 0; i < 8; i++) {
      await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: `p${i}`, messageId: 1 });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/jobs?limit=99999',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.json().jobs.length).toBeLessThanOrEqual(50);
  });

  it('un limit basura cae al default en vez de romper', async () => {
    const { app, store } = await servidor();
    await store.createJob({ chatId: 1, agent: 'c1' as const, project: 'demo', prompt: 'x', messageId: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/jobs?limit=abc',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toHaveLength(1);
  });
});

describe('DELETE /agents/:id/sessions', () => {
  // Lo llama el login de la VM al sacar o rotar la cuenta de un slot. Tiene que
  // barrer las sesiones de ESE agente y no tocar las de los demas: un chat que
  // venia hablando con otro slot no tiene por que perder su hilo.
  it('borra las sesiones de ese agente y deja las de los otros', async () => {
    const { app, store } = await servidor();
    await store.setSession(PROYECTO, 'c1' as const, 's-c1-uno');
    await store.setSession(OTRO_PROYECTO, 'c1' as const, 's-c1-otro');
    await store.setSession(PROYECTO, 'c2' as const, 's-c2-uno');

    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/c1/sessions',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ borradas: 2 });
    expect(await store.getSession(PROYECTO, 'c1' as const)).toBeUndefined();
    expect(await store.getSession(PROYECTO, 'c2' as const)).toBe('s-c2-uno');
  });

  // Sin bearer esto seria un boton para que cualquiera te corte todos los hilos
  // de conversacion abiertos.
  it('sin bearer no borra nada', async () => {
    const { app, store } = await servidor();
    await store.setSession(PROYECTO, 'c1' as const, 's-c1-uno');

    const res = await app.inject({ method: 'DELETE', url: '/agents/c1/sessions' });

    expect(res.statusCode).toBe(401);
    expect(await store.getSession(PROYECTO, 'c1' as const)).toBe('s-c1-uno');
  });

  it('rechaza un id que no tiene forma de slot', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/..%2Fetc/sessions',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /vinculos', () => {
  it('rechaza sin bearer', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/vinculos',
      payload: { codigo: 'ABCD2345', usuarioId: '99999999-9999-4999-8999-999999999999' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('canjea un codigo valido', async () => {
    const { app, store } = await servidor();
    const codigo = await store.crearCodigoVinculacion(600, 10);
    const res = await app.inject({
      method: 'POST',
      url: '/vinculos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { codigo, usuarioId: '99999999-9999-4999-8999-999999999999' },
    });
    expect(res.statusCode).toBe(200);
    expect(await store.usuarioDeChat(600)).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('distingue los tres modos de falla', async () => {
    const { app, store } = await servidor();
    const usuario = '99999999-9999-4999-8999-999999999999';
    const pedir = (codigo: string) =>
      app.inject({
        method: 'POST',
        url: '/vinculos',
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { codigo, usuarioId: usuario },
      });

    const desconocido = await pedir('NOEXISTE');
    expect(desconocido.statusCode).toBe(400);
    expect(desconocido.json().code).toBe('codigo_desconocido');

    const vencido = await store.crearCodigoVinculacion(601, -1);
    expect((await pedir(vencido)).json().code).toBe('codigo_vencido');

    const usado = await store.crearCodigoVinculacion(602, 10);
    await pedir(usado);
    expect((await pedir(usado)).json().code).toBe('codigo_usado');
  });
});

describe('el webhook sigue andando', () => {
  it('rechaza un secret equivocado', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'mal' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  // El bearer de /jobs y el secret del webhook son credenciales DISTINTAS: una
  // la tiene el panel, la otra Telegram. Ninguna puede servir para la otra ruta.
  it('el token de la API no abre el webhook', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': API_TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('el secret del webhook no abre /jobs', async () => {
    const { app } = await servidor();
    const res = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /aprobaciones/:id/decision', () => {
  const REC = {
    approvalId: '11111111-1111-4111-8111-111111111111',
    jobId: '22222222-2222-4222-8222-222222222222',
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 'escribo a.ts',
  };
  const USUARIO = '99999999-9999-4999-8999-999999999999';

  async function conAprobacion() {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    const mandadas: unknown[] = [];
    const app = buildWebhookServer(bot, SECRET, {
      store,
      apiToken: API_TOKEN,
      decisiones: {
        store,
        send: async (_a, _id, d) => void mandadas.push(d),
        editarMensaje: async () => {},
      },
    });
    return { app, store, mandadas };
  }

  // El endpoint decide sobre el trabajo de un agente: sin bearer, cualquiera
  // aprueba lo que el agente estaba esperando que le confirmen.
  it('sin bearer da 401', async () => {
    const { app, mandadas } = await conAprobacion();

    const r = await app.inject({
      method: 'POST',
      url: `/aprobaciones/${REC.approvalId}/decision`,
      payload: { decision: { decision: 'allow' }, usuarioId: USUARIO },
    });

    expect(r.statusCode).toBe(401);
    expect(mandadas).toEqual([]);
  });

  it('decide y le avisa al gateway', async () => {
    const { app, mandadas } = await conAprobacion();

    const r = await app.inject({
      method: 'POST',
      url: `/aprobaciones/${REC.approvalId}/decision`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { decision: { decision: 'allow' }, usuarioId: USUARIO },
    });

    expect(r.statusCode).toBe(200);
    expect(mandadas).toEqual([{ decision: 'allow' }]);
  });

  // 409 y no 400: el pedido estaba bien, lo que cambio es el estado del mundo.
  // El panel lo muestra distinto por eso.
  it('decidir dos veces devuelve 409 la segunda', async () => {
    const { app, mandadas } = await conAprobacion();
    const pedir = () =>
      app.inject({
        method: 'POST',
        url: `/aprobaciones/${REC.approvalId}/decision`,
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { decision: { decision: 'allow' }, usuarioId: USUARIO },
      });

    expect((await pedir()).statusCode).toBe(200);
    expect((await pedir()).statusCode).toBe(409);
    // Y el agente recibio UNA sola decision, que es de lo que se trata.
    expect(mandadas).toHaveLength(1);
  });

  it('una aprobacion que no existe da 404', async () => {
    const { app } = await conAprobacion();

    const r = await app.inject({
      method: 'POST',
      url: '/aprobaciones/33333333-3333-4333-8333-333333333333/decision',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { decision: { decision: 'allow' }, usuarioId: USUARIO },
    });

    expect(r.statusCode).toBe(404);
  });

  it('rechaza una decision que no existe en el contrato', async () => {
    const { app, mandadas } = await conAprobacion();

    const r = await app.inject({
      method: 'POST',
      url: `/aprobaciones/${REC.approvalId}/decision`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { decision: { decision: 'quizas' }, usuarioId: USUARIO },
    });

    expect(r.statusCode).toBe(400);
    expect(mandadas).toEqual([]);
  });
});

describe('POST /turnos', () => {
  const USUARIO = '99999999-9999-4999-8999-999999999999';

  function conPipeline(overrides: Record<string, unknown> = {}) {
    const store = new InMemoryStore();
    const app = buildWebhookServer(bot, SECRET, {
      store,
      apiToken: API_TOKEN,
      pipeline: {
        store,
        defaultAgent: 'c1' as const,
        project: 'demo',
        limite: new LimitePorChat(),
        ask: async (req: { jobId: string }) => ({
          jobId: req.jobId,
          sessionId: 'sess-1',
          text: 'la respuesta',
          turns: 1,
        }),
        transcribe: async () => '',
        listarAgentes: async () => [],
        ...overrides,
      } as never,
    });
    return { app, store };
  }

  const cuerpoOk = {
    proyectoId: PROYECTO,
    proyecto: 'demo',
    agente: 'c1',
    usuarioId: USUARIO,
    prompt: 'hola',
  };

  // Este endpoint corre un turno de verdad contra un agente: sin bearer,
  // cualquiera le habla a los agentes de cualquiera.
  it('sin bearer da 401', async () => {
    const { app } = conPipeline();
    const r = await app.inject({ method: 'POST', url: '/turnos', payload: cuerpoOk });
    expect(r.statusCode).toBe(401);
  });

  // Los repos los elige el usuario en el panel y viven en Supabase; el gateway
  // no le habla a Supabase, asi que la unica forma de que los sepa es que
  // viajen con el turno. Si se quedan en el borde, el gateway cae a su catalogo
  // local y trabaja sobre los repos de otro proyecto — o sobre ninguno.
  it('los repos del pedido llegan al agente', async () => {
    const pedidos: unknown[] = [];
    const { app } = conPipeline({
      ask: async (req: { jobId: string; repos?: unknown }) => {
        pedidos.push(req.repos);
        return { jobId: req.jobId, sessionId: 'sess-1', text: 'ok', turns: 1 };
      },
    });

    const repos = [{ nombre: 'multicodigo-front', github_repo: 'gero/multicodigo-front' }];
    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { ...cuerpoOk, repos },
    });

    expect(r.statusCode).toBe(200);
    expect(pedidos).toEqual([repos]);
  });

  // Un `github_repo` entero admite `ssh://...@host/-oProxyCommand=...`, que git
  // ejecuta. El gateway ya lo valida, pero el bridge no tiene por que
  // reenviarle algo que sabe que esta mal.
  it('rechaza un repo con forma invalida', async () => {
    const { app } = conPipeline();
    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { ...cuerpoOk, repos: [{ nombre: '../../etc', github_repo: 'a/b' }] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('un turno del panel devuelve la respuesta del agente', async () => {
    const { app } = conPipeline();

    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: cuerpoOk,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().texto).toBe('la respuesta');
    expect(r.json().jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // El turno del panel deja la sesion donde la va a buscar el de Telegram: eso
  // ES el hilo compartido.
  it('guarda la sesion del proyecto', async () => {
    const { app, store } = conPipeline();

    await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: cuerpoOk,
    });

    expect(await store.getSession(PROYECTO, 'c1')).toBe('sess-1');
  });

  it('rechaza un agente con forma invalida', async () => {
    const { app } = conPipeline();

    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { ...cuerpoOk, agente: 'c0' },
    });

    expect(r.statusCode).toBe(400);
  });

  it('rechaza un proyecto con forma rara', async () => {
    const { app } = conPipeline();

    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { ...cuerpoOk, proyecto: '../otro' },
    });

    expect(r.statusCode).toBe(400);
  });

  // 502 y no 500: lo que fallo es el agente del otro lado, y el `code` es el
  // suyo. El panel lo traduce a algo que se pueda leer.
  it('un agente caido da 502 con su codigo', async () => {
    const { app } = conPipeline({
      ask: async () => {
        throw new Error('agent_unavailable');
      },
    });

    const r = await app.inject({
      method: 'POST',
      url: '/turnos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: cuerpoOk,
    });

    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('agent_unavailable');
  });
});
