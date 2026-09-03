import { describe, it, expect } from 'vitest';
import { separarInstructivo } from '../src/documentos.js';

/*
 * Separar el instructivo del proyecto del resto de los documentos.
 *
 * Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md`.
 *
 * Vive en el bridge y no en el panel porque hay DOS caminos que llegan al
 * gateway —el del panel, donde los documentos vienen en el pedido, y el de
 * Telegram, donde el bridge los busca solo— y los dos tienen que separar igual.
 * Hacerlo en el panel dejaria el camino del bot sin instructivo.
 */

const PLIEGO = { nombre: 'pliego.pdf', ruta: 'p/pliego.pdf', ruta_texto: 'p/pliego.pdf.md' };
const PASOS = {
  nombre: 'pasos.md',
  ruta: 'p/pasos.md',
  ruta_texto: 'p/pasos.md',
  es_instruccion: true,
};

describe('separarInstructivo', () => {
  it('devuelve el instructivo aparte', () => {
    const r = separarInstructivo([PLIEGO, PASOS]);
    expect(r.instrucciones).toEqual(PASOS);
  });

  /*
   * El instructivo SIGUE en la lista de documentos, y no es un descuido.
   *
   * De `documentos` sale la copia a `_docs` del worktree, que es lo que le deja
   * al agente CITARLO ("el paso 4 del instructivo dice..."). Sacarlo de la
   * lista le daria el texto en el prompt pero ningun archivo que nombrar.
   */
  it('deja el instructivo tambien en la lista, para que se copie a _docs', () => {
    const r = separarInstructivo([PLIEGO, PASOS]);
    expect(r.documentos).toHaveLength(2);
    expect(r.documentos.map((d) => d.nombre)).toContain('pasos.md');
  });

  it('sin instructivo devuelve undefined y la lista intacta', () => {
    const r = separarInstructivo([PLIEGO]);
    expect(r.instrucciones).toBeUndefined();
    expect(r.documentos).toEqual([PLIEGO]);
  });

  it('sin documentos no rompe', () => {
    expect(separarInstructivo([])).toEqual({ documentos: [], instrucciones: undefined });
    expect(separarInstructivo(undefined)).toEqual({
      documentos: undefined,
      instrucciones: undefined,
    });
  });

  /*
   * La base tiene un indice unico parcial que impide dos instructivos por
   * proyecto, asi que este caso no deberia poder existir. Se define igual —el
   * primero por nombre— porque "no deberia pasar" no es un comportamiento: si
   * alguna vez pasa (un insert con la service_role que saltee el indice, una
   * base sin migrar), lo que no puede es que el instructivo cambie de turno en
   * turno segun como venga ordenada la lista.
   */
  it('con dos instructivos elige uno solo y siempre el mismo', () => {
    const otro = { ...PASOS, nombre: 'aaa.md', ruta: 'p/aaa.md', ruta_texto: 'p/aaa.md' };
    const r1 = separarInstructivo([PASOS, otro]);
    const r2 = separarInstructivo([otro, PASOS]);
    expect(r1.instrucciones?.nombre).toBe('aaa.md');
    expect(r2.instrucciones?.nombre).toBe('aaa.md');
  });

  // `es_instruccion: false` es lo que trae toda fila vieja por el default de la
  // columna: no puede contar como instructivo.
  it('es_instruccion false no cuenta', () => {
    const r = separarInstructivo([{ ...PLIEGO, es_instruccion: false }]);
    expect(r.instrucciones).toBeUndefined();
  });
});
