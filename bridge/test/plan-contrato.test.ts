import { describe, it, expect } from 'vitest';
import { textoDePlan } from '../src/telegram.js';

describe('el mensaje del plan', () => {
  const tareas = [
    { id: 't1', agente: 'c1', proyecto: 'x', texto: 'armar el back', posicion: 1, estado: 'pendiente' },
  ] as never;

  // Se dice porque cambia lo que se puede esperar: front y back se construyen
  // en paralelo contra las mismas rutas.
  it('avisa cuando el contrato quedo fijado', () => {
    expect(textoDePlan('despacho', tareas, true)).toContain('Fije el contrato');
  });

  it('no lo menciona si no lo hay', () => {
    expect(textoDePlan('despacho', tareas)).not.toContain('contrato');
  });
});
