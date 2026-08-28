import { describe, it, expect } from 'vitest';
import { LimitePorChat } from '../src/vinculacion.js';

describe('LimitePorChat', () => {
  it('deja pasar el primero', () => {
    const limite = new LimitePorChat(3, 60_000, () => 0);
    expect(limite.permite(1)).toBe(true);
  });

  it('corta al pasar el tope', () => {
    const limite = new LimitePorChat(2, 60_000, () => 0);
    expect(limite.permite(1)).toBe(true);
    expect(limite.permite(1)).toBe(true);
    expect(limite.permite(1)).toBe(false);
  });

  it('el tope es por chat y no global', () => {
    const limite = new LimitePorChat(1, 60_000, () => 0);
    expect(limite.permite(1)).toBe(true);
    expect(limite.permite(2)).toBe(true);
  });

  it('perdona cuando pasa la ventana', () => {
    let ahora = 0;
    const limite = new LimitePorChat(1, 60_000, () => ahora);
    expect(limite.permite(1)).toBe(true);
    expect(limite.permite(1)).toBe(false);
    ahora = 60_001;
    expect(limite.permite(1)).toBe(true);
  });

  it('no acumula chats para siempre', () => {
    // Un bot publico recibe mensajes de chats que nunca vuelven. Si cada uno
    // dejara una entrada, la memoria crece sin techo.
    let ahora = 0;
    const limite = new LimitePorChat(1, 60_000, () => ahora);
    for (let i = 0; i < 1000; i++) limite.permite(i);
    ahora = 120_000;
    limite.permite(9999);
    expect(limite.tamaño()).toBeLessThan(10);
  });
});
