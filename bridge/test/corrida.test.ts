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
  pliegoDeArchivo,
  TOPE_DE_PLIEGO,
  type Corrida,
} from '../src/corrida.js';
import { handleIncoming, correrCola, type PipelineDeps } from '../src/pipeline.js';
import { InMemoryStore, type Store } from '../src/store.js';
import { LimitePorChat } from '../src/vinculacion.js';
import { buildWebhookServer } from '../src/webhook.js';
import { textoDeCorridaEnCurso } from '../src/telegram.js';

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

describe('pliegoDeArchivo', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('un .md se lee como pliego', () => {
    const r = pliegoDeArchivo('instructivo.md', bytes('# Stock\nlotes y FIFO'));
    expect(r).toEqual({ ok: true, md: '# Stock\nlotes y FIFO' });
  });

  it('un .txt tambien', () => {
    expect(pliegoDeArchivo('pliego.txt', bytes('armar el stock')).ok).toBe(true);
  });

  // Se guardan igual como documento del proyecto —eso ya andaba— pero no
  // sirven de pliego: el analista lo relee en CADA ronda, y un pliego que salio
  // de un OCR o de una tabla es un pliego contra el que no se compara nada.
  it('un .pdf no sirve de pliego, y lo dice', () => {
    const r = pliegoDeArchivo('pliego.pdf', bytes('%PDF-1.4'));
    if (r.ok) throw new Error('deberia rechazarlo');
    expect(r.motivo).toContain('.pdf');
    expect(r.motivo).toContain('pegame el texto');
  });

  it('sin extension se rechaza sin romperse', () => {
    expect(pliegoDeArchivo('instructivo', bytes('hola')).ok).toBe(false);
  });

  // Un .md que en realidad es un binario mal nombrado se convertiria en un
  // texto lleno de U+FFFD, y ESE texto quedaria guardado como el pliego contra
  // el que se compara toda la noche.
  it('un .md que no es UTF-8 se rechaza', () => {
    const r = pliegoDeArchivo('x.md', new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
    if (r.ok) throw new Error('deberia rechazarlo');
    expect(r.motivo).toContain('UTF-8');
  });

  it('un archivo vacio se rechaza', () => {
    expect(pliegoDeArchivo('x.md', bytes('   \n')).ok).toBe(false);
  });

  it('un pliego mas grande que el tope se rechaza', () => {
    const r = pliegoDeArchivo('x.md', bytes('a'.repeat(TOPE_DE_PLIEGO + 1)));
    if (r.ok) throw new Error('deberia rechazarlo');
    expect(r.motivo).toContain('KB');
  });

  // El caso completo: adjuntar un .md con `/corrida rondas=2` de caption. El
  // handler reconstruye el comando, asi que las opciones del caption siguen
  // valiendo y no hay dos formas de entrar al comando.
  it('el texto del archivo entra como pliego y el caption como opciones', () => {
    const pliego = pliegoDeArchivo('i.md', bytes('# Stock\nlotes'));
    if (!pliego.ok) throw new Error('deberia aceptarlo');
    const r = parseOpcionesDeCorrida(`rondas=2\n${pliego.md}`);
    expect(r.techoRondas).toBe(2);
    expect(r.md).toBe('# Stock\nlotes');
  });
});

