import { describe, expect, it } from 'vitest';
import { cupoDelDia, enviarMail, type Correo } from '../src/envio.js';
import { MemoriaStore } from './memoria.js';

describe('cupoDelDia (calentamiento)', () => {
  const primero = new Date('2026-09-28T15:00:00Z');
  it('una casilla que nunca mando arranca con 5', () => {
    expect(cupoDelDia(undefined, new Date())).toBe(5);
  });
  it('sube de a 3 cada dos dias', () => {
    expect(cupoDelDia(primero, new Date('2026-09-29T15:00:00Z'))).toBe(5);
    expect(cupoDelDia(primero, new Date('2026-09-30T15:00:00Z'))).toBe(8);
    expect(cupoDelDia(primero, new Date('2026-10-02T15:00:00Z'))).toBe(11);
  });
  it('nunca pasa de 25', () => {
    expect(cupoDelDia(primero, new Date('2026-12-01T15:00:00Z'))).toBe(25);
  });
});

describe('enviarMail', () => {
  const casilla = { email: 'sincro.ventas@gmail.com', clave: 'x' };
  const ahora = new Date('2026-09-29T17:00:00Z');

  it('con el cupo lleno espera a la ventana de mañana', async () => {
    const store = new MemoriaStore(() => ahora);
    const correo: Correo = { enviar: async () => ({}) };
    const deps = { store, correo, remitente: 'G', ahora: () => ahora };
    for (let i = 0; i < 5; i++) {
      expect((await enviarMail(deps, casilla, { para: `c${i}@x.com`, asunto: 'a', texto: 't' })).tipo).toBe('enviado');
    }
    const r = await enviarMail(deps, casilla, { para: 'c6@x.com', asunto: 'a', texto: 't' });
    expect(r).toMatchObject({ tipo: 'esperar', motivo: 'sin_cupo' });
    if (r.tipo === 'esperar') expect(r.hasta.toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('solicitado (un formulario de Meta): sale un domingo a la madrugada aunque no quede cupo', async () => {
    const domingo = new Date('2026-10-04T06:00:00Z');
    const store = new MemoriaStore(() => domingo);
    const correo: Correo = { enviar: async () => ({ messageId: '<x>' }) };
    const deps = { store, correo, remitente: 'G', ahora: () => domingo };
    for (let i = 0; i < 5; i++) await store.registrarEnvio({ cuenta: casilla.email, para: `c${i}@x.com`, asunto: 'a' });
    expect(await enviarMail(deps, casilla, { para: 'lead@x.com', asunto: 'a', texto: 't' })).toMatchObject({ tipo: 'esperar' });
    expect(await enviarMail(deps, casilla, { para: 'lead@x.com', asunto: 'a', texto: 't' }, { solicitado: true })).toEqual({
      tipo: 'enviado',
      messageId: '<x>',
    });
    await store.agregarBaja('lead@x.com');
    expect(await enviarMail(deps, casilla, { para: 'lead@x.com', asunto: 'a', texto: 't' }, { solicitado: true })).toEqual({ tipo: 'baja' });
  });
});
