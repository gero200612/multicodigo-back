import { describe, it, expect, vi } from 'vitest';
import { esperarAlGateway } from '../src/agents-client.js';

/**
 * El bridge no puede ponerse a trabajar antes que el gateway.
 *
 * `actualizar.sh` reconstruye el stack entero, y los contenedores no vuelven
 * todos juntos. Medido en el deploy del 2026-09-18:
 *
 *   22:10:45  mc-bridge      arranca y retoma la corrida
 *   22:11:01  mc-dockerproxy todavia recreandose
 *   22:11:15  el bridge pide el primer turno
 *   22:11:21  mc-gateway     se recrea SEIS SEGUNDOS DESPUES del turno
 *   22:11:24  corrida cerrada por demasiados_fallos
 *
 * Los tres fallos —`agent_start_failed` y dos `unknown_agent`— entraron en
 * nueve segundos contra un stack a medio armar. El techo de tres fallos
 * seguidos existe para cortar cuando algo anda mal de verdad, y aca corto una
 * noche entera por catorce segundos de arranque.
 */
describe('esperarAlGateway', () => {
  const deps = (impl: typeof fetch) => ({
    gatewayUrl: 'http://gw',
    token: 'token-de-prueba-16',
    fetchImpl: impl,
  });

  it('vuelve apenas el gateway contesta', async () => {
    const f = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    const ok = await esperarAlGateway(deps(f as unknown as typeof fetch), {
      intentos: 5,
      esperaMs: 1,
    });
    expect(ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  // El caso real: el gateway todavia no existe y aparece a los pocos segundos.
  it('reintenta mientras el gateway no esta, y sigue cuando aparece', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('fetch failed');
      return new Response('{"status":"ok"}', { status: 200 });
    });
    const ok = await esperarAlGateway(deps(f as unknown as typeof fetch), {
      intentos: 5,
      esperaMs: 1,
    });
    expect(ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });

  // Y no espera para siempre: un gateway que no vuelve es un problema que hay
  // que ver, no una razon para que el bridge se quede callado toda la noche.
  it('se rinde despues del tope y lo dice', async () => {
    const f = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const ok = await esperarAlGateway(deps(f as unknown as typeof fetch), {
      intentos: 3,
      esperaMs: 1,
    });
    expect(ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
  });

  // Un 502 mientras el gateway arranca no es "esta listo".
  it('un gateway que contesta mal no cuenta como listo', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 502 }));
    const ok = await esperarAlGateway(deps(f as unknown as typeof fetch), {
      intentos: 2,
      esperaMs: 1,
    });
    expect(ok).toBe(false);
  });
});