// El informe de la mañana es el UNICO mensaje de toda la feature que no se
// puede perder, y se manda con parse_mode HTML. Un `<` sin escapar hace que
// Telegram rechace el mensaje entero con "can't parse entities" — no llega mal,
// no llega.
describe('textoDeInforme: escapado', () => {
  const c = { proyecto: 'stock', ronda: 1, techoRondas: 3 };

  // El texto del hueco lo REDACTA el analista, o sea un modelo escribiendo
  // prosa libre. "el chequeo de stock < 0 falta" es una frase perfectamente
  // normal para el.
  it('escapa el texto de un hueco con < adentro', () => {
    const t = textoDeInforme(c, 'techo_rondas', {
      hechas: 0,
      fallidas: 1,
      pendientes: 0,
      sinResolver: [{ texto: 'falta el chequeo de stock < 0 & vencimiento', ronda: 1 }],
    });
    expect(t).toContain('stock &lt; 0 &amp; vencimiento');
    // Y no queda ningun `<` crudo fuera de las etiquetas que ponemos nosotros.
    expect(t).not.toContain('< 0');
  });

  it('escapa el nombre del proyecto', () => {
    const t = textoDeInforme({ proyecto: 'a<b>c', ronda: 1, techoRondas: 3 }, 'completo', {
      hechas: 0,
      fallidas: 0,
      pendientes: 0,
      sinResolver: [],
    });
    expect(t).toContain('a&lt;b&gt;c');
  });

  // El `&` primero: si se escapara despues, volveria a escapar los `&` que
  // acaban de introducir `&lt;` y saldria `&amp;lt;`.
  it('no doble-escapa', () => {
    const t = textoDeInforme(c, 'completo', {
      hechas: 0,
      fallidas: 0,
      pendientes: 0,
      sinResolver: [{ texto: '<script>' }],
    });
    expect(t).toContain('&lt;script&gt;');
    expect(t).not.toContain('&amp;lt;');
  });
});

// --- El proyecto y los repos ----------------------------------------------
//
// La otra mitad de `/corrida`: arrancar un cliente nuevo sin salir de Telegram.
// Lo que se prueba aca es sobre todo lo que NO tiene que pasar — que un fallo
// no deje una corrida abierta contra un proyecto a medias.

