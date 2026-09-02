import { describe, it, expect } from 'vitest';
import { renderOutcome, textoDeOcupado, textoDeActivos, textoDePermisos } from '../src/telegram.js';
import { buildWebhookServer } from '../src/webhook.js';

describe('renderOutcome', () => {
  it('explica que hay que vincularse, sin decir como por dentro', () => {
    const texto = renderOutcome({ kind: 'sin_vincular', yaEstaba: false });
    expect(texto).toContain('/vincular');
  });

  it('a un chat ya vinculado le dice que ya lo esta', () => {
    const texto = renderOutcome({ kind: 'sin_vincular', yaEstaba: true });
    expect(texto).toContain('ya');
    expect(texto).not.toContain('/vincular');
  });

  it('renderiza el menu de proyectos', () => {
    const texto = renderOutcome({ kind: 'menu_proyectos', botones: [] });
    expect(texto.toLowerCase()).toContain('proyecto');
  });

  it('el menu de agentes dice de que proyecto son, y que significa cada marca', () => {
    const texto = renderOutcome({ kind: 'menu_agentes', proyecto: 'demo', botones: [] });
    expect(texto).toContain('demo');
    // La leyenda importa: tres simbolos sin referencia no se entienden.
    expect(texto).toContain('●');
    expect(texto).toContain('○');
    expect(texto).toContain('⚠');
  });

  it('sin proyectos explica que hacer', () => {
    const texto = renderOutcome({ kind: 'sin_proyectos' });
    expect(texto.toLowerCase()).toContain('panel');
  });

  it('al elegir agente confirma con quien hablas', () => {
    const texto = renderOutcome({ kind: 'elegido', agente: 'c3', nombre: 'Backend', proyecto: 'demo' });
    expect(texto).toContain('Backend');
    expect(texto).toContain('demo');
  });

  it('muestra el codigo y cuanto dura', () => {
    const texto = renderOutcome({ kind: 'codigo', codigo: 'ABCD2345', minutos: 10 });
    expect(texto).toContain('ABCD2345');
    expect(texto).toContain('10');
  });

  it('muestra la respuesta con el agente que la dio', () => {
    const out = renderOutcome({
      kind: 'answer',
      text: 'El stock usa FIFO.',
      agent: 'c1',
      jobId: 'j',
    });
    expect(out).toContain('C1');
    expect(out).toContain('El stock usa FIFO.');
  });

  it('NO repite la transcripcion del audio', () => {
    // Estaba y se saco: el que acaba de hablar ya sabe lo que dijo, y esas dos
    // lineas empujaban la respuesta fuera de la pantalla del telefono.
    const out = renderOutcome({ kind: 'answer', text: 'listo', agent: 'c2', jobId: 'j' });
    expect(out).not.toContain('te escuche');
    expect(out).toContain('listo');
  });

  it('confirma el cambio de agente', () => {
    expect(renderOutcome({ kind: 'switched', agent: 'c2' })).toContain('C2');
  });

  it('muestra el agente activo en status', () => {
    expect(renderOutcome({ kind: 'status', agent: 'c1', otros: [] })).toContain('C1');
  });

  it('muestra el error sin exponer detalles internos', () => {
    const out = renderOutcome({ kind: 'error', text: 'Ese agente necesita re-login.', jobId: 'j' });
    expect(out).toContain('re-login');
    expect(out).not.toContain('jobId');
  });
});

