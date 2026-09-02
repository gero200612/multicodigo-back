import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../src/store.js';
import { partirEnTareas } from '../src/cola.js';

/**
 * Partir un mensaje de varias lineas en tareas.
 *
 * Es la pieza que decide que se encola, asi que se equivoca de dos formas
 * caras: juntar dos tareas en una, o inventar una vacia que despues falla sola.
 */
describe('partirEnTareas', () => {
  it('una tarea por linea', () => {
    expect(partirEnTareas('arregla el stock\nagrega tests\nactualiza el readme')).toEqual([
      'arregla el stock',
      'agrega tests',
      'actualiza el readme',
    ]);
  });

  // Se escribe desde un telefono: sobran los renglones en blanco y los espacios.
  it('ignora lineas vacias y recorta espacios', () => {
    expect(partirEnTareas('  uno  \n\n\n   dos\n  ')).toEqual(['uno', 'dos']);
  });

  // Las listas se escriben con guion o con numero sin pensarlo. Si el prefijo
  // queda, el agente recibe "- arregla el stock" y lo lee como parte del pedido.
  it('saca las viñetas y la numeracion', () => {
    expect(partirEnTareas('- uno\n* dos\n1. tres\n2) cuatro')).toEqual([
      'uno',
      'dos',
      'tres',
      'cuatro',
    ]);
  });

  it('un texto de una sola linea es una sola tarea', () => {
    expect(partirEnTareas('hace esto')).toEqual(['hace esto']);
  });

  it('sin nada que hacer devuelve una lista vacia', () => {
    expect(partirEnTareas('   \n\n  ')).toEqual([]);
  });

  // Un guion adentro de la frase no es una viñeta: solo cuenta al principio.
  it('no toca los guiones del medio', () => {
    expect(partirEnTareas('arregla el auto-guardado')).toEqual(['arregla el auto-guardado']);
  });
});

describe('la cola en el store', () => {
  const CHAT = 7;

  async function conCola(textos: string[]) {
    const store = new InMemoryStore();
    await store.encolar(CHAT, { agente: 'c1', proyecto: 'sincro', textos });
    return store;
  }

  it('encola en el orden en que se dictaron', async () => {
    const store = await conCola(['uno', 'dos', 'tres']);
    const t = await store.tareasDeChat(CHAT);
    expect(t.map((x) => x.texto)).toEqual(['uno', 'dos', 'tres']);
  });

  it('la proxima es la primera pendiente', async () => {
    const store = await conCola(['uno', 'dos']);
    const p = await store.proximaTarea(CHAT);
    expect(p?.texto).toBe('uno');
  });

  // Tomarla la marca corriendo: si dos pollers preguntan a la vez, uno solo se
  // la lleva. Sin eso la misma tarea se manda dos veces.
  it('tomar la proxima la saca de pendientes', async () => {
    const store = await conCola(['uno', 'dos']);
    const a = await store.tomarProxima(CHAT);
    const b = await store.tomarProxima(CHAT);
    expect(a?.texto).toBe('uno');
    expect(b?.texto).toBe('dos');
  });

  it('sin pendientes no devuelve nada', async () => {
    const store = await conCola(['uno']);
    await store.tomarProxima(CHAT);
    expect(await store.tomarProxima(CHAT)).toBeUndefined();
  });

  it('cerrar una tarea guarda como salio', async () => {
    const store = await conCola(['uno']);
    const t = await store.tomarProxima(CHAT);
    await store.cerrarTarea(t!.id, 'lista', 'quedo hecho');
    const todas = await store.tareasDeChat(CHAT);
    expect(todas[0]!.estado).toBe('lista');
    expect(todas[0]!.resultado).toBe('quedo hecho');
  });

  // Cancelar es para "pare todo": lo que ya corre no se toca —no hay forma de
  // abortar un turno en vuelo— pero nada mas arranca.
  it('cancelar vacia lo pendiente y devuelve cuantas saco', async () => {
    const store = await conCola(['uno', 'dos', 'tres']);
    await store.tomarProxima(CHAT);
    expect(await store.cancelarCola(CHAT)).toBe(2);
    expect(await store.proximaTarea(CHAT)).toBeUndefined();
  });

  it('la cola es de cada chat', async () => {
    const store = await conCola(['uno']);
    await store.encolar(8, { agente: 'c2', proyecto: 'otro', textos: ['ajeno'] });
    expect((await store.proximaTarea(CHAT))?.texto).toBe('uno');
    expect((await store.proximaTarea(8))?.texto).toBe('ajeno');
  });
});