describe('/corrida armando el proyecto', () => {
  /** Un arnes con `crearRepo` controlable. */
  function conRepos(
    resultado: (nombre: string) =>
      | { ok: true; nombre: string; github: string }
      | { ok: false; code: string },
  ) {
    const d = arnes();
    const crearRepo = vi.fn(async (_id: number, nombre: string) => resultado(nombre));
    return Object.assign(d, { crearRepo }) as typeof d & { crearRepo: typeof crearRepo };
  }

  async function conOrgConectada(d: { store: InMemoryStore }) {
    await vincular(d.store, 7);
    // Una instalacion que la persona YA conecto desde el panel, en otro
    // proyecto. Es lo que `/corrida` hereda.
    const viejo = await d.store.crearProyecto('otro', USUARIO);
    await d.store.guardarInstalacion(viejo, 159882934, 'Sincro-arg');
  }

  it('crea el proyecto nuevo y lo deja activo', async () => {
    const d = arnes();
    await vincular(d.store, 7);

    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=stock-acme\n${PLIEGO}` },
      d,
    );
    if (r.kind !== 'corrida') throw new Error(`no es corrida: ${r.kind}`);
    expect(r.creado?.proyecto).toBe('stock-acme');
    expect(r.corrida?.proyecto).toBe('stock-acme');
    // Activo: lo que sigue —la cola, los turnos— tiene que caer ahi.
    expect(await d.store.getActiveProject(7)).toBe('stock-acme');
  });

  // Un `proyecto=` que ya existe NO crea un segundo con el mismo nombre.
  it('reusa un proyecto que ya existe, sin importar mayusculas', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    await d.store.crearProyecto('Stock', USUARIO);

    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=stock\n${PLIEGO}` },
      d,
    );
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    // Sin `creado.proyecto`: no nacio nada.
    expect(r.creado?.proyecto).toBeUndefined();
    // Y con el nombre canonico, que es el que arma la ruta del worktree.
    expect(await d.store.getActiveProject(7)).toBe('Stock');
  });

  it('crea los repos y los vincula al proyecto', async () => {
    const d = conRepos((n) => ({ ok: true, nombre: n, github: `Sincro-arg/${n}` }));
    await conOrgConectada(d);

    const r = await handleIncoming(
      {
        chatId: 7,
        messageId: 1,
        text: `/corrida proyecto=acme org=Sincro-arg repos=acme-front,acme-back\n${PLIEGO}`,
      },
      d,
    );
    if (r.kind !== 'corrida') throw new Error(`no es corrida: ${r.kind}`);
    expect(r.creado?.repos).toEqual(['Sincro-arg/acme-front', 'Sincro-arg/acme-back']);

    const proyectos = await d.store.proyectosDeUsuario(USUARIO);
    const acme = proyectos.find((p) => p.nombre === 'acme')!;
    const repos = await d.store.reposDeProyecto(acme.id);
    expect(repos.map((x) => x.github_repo)).toEqual([
      'Sincro-arg/acme-front',
      'Sincro-arg/acme-back',
    ]);
  });

  // La instalacion se HEREDA: es de la cuenta, no del proyecto, y la persona ya
  // la consintio una vez desde el panel.
  it('hereda la instalacion de la org al proyecto nuevo', async () => {
    const d = conRepos((n) => ({ ok: true, nombre: n, github: `Sincro-arg/${n}` }));
    await conOrgConectada(d);

    await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=acme org=Sincro-arg repos=uno\n${PLIEGO}` },
      d,
    );
    const proyectos = await d.store.proyectosDeUsuario(USUARIO);
    const acme = proyectos.find((p) => p.nombre === 'acme')!;
    expect(await d.store.instalacionDeCuenta(USUARIO, 'Sincro-arg')).toMatchObject({
      installationId: 159882934,
    });
    expect((await d.store.reposDeProyecto(acme.id)).length).toBe(1);
  });

  // El caso que motiva que el armado vaya ANTES de abrir la corrida: si los
  // repos fallan, no puede quedar una corrida esperando la noche contra un
  // worktree vacio.
  it('si un repo falla NO abre la corrida y dice cual quedo', async () => {
    const d = conRepos((n) =>
      n === 'dos'
        ? { ok: false, code: 'github_403' }
        : { ok: true, nombre: n, github: `Sincro-arg/${n}` },
    );
    await conOrgConectada(d);

    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=acme org=Sincro-arg repos=uno,dos\n${PLIEGO}` },
      d,
    );
    if (r.kind !== 'corrida_sin_armar') throw new Error(`no es corrida_sin_armar: ${r.kind}`);
    // El permiso, nombrado como se llama en la pantalla de GitHub.
    expect(r.motivo).toContain('Administration');
    // Y lo que YA se creo: sin esto, reintentar choca con "ya existe" y parece
    // que nada funciono.
    expect(r.motivo).toContain('Sincro-arg/uno');
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  it('una org que no se conecto se explica en vez de fallar', async () => {
    const d = conRepos((n) => ({ ok: true, nombre: n, github: `x/${n}` }));
    await vincular(d.store, 7);

    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=acme org=No-Existe repos=uno\n${PLIEGO}` },
      d,
    );
    if (r.kind !== 'corrida_sin_armar') throw new Error('no es corrida_sin_armar');
    expect(r.motivo).toContain('No-Existe');
    // Nombra la unica parte que no se puede hacer desde Telegram.
    expect(r.motivo).toContain('panel');
    expect(d.crearRepo).not.toHaveBeenCalled();
  });

  it('pedir repos sin org ni instalacion no crea nada', async () => {
    const d = conRepos((n) => ({ ok: true, nombre: n, github: `x/${n}` }));
    await vincular(d.store, 7);

    const r = await handleIncoming(
      { chatId: 7, messageId: 1, text: `/corrida proyecto=acme repos=uno\n${PLIEGO}` },
      d,
    );
    expect(r.kind).toBe('corrida_sin_armar');
    expect(await d.store.corridaAbierta(7)).toBeUndefined();
  });

  // Sin opciones sigue funcionando como antes: es la condicion de que esto no
  // rompa lo que ya andaba.
  it('sin proyecto= ni repos= usa el proyecto activo y no crea nada', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    await d.store.crearProyecto('stock', USUARIO);
    await d.store.setActiveProject(7, 'stock');

    const r = await handleIncoming({ chatId: 7, messageId: 1, text: `/corrida\n${PLIEGO}` }, d);
    if (r.kind !== 'corrida') throw new Error('no es corrida');
    expect(r.corrida?.proyecto).toBe('stock');
    expect(r.creado?.proyecto).toBeUndefined();
    expect(r.creado?.repos).toEqual([]);
  });
});

describe('parseOpcionesDeCorrida: proyecto, org y repos', () => {
  it('toma las tres y deja el pliego', () => {
    const r = parseOpcionesDeCorrida('proyecto=acme org=Sincro-arg repos=front,back\n# Stock');
    expect(r.proyecto).toBe('acme');
    expect(r.org).toBe('Sincro-arg');
    expect(r.repos).toEqual(['front', 'back']);
    expect(r.md).toBe('# Stock');
  });

  // Estos nombres terminan siendo carpetas del worktree, asi que la lista
  // blanca no es cosmetica.
  it('descarta un nombre con barras sin perder los otros', () => {
    const r = parseOpcionesDeCorrida('repos=front,../etc,back\nx');
    expect(r.repos).toEqual(['front', 'back']);
  });

  it('no repite un repo nombrado dos veces', () => {
    expect(parseOpcionesDeCorrida('repos=front,front,back\nx').repos).toEqual(['front', 'back']);
  });

  it('un proyecto con ruta adentro se ignora', () => {
    expect(parseOpcionesDeCorrida('proyecto=../otro\nx').proyecto).toBeUndefined();
  });

  it('sin repos= la lista queda vacia y no undefined', () => {
    expect(parseOpcionesDeCorrida('# Stock').repos).toEqual([]);
  });
});

// --- /status a mitad de la noche ------------------------------------------
//
// Sin esto, `/status` decia con que agente hablabas y nada mas, que a las tres
// de la mañana no contesta la pregunta que uno tiene: ¿sigue trabajando?

describe('/status con una corrida abierta', () => {
  it('sin corrida sigue diciendo lo de siempre', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    const r = await handleIncoming({ chatId: 7, messageId: 1, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    // La condicion de que esto no rompa lo que ya andaba.
    expect(r.corrida).toBeUndefined();
    expect(r.tareas).toBeUndefined();
  });

  it('trae la ronda, el techo y el conteo', async () => {
    const d = arnes();
    await abrir(d, 'rondas=2');
    const corrida = await d.store.corridaAbierta(7);
    await d.store.encolar(7, {
      agente: 'c1',
      proyecto: 'stock',
      textos: ['uno', 'dos', 'tres'],
      corridaId: corrida!.id,
      ronda: 1,
    });
    const tareas = await d.store.tareasDeChat(7);
    await d.store.cerrarTarea(tareas[0]!.id, 'lista');
    await d.store.cerrarTarea(tareas[1]!.id, 'fallida');

    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.corrida?.ronda).toBe(1);
    expect(r.corrida?.techoRondas).toBe(2);
    expect(r.tareas).toMatchObject({ hechas: 1, fallidas: 1, pendientes: 1 });
  });

  // La linea que justifica el comando: distingue un bot trabajando de uno
  // colgado hace dos horas.
  it('dice que tarea esta haciendo', async () => {
    const d = arnes();
    await abrir(d);
    const corrida = await d.store.corridaAbierta(7);
    await d.store.encolar(7, {
      agente: 'c1',
      proyecto: 'stock',
      textos: ['armar el modulo de lotes'],
      corridaId: corrida!.id,
      ronda: 1,
    });
    await d.store.tomarProxima(7);

    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.haciendo).toBe('armar el modulo de lotes');
  });

  // Sin tarea tomada y con la corrida abierta esta analizando, que dura varios
  // minutos. Sin decirlo, el silencio se lee como que se colgo.
  it('sin tarea tomada no dice que este haciendo una', async () => {
    const d = arnes();
    await abrir(d);
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.haciendo).toBeUndefined();
    expect(r.corrida).toBeDefined();
  });

  // Las tareas de la CORRIDA y no las del chat: una cola dictada a mano antes
  // de abrirla no es parte de esta noche, y contarla haria que el resumen no
  // coincida con el informe de la mañana.
  it('no cuenta las tareas que no son de la corrida', async () => {
    const d = arnes();
    await vincular(d.store, 7);
    await handleIncoming({ chatId: 7, messageId: 1, text: '/cola vieja' }, d);
    await handleIncoming({ chatId: 7, messageId: 2, text: `/corrida\n${PLIEGO}` }, d);

    const r = await handleIncoming({ chatId: 7, messageId: 3, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.tareas).toMatchObject({ hechas: 0, fallidas: 0, pendientes: 0 });
  });

  it('trae el limite de hora para poder decir cuanto falta', async () => {
    const d = arnes();
    await abrir(d, 'hasta=23:59');
    const r = await handleIncoming({ chatId: 7, messageId: 2, text: '/status' }, d);
    if (r.kind !== 'status') throw new Error('no es status');
    expect(r.limite).toBeInstanceOf(Date);
    expect(r.limite!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('textoDeCorridaEnCurso', () => {
  const base: Corrida = {
    id: 'x',
    chatId: 7,
    proyecto: 'stock',
    md: 'x',
    ronda: 2,
    techoRondas: 3,
    techoHora: '07:00',
    fallosSeguidos: 0,
    estado: 'abierta',
    creadoEn: new Date(),
  };
  const sinTareas = { hechas: 3, fallidas: 1, pendientes: 5, sinResolver: [] };

  it('la ronda y el techo van arriba', () => {
    const t = textoDeCorridaEnCurso(base, sinTareas, 'armar lotes', undefined);
    expect(t).toContain('Ronda 2 de 3');
    expect(t).toContain('armar lotes');
    expect(t).toContain('3 hechas');
  });

  it('sin tarea dice que esta revisando', () => {
    const t = textoDeCorridaEnCurso(base, sinTareas, undefined, undefined);
    expect(t).toContain('Revisando el repo contra el pliego');
  });

  // En una noche normal el contador esta en cero y nombrarlo seria ruido.
  it('no nombra los fallos seguidos cuando no hay', () => {
    expect(textoDeCorridaEnCurso(base, sinTareas, undefined, undefined)).not.toContain('seguido');
  });

  it('avisa cuando falta poco para el techo de fallos', () => {
    const t = textoDeCorridaEnCurso(
      { ...base, fallosSeguidos: 2 },
      sinTareas,
      undefined,
      undefined,
    );
    expect(t).toContain('2 fallo(s) seguido(s)');
    expect(t).toContain(String(TOPE_DE_FALLOS));
  });

  it('dice cuanto falta para la hora de corte', () => {
    const t = textoDeCorridaEnCurso(
      base,
      sinTareas,
      undefined,
      new Date(Date.now() + 90 * 60 * 1000),
    );
    expect(t).toContain('1h 30m');
  });

  it('con la hora ya pasada lo dice en vez de un numero negativo', () => {
    const t = textoDeCorridaEnCurso(
      base,
      sinTareas,
      undefined,
      new Date(Date.now() - 60 * 1000),
    );
    expect(t).toContain('Ya paso la hora de corte');
    expect(t).not.toContain('-');
  });

  // El texto de la tarea lo dicta una persona o lo redacta el analista, y este
  // mensaje va con parse_mode HTML.
  it('escapa el texto de la tarea', () => {
    const t = textoDeCorridaEnCurso(base, sinTareas, 'chequear stock < 0', undefined);
    expect(t).toContain('stock &lt; 0');
  });
});
