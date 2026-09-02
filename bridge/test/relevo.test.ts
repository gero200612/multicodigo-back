import { describe, expect, it } from 'vitest';
import { promptDeRelevo, proximoSlot } from '../src/relevo.js';

const CON_CUENTA = (id: string) => ({ id, cuenta: true, arriba: false });

describe('a quien le toca seguir', () => {
  it('elige el primero con cuenta que no se probo', () => {
    const slots = [CON_CUENTA('c1'), CON_CUENTA('c2'), CON_CUENTA('c3')];
    expect(proximoSlot(slots, ['c1'])).toBe('c2');
  });

  // Sin esto el relevo vuelve al que acaba de fallar y el turno gira en el
  // mismo lugar hasta agotar el tope de intentos.
  it('nunca devuelve uno ya probado', () => {
    const slots = [CON_CUENTA('c1'), CON_CUENTA('c2')];
    expect(proximoSlot(slots, ['c1', 'c2'])).toBeUndefined();
  });

  // Un slot sin cuenta cargada no puede trabajar: relevar con el cambia el error
  // de "sin tokens" a "sin credencial", que es peor porque suena a otro problema.
  it('saltea los que no tienen cuenta', () => {
    const slots = [CON_CUENTA('c1'), { id: 'c2', cuenta: false, arriba: false }, CON_CUENTA('c3')];
    expect(proximoSlot(slots, ['c1'])).toBe('c3');
  });

  // Los slots estan apagados por defecto y el turno los prende. Exigir que ya
  // esten arriba dejaria el relevo sin candidatos en el caso normal.
  it('no exige que el slot ya este corriendo', () => {
    expect(proximoSlot([{ id: 'c2', cuenta: true, arriba: false }], ['c1'])).toBe('c2');
  });

  it('ordena numericamente y no alfabeticamente', () => {
    // Con orden alfabetico, c10 vendria antes que c2.
    const slots = [CON_CUENTA('c10'), CON_CUENTA('c2')];
    expect(proximoSlot(slots, [])).toBe('c2');
  });

  it('sin candidatos devuelve undefined en vez de tirar', () => {
    expect(proximoSlot([], [])).toBeUndefined();
  });
});

describe('el prompt del relevo', () => {
  const turnos = [
    { prompt: 'agrega un endpoint de health', respuesta: 'listo, esta en server.ts' },
    { prompt: 'agregale un test', respuesta: 'agregado en server.test.ts' },
  ];

  it('lleva el pedido original', () => {
    const p = promptDeRelevo('ahora corre los tests', turnos, 'c1');
    expect(p).toContain('ahora corre los tests');
  });

  it('lleva el hilo anterior, en orden', () => {
    const p = promptDeRelevo('segui', turnos, 'c1');
    expect(p.indexOf('endpoint de health')).toBeLessThan(p.indexOf('agregale un test'));
  });

  /*
   * Lo mas importante del prompt.
   *
   * El slot que releva arranca una sesion NUEVA, asi que no sabe que hubo un
   * antes. Sin decirle que el trabajo ya esta en disco, lo mas probable es que
   * empiece de cero y pise lo que estaba hecho — el worktree es compartido por
   * proyecto, no por slot.
   */
  it('avisa que el trabajo ya esta en el worktree', () => {
    const p = promptDeRelevo('segui', turnos, 'c1');
    expect(p.toLowerCase()).toContain('worktree');
    expect(p.toLowerCase()).toContain('no lo rehagas');
  });

  it('dice de quien es el relevo', () => {
    expect(promptDeRelevo('segui', turnos, 'c1')).toContain('c1');
  });

  it('sin hilo previo, manda a revisar el worktree', () => {
    const p = promptDeRelevo('segui', [], 'c1');
    expect(p.toLowerCase()).toContain('revisa el estado del worktree');
    expect(p).toContain('segui');
  });

  /*
   * Un prompt gigante gasta justamente el token que el relevo quiere ahorrar.
   *
   * El tope actua sobre los turnos que YA paso el filtro de cantidad, asi que
   * hace falta que esos pocos sean largos: es el caso real de una respuesta que
   * lista archivos o pega un diff, no el de muchos turnos cortos.
   */
  it('recorta un hilo largo por el principio y no por el final', () => {
    const largos = Array.from({ length: 8 }, (_, i) => ({
      prompt: `pedido-${i} `.repeat(60),
      respuesta: `respuesta-${i} ` + 'x'.repeat(1500),
    }));
    const p = promptDeRelevo('segui', largos, 'c1');

    // El tope es 6000 mas el encabezado y el pedido original, no mucho mas.
    expect(p.length).toBeLessThan(7000);
    // Lo ultimo que paso es lo que hace falta para seguir: tiene que sobrevivir.
    expect(p).toContain('respuesta-7');
    expect(p).toContain('se omitio el principio');
    // Y el pedido original nunca se recorta: es lo que hay que hacer.
    expect(p).toContain('segui');
  });

  it('solo usa los ultimos turnos, no el hilo entero', () => {
    const muchos = Array.from({ length: 20 }, (_, i) => ({
      prompt: `pedido-${i}`,
      respuesta: `ok-${i}`,
    }));
    const p = promptDeRelevo('segui', muchos, 'c1');

    expect(p).toContain('pedido-19');
    expect(p).not.toContain('pedido-0');
  });
});

describe('proximoSlot y los slots ocupados', () => {
  // Relevar sobre un slot que esta usando otra persona gasta uno de los tres
  // intentos contra un 409 seguro, y le muestra el aviso de ocupado a alguien
  // que pregunto por otra cosa.
  it('no releva sobre un slot que tiene otra persona', () => {
    const candidatos = [
      { id: 'c2', cuenta: true, arriba: true, ocupado: true },
      { id: 'c3', cuenta: true, arriba: true, ocupado: false },
    ];
    expect(proximoSlot(candidatos, ['c1'])).toBe('c3');
  });

  it('sin ningun libre no releva a ninguno', () => {
    const candidatos = [{ id: 'c2', cuenta: true, arriba: true, ocupado: true }];
    expect(proximoSlot(candidatos, ['c1'])).toBeUndefined();
  });

  // `ocupado` es opcional en el contrato: un gateway viejo no lo manda, y eso
  // no puede significar "todos ocupados".
  it('sin el dato de ocupado, el slot sigue siendo candidato', () => {
    const candidatos = [{ id: 'c2', cuenta: true, arriba: true }];
    expect(proximoSlot(candidatos, ['c1'])).toBe('c2');
  });
});