describe('buildWebhookServer', () => {
  const slowBot = {
    handleUpdate: () => new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  };

  it('contesta 200 sin esperar el procesamiento del update', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'secreto' },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(200);
    // El bot falso tarda 3000 ms. Lo que se prueba es que NO se lo espera, y
    // para eso alcanza cualquier umbral bien por debajo de esos 3 segundos.
    // Con 100 ms el test fallaba cuando el suite completo corria en paralelo y
    // la maquina estaba cargada: medir "es rapido" en vez de "no espera" lo
    // hacia depender del hardware.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rechaza con 401 si el secreto no coincide', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'otro' },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rechaza con 401 si falta el header del secreto', async () => {
    const app = buildWebhookServer(slowBot, 'secreto');
    const res = await app.inject({ method: 'POST', url: '/telegram/webhook', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

import { decidirAprobacion } from '../src/telegram.js';
import { InMemoryStore } from '../src/store.js';

describe('decidirAprobacion', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const REC = {
    approvalId: ID,
    jobId: '22222222-2222-4222-8222-222222222222',
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 's',
  };

  async function conAprobacion() {
    const store = new InMemoryStore();
    await store.recordApproval(REC);
    return store;
  }

  it('manda allow al agente y confirma', async () => {
    const store = await conAprobacion();
    const mandadas: unknown[] = [];
    const r = await decidirAprobacion(
      { kind: 'ok', approvalId: ID },
      { store, send: async (_a, _id, d) => void mandadas.push(d), editarMensaje: async () => {} },
    );
    expect(mandadas).toEqual([{ decision: 'allow' }]);
    expect(r.text).toContain('Aprobado');
  });

  // El caso del boton tocado tres veces: no se manda nada al agente.
  it('el segundo toque no vuelve a mandar la decision', async () => {
    const store = await conAprobacion();
    let veces = 0;
    const deps = { store, send: async () => void (veces += 1), editarMensaje: async () => {} };
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, deps);
    const r = await decidirAprobacion({ kind: 'ok', approvalId: ID }, deps);
    expect(veces).toBe(1);
    expect(r.text).toContain('ya');
  });

  it('rechazar manda deny sin feedback', async () => {
    const store = await conAprobacion();
    const mandadas: unknown[] = [];
    await decidirAprobacion(
      { kind: 'no', approvalId: ID },
      { store, send: async (_a, _id, d) => void mandadas.push(d), editarMensaje: async () => {} },
    );
    expect(mandadas).toEqual([{ decision: 'deny' }]);
  });

  // "Rechazar y explicar" no decide todavia: deja el chat esperando el motivo.
  it('explicar no manda nada y deja el chat esperando el motivo', async () => {
    const store = await conAprobacion();
    let veces = 0;
    const r = await decidirAprobacion(
      { kind: 'ex', approvalId: ID },
      { store, send: async () => void (veces += 1), editarMensaje: async () => {} },
    );
    expect(veces).toBe(0);
    expect(await store.getAwaitingFeedback(5)).toBe(ID);
    expect(r.text).toContain('Contame');
  });

  it('una aprobacion desconocida no rompe', async () => {
    const r = await decidirAprobacion(
      { kind: 'ok', approvalId: '99999999-9999-4999-8999-999999999999' },
      { store: new InMemoryStore(), send: async () => {}, editarMensaje: async () => {} },
    );
    expect(r.text).toContain('no');
  });
});

describe('el job cambia de estado con la aprobacion', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const JOB = '22222222-2222-4222-8222-222222222222';
  const REC = {
    approvalId: ID,
    jobId: JOB,
    chatId: 5,
    messageId: 9,
    agent: 'c1' as const,
    tool: 'Write',
    summary: 's',
  };

  async function conJobYAprobacion() {
    const store = new InMemoryStore();
    // Se fuerza el id del job para poder seguirlo: createJob genera uno propio.
    await store.recordApproval(REC);
    return store;
  }

  // Lo que arregla el hueco: mientras espera el OK, el job NO dice 'running'.
  it('decidir devuelve el job a running', async () => {
    const store = await conJobYAprobacion();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, approvalId: 'otra', jobId });
    await store.setJobStatus(jobId, 'awaiting_approval');
    expect(await store.getJobStatus(jobId)).toBe('awaiting_approval');

    await decidirAprobacion(
      { kind: 'ok', approvalId: 'otra' },
      { store, send: async () => {}, editarMensaje: async () => {} },
    );
    expect(await store.getJobStatus(jobId)).toBe('running');
  });

  it('rechazar tambien lo devuelve a running: el turno sigue vivo hasta que cierre', async () => {
    const store = new InMemoryStore();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, jobId });
    await store.setJobStatus(jobId, 'awaiting_approval');

    await decidirAprobacion({ kind: 'no', approvalId: ID }, { store, send: async () => {}, editarMensaje: async () => {} });
    expect(await store.getJobStatus(jobId)).toBe('running');
  });

  it('un doble toque no toca el estado del job', async () => {
    const store = new InMemoryStore();
    const jobId = await store.createJob({
      chatId: 5, agent: 'c1', project: 'demo', prompt: 'x', messageId: 9,
    });
    await store.recordApproval({ ...REC, jobId });
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, { store, send: async () => {}, editarMensaje: async () => {} });
    await store.finishJob(jobId, 'done');
    // El segundo toque llega tarde; no puede reabrir el job.
    await decidirAprobacion({ kind: 'ok', approvalId: ID }, { store, send: async () => {}, editarMensaje: async () => {} });
    expect(await store.getJobStatus(jobId)).toBe('done');
  });
});

