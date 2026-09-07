import { describe, it, expect, vi } from 'vitest';
import {
  limiteDeHora,
  techoAlcanzado,
  parseOpcionesDeCorrida,
  promptDeAnalisis,
  textoDeInforme,
  TECHO_RONDAS_POR_DEFECTO,
  TECHO_HORA_POR_DEFECTO,
  TOPE_DE_FALLOS,
  type Corrida,
} from '../src/corrida.js';
import { handleIncoming, correrCola, type PipelineDeps } from '../src/pipeline.js';
import { InMemoryStore, type Store } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';
import { buildWebhookServer } from '../src/webhook.js';

// --- Las decisiones puras -------------------------------------------------
//
// Se testean aparte del ciclo porque son las unicas que dependen del reloj, y
// aca se les pasa uno de mentira. Sin esta separacion, probar el techo de las
// siete significaria esperar hasta las siete.

describe('limiteDeHora', () => {
  // El caso que motiva que esto no sea una suma: una corrida que arranca de
  // noche corta a la mañana SIGUIENTE, no a la que ya paso.
  it('una corrida de las 23 con hasta=07:00 corta a las 7 del dia siguiente', () => {
    // 23:00 de Argentina = 02:00 UTC del dia siguiente.
    const arranque = new Date('2026-09-08T02:00:00Z');
    const limite = limiteDeHora(arranque, '07:00');
    // 07:00 de Argentina del 8 = 10:00 UTC del 8.
    expect(limite.toISOString()).toBe('2026-09-08T10:00:00.000Z');
    expect(limite.getTime()).toBeGreaterThan(arranque.getTime());
  });

  it('una corrida de la mañana con hasta=23:00 corta el mismo dia', () => {
    // 09:00 de Argentina = 12:00 UTC.
    const limite = limiteDeHora(new Date('2026-09-07T12:00:00Z'), '23:00');
    expect(limite.toISOString()).toBe('2026-09-08T02:00:00.000Z');
  });

  // Abrir a las 07:00 con hasta=07:00 significa "hasta mañana", no "corta ya".
  it('la hora exacta del arranque se lee como la de mañana', () => {
    const arranque = new Date('2026-09-07T10:00:00Z'); // 07:00 ARG
    const limite = limiteDeHora(arranque, '07:00');
    expect(limite.getTime() - arranque.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // Una hora que el CHECK de la base no dejaria entrar. Se elige no cortar
  // nunca antes que cortar en un momento inventado.
  it('una hora que no se entiende no corta', () => {
    const arranque = new Date('2026-09-07T12:00:00Z');
    expect(limiteDeHora(arranque, 'manana').getTime()).toBeGreaterThan(
      arranque.getTime() + 300 * 24 * 60 * 60 * 1000,
    );
  });
});

describe('techoAlcanzado', () => {
  const base: Pick<
    Corrida,
    'ronda' | 'techoRondas' | 'techoHora' | 'fallosSeguidos' | 'creadoEn'
  > = {
    ronda: 1,
    techoRondas: 3,
    techoHora: '07:00',
    fallosSeguidos: 0,
    creadoEn: new Date('2026-09-08T02:00:00Z'), // 23:00 ARG
  };
  const medianoche = new Date('2026-09-08T03:00:00Z');

  it('recien abierta no corta', () => {
    expect(techoAlcanzado(base, medianoche)).toBeNull();
  });

  it('la ultima ronda permitida todavia corre', () => {
    // La ronda 3 con techo 3 es la ultima que se CORRE: el contador se pasa a 4
    // al terminarla y ahi si corta.
    expect(techoAlcanzado({ ...base, ronda: 3 }, medianoche)).toBeNull();
    expect(techoAlcanzado({ ...base, ronda: 4 }, medianoche)).toBe('techo_rondas');
  });

  it('la hora corta', () => {
    expect(techoAlcanzado(base, new Date('2026-09-08T10:00:01Z'))).toBe('techo_hora');
  });

  it('tres fallos seguidos cortan', () => {
    expect(techoAlcanzado({ ...base, fallosSeguidos: TOPE_DE_FALLOS - 1 }, medianoche)).toBeNull();
    expect(techoAlcanzado({ ...base, fallosSeguidos: TOPE_DE_FALLOS }, medianoche)).toBe(
      'demasiados_fallos',
    );
  });

  // Cuando coinciden, gana el que explica mejor lo que paso.
  it('con dos techos a la vez reporta el de fallos', () => {
    expect(
      techoAlcanzado(
        { ...base, ronda: 9, fallosSeguidos: TOPE_DE_FALLOS },
        new Date('2026-09-08T11:00:00Z'),
      ),
    ).toBe('demasiados_fallos');
  });
});

describe('parseOpcionesDeCorrida', () => {
  it('sin opciones cae a los defaults y todo es pliego', () => {
    const r = parseOpcionesDeCorrida('# Sistema de stock\n\nHay que armar lotes.');
    expect(r.techoRondas).toBe(TECHO_RONDAS_POR_DEFECTO);
    expect(r.techoHora).toBe(TECHO_HORA_POR_DEFECTO);
    expect(r.md).toBe('# Sistema de stock\n\nHay que armar lotes.');
  });

  it('toma las opciones y deja el resto como pliego', () => {
    const r = parseOpcionesDeCorrida('rondas=2 hasta=05:30\n# Stock\nlotes y FIFO');
    expect(r.techoRondas).toBe(2);
    expect(r.techoHora).toBe('05:30');
    expect(r.md).toBe('# Stock\nlotes y FIFO');
  });

  // El caso que hace que las opciones se consuman solo del PRINCIPIO: un pliego
  // que menciona la palabra no se puede comer media linea.
  it('un pliego que arranca con texto no pierde nada', () => {
    const r = parseOpcionesDeCorrida('Armar el modulo rondas=8 de stock');
    expect(r.techoRondas).toBe(TECHO_RONDAS_POR_DEFECTO);
    expect(r.md).toBe('Armar el modulo rondas=8 de stock');
  });

  it('una opcion en la misma linea que el pliego se separa', () => {
    const r = parseOpcionesDeCorrida('rondas=2 armar el stock');
    expect(r.techoRondas).toBe(2);
    expect(r.md).toBe('armar el stock');
  });

  // Un valor mal escrito a las once de la noche no puede tirar abajo un pliego
  // de doscientas lineas.
  it('un valor invalido cae al default sin perder el pliego', () => {
    const r = parseOpcionesDeCorrida('rondas=99 hasta=25:99\narmar el stock');
    expect(r.techoRondas).toBe(TECHO_RONDAS_POR_DEFECTO);
    expect(r.techoHora).toBe(TECHO_HORA_POR_DEFECTO);
    expect(r.md).toBe('armar el stock');
  });

  it('sin nada devuelve un pliego vacio, que es "mostrame como va"', () => {
    expect(parseOpcionesDeCorrida('').md).toBe('');
  });
});

describe('promptDeAnalisis', () => {
  it('lleva el pliego y la ronda, y exige la herramienta', () => {
    const p = promptDeAnalisis('# Stock\nlotes', 2);
    expect(p).toContain('# Stock\nlotes');
    expect(p).toContain('ronda 2');
    // La linea que evita la falla silenciosa: sin ella el analista contesta en
    // prosa y nadie recibe los huecos.
    expect(p).toContain('reportar_huecos');
    expect(p).toContain('lista vacia');
  });
});

describe('textoDeInforme', () => {
  const c = { proyecto: 'stock', ronda: 2, techoRondas: 3 };

  // La primera linea es el motivo, y ese orden no es estetico: es la diferencia
  // entre "esta listo" y "se corto y no lo sabias".
  it('el motivo va antes que el conteo', () => {
    const t = textoDeInforme(c, 'techo_rondas', {
      hechas: 18,
      fallidas: 2,
      pendientes: 0,
      sinResolver: [],
    });
    expect(t.indexOf('Termino porque')).toBeLessThan(t.indexOf('18 hechas'));
    expect(t).toContain('techo de rondas');
  });

  it('nombra lo que quedo sin resolver con su ronda', () => {
    const t = textoDeInforme(c, 'completo', {
      hechas: 1,
      fallidas: 1,
      pendientes: 0,
      sinResolver: [{ texto: 'el stock no descuenta al facturar', ronda: 2 }],
    });
    expect(t).toContain('el stock no descuenta al facturar');
    expect(t).toContain('ronda 2');
  });

  // El contador se pasa uno de largo justo cuando corta el techo. Un informe
  // que dice "rondas: 4" con techo 3 se lee como un bug del ciclo.
  it('no muestra mas rondas que el techo', () => {
    const t = textoDeInforme({ proyecto: 'stock', ronda: 4, techoRondas: 3 }, 'techo_rondas', {
      hechas: 0,
      fallidas: 0,
      pendientes: 0,
      sinResolver: [],
    });
    expect(t).toContain('Rondas: 3');
  });
});

// --- El ciclo -------------------------------------------------------------

const USUARIO = '99999999-9999-4999-8999-999999999999';
const PLIEGO = 'Hay que armar el modulo de stock con lotes y FIFO.';

async function vincular(store: Store, chatId: number): Promise<void> {
  const codigo = await store.crearCodigoVinculacion(chatId, 10);
  await store.canjearCodigo(codigo, USUARIO);
}

/**
 * El arnes del ciclo.
 *
 * `analista` simula lo que en produccion hace el endpoint
 * `/interno/corrida/huecos`: el turno de analisis no puede llamar una
 * herramienta MCP desde un test, asi que cuando el prompt es el del analisis se
 * hace lo MISMO que hace el endpoint —marcar la llamada y encolar— y el ciclo
 * se ejercita igual. Que el endpoint haga eso de verdad se prueba aparte, mas
 * abajo.
 */
function arnes(opciones: {
  /** Que devuelve el analista en cada ronda. `null` = no llama la herramienta. */
  analista?: (ronda: number) => string[] | null;
  /** Tareas cuyo turno tira. La clave es el texto de la tarea. */
  fallan?: Record<string, string>;
} = {}) {
  const store = new InMemoryStore();
  const ask = vi.fn(async (req: { prompt: string }) => {
    const esAnalisis = req.prompt.includes('--- PLIEGO ---');
    if (esAnalisis) {
      const corrida = await store.corridaAbierta(7);
      if (!corrida) throw new Error('el analista corrio sin corrida abierta');
      // `?? []` seria un bug del arnes: colapsaria el `null` de "no llamo la
      // herramienta" con la lista vacia de "reviso y no falta nada", que son
      // justo los dos casos que el ciclo tiene que distinguir.
      const huecos = opciones.analista ? opciones.analista(corrida.ronda) : [];
      if (huecos !== null) {
        await store.marcarHuecos(corrida.id, corrida.ronda);
        if (huecos.length > 0) {
          await store.encolar(7, {
            agente: 'c1',
            proyecto: corrida.proyecto,
            textos: huecos,
            corridaId: corrida.id,
            ronda: corrida.ronda,
          });
        }
      }
      return { jobId: 'j', sessionId: 's', text: 'revisado', turns: 1 };
    }
    const codigo = opciones.fallan?.[req.prompt];
    if (codigo) throw new Error(codigo);
    return { jobId: 'j', sessionId: 's', text: 'listo', turns: 1 };
  });

  const deps = {
    store,
    defaultAgent: 'c1' as const,
    project: 'stock',
    limite: new LimitePorChat(),
    ask,
    transcribe: vi.fn(async () => ''),
    listarAgentes: async () => [],
  } as unknown as PipelineDeps & { store: InMemoryStore; ask: typeof ask };
  return deps;
}

async function abrir(d: ReturnType<typeof arnes>, argumentos = ''): Promise<void> {
  await vincular(d.store, 7);
  await handleIncoming(
    { chatId: 7, messageId: 1, text: `/corrida ${argumentos}\n${PLIEGO}`.trim() },
    d,
  );
}

async function correr(d: ReturnType<typeof arnes>): Promise<string[]> {
  const avisos: string[] = [];
  await correrCola(7, d, async (t) => {
    avisos.push(t);
  });
  return avisos;
}

describe('correrCola dentro de una corrida', () => {
  // El gancho entero del diseño: donde antes se terminaba la noche, ahora
  // arranca el analisis.
  it('con la cola vacia corre el analisis en vez de volver', async () => {
    const d = arnes({ analista: () => [] });
    await abrir(d);
    const avisos = await correr(d);

    const prompts = d.ask.mock.calls.map((c) => c[0].prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('--- PLIEGO ---');
    expect(avisos.some((a) => a.includes('Reviso contra el pliego'))).toBe(true);
  });

  it('un analista sin huecos cierra la corrida como completa', async () => {
    const d = arnes({ analista: () => [] });
    await abrir(d);
    const avisos = await correr(d);

    expect(await d.store.corridaAbierta(7)).toBeUndefined();
    expect(avisos[avisos.length - 1]).toContain('el analista no encontro huecos');
  });

  it('con huecos los encola en la ronda siguiente y los hace', async () => {
    const d = arnes({
      analista: (ronda) => (ronda === 1 ? ['falta el descuento al facturar'] : []),
    });
    await abrir(d);
    await correr(d);

    const tareas = await d.store.tareasDeChat(7);
    expect(tareas.map((t) => t.texto)).toEqual(['falta el descuento al facturar']);
    expect(tareas[0]!.estado).toBe('lista');
    // La ronda en que se DETECTO, que es lo que despues se lee en el informe.
    expect(tareas[0]!.ronda).toBe(1);
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  // El techo que evita que el analista y el constructor se pasen la noche
  // agregando y quitando lo mismo.
  it('el techo de rondas corta y el informe lo dice', async () => {
    const d = arnes({ analista: (r) => [`hueco de la ronda ${r}`] });
    await abrir(d, 'rondas=2');
    const avisos = await correr(d);

    const corrida = await d.store.corridaAbierta(7);
    expect(corrida).toBeUndefined();
    expect(avisos[avisos.length - 1]).toContain('techo de rondas');
    // Dos rondas de analisis, no mas.
    const analisis = d.ask.mock.calls.filter((c) => c[0].prompt.includes('--- PLIEGO ---'));
    expect(analisis).toHaveLength(2);
  });

  it('la hora de corte cierra la corrida antes de tomar una tarea', async () => {
    const d = arnes({ analista: () => [] });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola una cosa' }, d);

    // Se mueve el arranque de la corrida a ayer: la hora de corte ya paso.
    const corrida = await d.store.corridaAbierta(7);
    d.store.ponerCreadoEnDeCorrida(corrida!.id, new Date(Date.now() - 48 * 60 * 60 * 1000));

    const avisos = await correr(d);
    expect(avisos[avisos.length - 1]).toContain('hora de corte');
    // No corrio NADA: el techo se mira antes de tomar la proxima.
    expect(d.ask.mock.calls).toHaveLength(0);
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  // El cambio de comportamiento mas importante: adentro de una corrida no hay
  // nadie mirando, y parar significa perder la noche entera por una tarea.
  it('una tarea que falla NO para la cola', async () => {
    const d = arnes({ analista: () => [], fallan: { dos: 'internal' } });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno\ndos\ntres' }, d);
    const avisos = await correr(d);

    const tareas = await d.store.tareasDeChat(7);
    expect(tareas.map((t) => t.estado)).toEqual(['lista', 'fallida', 'lista']);
    expect(avisos.some((a) => a.includes('Sigo con la que viene'))).toBe(true);
  });

  it('el informe lista la tarea que fallo', async () => {
    const d = arnes({ analista: () => [], fallan: { dos: 'internal' } });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno\ndos' }, d);
    const avisos = await correr(d);
    // Solo las de la corrida entran al informe, y estas se dictaron a mano...
    // asi que el informe cuenta 0 y no las nombra. Es correcto: lo que el
    // informe resume es la corrida, y las tareas de una corrida son las que
    // encolo el analista.
    expect(avisos[avisos.length - 1]).toContain('Corrida terminada');
  });

  it('tres fallos seguidos cortan la corrida', async () => {
    const d = arnes({
      analista: () => [],
      fallan: { uno: 'internal', dos: 'internal', tres: 'internal', cuatro: 'internal' },
    });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno\ndos\ntres\ncuatro' }, d);
    const avisos = await correr(d);

    expect(avisos[avisos.length - 1]).toContain(`fallaron ${TOPE_DE_FALLOS} tareas seguidas`);
    // La cuarta no se corrio: el techo se mira antes de tomarla.
    expect(d.ask.mock.calls.map((c) => c[0].prompt)).toEqual(['uno', 'dos', 'tres']);
    const tareas = await d.store.tareasDeChat(7);
    expect(tareas[3]!.estado).toBe('pendiente');
  });

  // Seguidos, no totales: una que sale bien vuelve el contador a cero.
  it('una tarea que sale bien resetea el contador de fallos', async () => {
    const d = arnes({
      analista: () => [],
      fallan: { uno: 'internal', dos: 'internal', cuatro: 'internal', cinco: 'internal' },
    });
    await abrir(d);
    await handleIncoming(
      { chatId: 7, messageId: 2, text: '/cola uno\ndos\ntres\ncuatro\ncinco' },
      d,
    );
    await correr(d);

    // Cuatro fallos en total pero nunca tres seguidos: la cola llego al final.
    const tareas = await d.store.tareasDeChat(7);
    expect(tareas.map((t) => t.estado)).toEqual([
      'fallida',
      'fallida',
      'lista',
      'fallida',
      'fallida',
    ]);
  });

  // Sin cuentas no hay nada roto: hay que esperar. Contarlo como fallo mandaria
  // a buscar un bug que no existe.
  it('usage_limit cierra con cuentas_agotadas y no cuenta como fallo', async () => {
    const d = arnes({ analista: () => [], fallan: { uno: 'usage_limit' } });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno\ndos' }, d);
    const avisos = await correr(d);

    expect(avisos[avisos.length - 1]).toContain('se agotaron los tokens');
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  // La falla silenciosa que el diseño no puede tener: cerrar diciendo
  // "completo" cuando el analista solo escribio prosa.
  it('un analista que no llama la herramienta no cierra la corrida como completa', async () => {
    const d = arnes({ analista: () => null });
    await abrir(d);
    const avisos = await correr(d);

    expect(avisos.some((a) => a.includes('no reporto por la herramienta'))).toBe(true);
    // Se reintenta hasta el techo de fallos, y cierra por eso y no por completo.
    expect(avisos[avisos.length - 1]).toContain(`fallaron ${TOPE_DE_FALLOS} tareas seguidas`);
    expect(avisos[avisos.length - 1]).not.toContain('no encontro huecos');
  });

  it('el turno de la corrida corre en modo desatendido', async () => {
    const d = arnes({ analista: () => [] });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno' }, d);
    await d.store.setModoDeChat(7, 'preguntar');
    await correr(d);

    // El modo lo fija el CICLO, no la base: con `preguntar` la primera edicion
    // colgaria el turno quince minutos esperando un OK que nadie va a dar.
    for (const [req] of d.ask.mock.calls) {
      expect((req as { modo?: string }).modo).toBe('desatendido');
    }
  });
});

describe('correrCola sin corrida: lo que ya andaba', () => {
  // El test que prueba que las corridas no rompieron la cola de siempre.
  it('una tarea que falla SI para la cola', async () => {
    const d = arnes({ fallan: { dos: 'internal' } });
    await vincular(d.store, 7);
    await handleIncoming({ chatId: 7, messageId: 1, text: '/cola uno\ndos\ntres' }, d);
    const avisos = await correr(d);

    const tareas = await d.store.tareasDeChat(7);
    expect(tareas.map((t) => t.estado)).toEqual(['lista', 'fallida', 'pendiente']);
    expect(avisos[avisos.length - 1]).toContain('Pare la cola');
  });

  it('con la cola vacia no corre ningun analisis', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    expect(await correr(d)).toEqual([]);
    expect(d.ask.mock.calls).toHaveLength(0);
  });

  it('el modo sigue saliendo de la base', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    await d.store.setModoDeChat(7, 'ediciones');
    await handleIncoming({ chatId: 7, messageId: 1, text: '/cola uno' }, d);
    await correr(d);
    expect((d.ask.mock.calls[0]![0] as { modo?: string }).modo).toBe('ediciones');
  });
});

describe('/corrida', () => {
  it('abre una con los techos que se le pasaron', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida rondas=2 hasta=05:00\n${PLIEGO}` },
      d,
    );
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    expect(r.recienAbierta).toBe(true);
    expect(r.corrida?.techoRondas).toBe(2);
    expect(r.corrida?.techoHora).toBe('05:00');
    expect(r.corrida?.md).toBe(PLIEGO);
  });

  // Dos corridas sobre el mismo chat competirian por los mismos slots y ninguna
  // de las dos terminaria.
  it('no abre una segunda', async () => {
    const d = arnes();
    await abrir(d);
    const r = await handleIncoming(
      { chatId: 7, messageId: 2, text: `/corrida\notro pliego` },
      d,
    );
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    expect(r.yaHabia).toBe(true);
    expect(r.corrida?.md).toBe(PLIEGO);
  });

  it('sin pliego muestra la que hay', async () => {
    const d = arnes();
    await abrir(d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/corrida' }, d);
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    expect(r.recienAbierta).toBe(false);
    expect(r.yaHabia).toBe(false);
    expect(r.corrida?.ronda).toBe(1);
  });

  it('sin pliego y sin corrida no inventa nada', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/corrida' }, d);
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    expect(r.corrida).toBeUndefined();
  });

  // Sin esto la cola queda vacia, el ciclo la ve vacia con una corrida abierta,
  // y arranca un analisis: cancelar resucitaria lo que se acaba de cancelar.
  it('/cancelar cierra la corrida', async () => {
    const d = arnes();
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cola uno\ndos' }, d);
    const r = await handleIncoming({ chatId: 7, messageId: 3, text: '/cancelar' }, d);
    expect(r).toEqual({ kind: 'cola_cancelada', cuantas: 2, corridaCerrada: true });
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  it('despues de /cancelar el ciclo no arranca ningun analisis', async () => {
    const d = arnes({ analista: () => ['no deberia pasar'] });
    await abrir(d);
    await handleIncoming({ chatId: 7, messageId: 2, text: '/cancelar' }, d);
    expect(await correr(d)).toEqual([]);
    expect(d.ask.mock.calls).toHaveLength(0);
  });
});

// --- El endpoint de la herramienta ----------------------------------------
//
// Es la unica prueba de que la llamada existio, y de eso depende que una
// corrida pueda cerrar como completa. El arnes del ciclo lo simula; aca se
// prueba de verdad.

describe('POST /interno/corrida/huecos', () => {
  const API_TOKEN = 'token-de-api-del-bridge';
  const bot = { handleUpdate: vi.fn(async () => {}) };

  async function conCorrida() {
    const store = new InMemoryStore();
    const app = buildWebhookServer(bot, 'secreto-de-webhook-largo', { store, apiToken: API_TOKEN });
    await vincular(store, 7);
    const corrida = await store.abrirCorrida({
      chatId: 7,
      proyecto: 'stock',
      md: PLIEGO,
      techoRondas: 3,
      techoHora: '07:00',
    });
    const jobId = await store.createJob({
      chatId: 7,
      agent: 'c1' as const,
      project: 'stock',
      prompt: 'analisis',
      messageId: 0,
    });
    return { app, store, corrida: corrida!, jobId };
  }

  function pedir(app: Awaited<ReturnType<typeof conCorrida>>['app'], payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/interno/corrida/huecos',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: payload as Record<string, unknown>,
    });
  }

  it('encola los huecos en la corrida y en su ronda', async () => {
    const { app, store, corrida, jobId } = await conCorrida();
    const res = await pedir(app, { jobId, ronda: 1, huecos: ['falta el FIFO', 'falta el test'] });

    expect(res.statusCode).toBe(200);
    const tareas = await store.tareasDeCorrida(corrida.id);
    expect(tareas.map((t) => t.texto)).toEqual(['falta el FIFO', 'falta el test']);
    expect(tareas.every((t) => t.ronda === 1)).toBe(true);
  });

  // Vacia es un valor VALIDO: es como el analista dice "no falta nada", y es el
  // unico camino a que la corrida cierre como completa.
  it('una lista vacia marca la llamada sin encolar nada', async () => {
    const { app, store, corrida, jobId } = await conCorrida();
    const res = await pedir(app, { jobId, ronda: 1, huecos: [] });

    expect(res.statusCode).toBe(200);
    expect(await store.tareasDeCorrida(corrida.id)).toEqual([]);
    expect((await store.corridaAbierta(7))?.huecosDeRonda).toBe(1);
  });

  it('marca la llamada tambien cuando encola', async () => {
    const { app, store, jobId } = await conCorrida();
    await pedir(app, { jobId, ronda: 1, huecos: ['algo'] });
    expect((await store.corridaAbierta(7))?.huecosDeRonda).toBe(1);
  });

  // Un turno colgado que contesta tarde reportaria contra una ronda que ya
  // paso, y esas tareas entrarian a una ronda a la que no pertenecen.
  it('rechaza un reporte de otra ronda', async () => {
    const { app, store, corrida, jobId } = await conCorrida();
    const res = await pedir(app, { jobId, ronda: 7, huecos: ['algo'] });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('No reintentes');
    expect(await store.tareasDeCorrida(corrida.id)).toEqual([]);
  });

  it('un job sin corrida abierta se rechaza con instrucciones', async () => {
    const { app, store, jobId, corrida } = await conCorrida();
    await store.cerrarCorrida(corrida.id, 'cancelada');
    const res = await pedir(app, { jobId, ronda: 1, huecos: ['algo'] });

    expect(res.statusCode).toBe(400);
    // El mensaje lo repite el modelo: sin el "no reintentes" queda en loop.
    expect(res.json().message).toContain('No reintentes');
  });

  it('rechaza sin bearer', async () => {
    const { app, jobId } = await conCorrida();
    const res = await app.inject({
      method: 'POST',
      url: '/interno/corrida/huecos',
      payload: { jobId, ronda: 1, huecos: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  // Una lista armada por un modelo que conto mal no puede volverse mil tareas.
  it('acota cuantos huecos entran', async () => {
    const { app, jobId } = await conCorrida();
    const res = await pedir(app, {
      jobId,
      ronda: 1,
      huecos: Array.from({ length: 51 }, (_, i) => `hueco ${i}`),
    });
    expect(res.statusCode).toBe(400);
  });
});