describe('renderOutcome — proyecto', () => {
  it('confirma el proyecto activo', () => {
    const out = renderOutcome({ kind: 'project', project: 'sincroresto' });
    expect(out).toContain('sincroresto');
  });
});

describe('el aviso de slot ocupado', () => {
  const AHORA = 1_700_000_600_000;

  it('nombra al agente y a quien lo tiene', () => {
    const t = textoDeOcupado('c1', 'martin', AHORA - 120_000, false, AHORA);
    expect(t).toContain('C1');
    expect(t).toContain('martin');
  });

  // "hace 1 min" invita a esperar; "hace 40 min", a cambiar de agente. Sin el
  // tiempo, el aviso obliga a preguntar.
  it('dice hace cuanto lo tienen', () => {
    expect(textoDeOcupado('c1', 'martin', AHORA - 120_000, false, AHORA)).toContain('hace 2 min');
    expect(textoDeOcupado('c1', 'martin', AHORA - 60_000, false, AHORA)).toContain('hace 1 min');
    expect(textoDeOcupado('c1', 'martin', AHORA - 5_000, false, AHORA)).toContain('recien');
  });

  it('sin nombre dice "otra persona" en vez de romperse', () => {
    expect(textoDeOcupado('c2', undefined, AHORA, false, AHORA)).toContain('otra persona');
  });

  it('sin saber desde cuando, no inventa un tiempo', () => {
    const t = textoDeOcupado('c2', 'lucia', undefined, false, AHORA);
    expect(t).toContain('lucia');
    expect(t).not.toContain('hace');
  });

  it('avisa que el mensaje escrito se reenvia: el prompt no se pierde', () => {
    expect(textoDeOcupado('c1', 'martin', AHORA, false, AHORA)).toContain('lo que me escribiste');
  });
});

describe('con quien estas trabajando', () => {
  // Confundir el primario con los demas es mandarle el pedido al agente
  // equivocado: es a el a quien le llega el texto sin prefijo.
  it('con un solo agente dice a quien le hablas y como sumar otro', () => {
    const t = textoDeActivos('c1', []);
    expect(t).toContain('C1');
    expect(t).toContain('/cowork');
  });

  it('lista los demas con el comando para hablarles', () => {
    const t = textoDeActivos('c1', ['c2', 'c3']);
    expect(t).toContain('C2');
    expect(t).toContain('/c2');
    expect(t).toContain('C3');
  });

  it('con varios, explica como sacar uno', () => {
    expect(textoDeActivos('c1', ['c2'])).toContain('/cowork c2');
  });
});

describe('por que esta ocupado', () => {
  const AHORA = 1_700_000_600_000;

  // "Esperá un cachito" y "andate a otro agente" son consejos distintos, y sin
  // decir cual es, hay que adivinar.
  it('un turno frenado en una aprobacion lo dice', () => {
    const t = textoDeOcupado('c1', 'martin', AHORA - 60_000, true, AHORA);
    expect(t).toContain('apruebe');
    expect(t).toContain('martin');
  });

  it('un turno que solo esta trabajando no inventa un motivo', () => {
    const t = textoDeOcupado('c1', 'martin', AHORA - 60_000, false, AHORA);
    expect(t).not.toContain('apruebe');
  });
});

describe('el mensaje de los modos de permiso', () => {
  it('dice el modo y que deja pasar', () => {
    const t = textoDePermisos('ediciones', false);
    expect(t).toContain('ediciones');
    expect(t).toContain('sin preguntarte');
  });

  it('confirma cuando se acaba de cambiar, y no cuando solo se consulta', () => {
    expect(textoDePermisos('todo', true)).toContain('cambie');
    expect(textoDePermisos('todo', false)).not.toContain('cambie');
  });

  // La excepcion que sorprende. Quien elige "aprobar todo" tiene que leerla
  // ahi mismo y no en otro mensaje, asi que va en los tres.
  it('los tres modos avisan que git pregunta siempre', () => {
    for (const modo of ['preguntar', 'ediciones', 'todo'] as const) {
      const t = textoDePermisos(modo, false);
      expect(t).toContain('push');
      expect(t).toContain('SIEMPRE');
    }
  });

  it('los tres avisan que hay cosas que no se tocan en ningun modo', () => {
    for (const modo of ['preguntar', 'ediciones', 'todo'] as const) {
      expect(textoDePermisos(modo, false)).toContain('.env');
    }
  });
});
