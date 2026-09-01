import { describe, expect, it, vi } from 'vitest';
import { firmarToken } from '../src/panel-client.js';

const DEPS = { panelUrl: 'http://panel:8091', token: 'bridge-api-token-largo' };

const respuesta = (cuerpo: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(cuerpo), { status })) as unknown as typeof fetch;

describe('pedirle al panel que firme un token', () => {
  it('manda el installation_id y devuelve el token', async () => {
    const fetchImpl = respuesta({ token: 'ghs_elToken' });

    const token = await firmarToken(42, { ...DEPS, fetchImpl });

    expect(token).toBe('ghs_elToken');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://panel:8091/interno/github/token');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ installation_id: 42 });
  });

  it('se autentica con el bearer que comparte con el panel', async () => {
    const fetchImpl = respuesta({ token: 'ghs_x' });

    await firmarToken(42, { ...DEPS, fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer bridge-api-token-largo',
    );
  });
});

describe('nunca lanza, porque el turno tiene que seguir', () => {
  // Sin token el gateway usa SSH con la deploy key. Que el panel este caido
  // degrada el push; no puede dejar sin respuesta a alguien que escribio por
  // Telegram — que es justo el camino que se usa cuando algo ya anda mal.
  it('el panel caido devuelve undefined', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(firmarToken(42, { ...DEPS, fetchImpl })).resolves.toBeUndefined();
  });

  it('un 401 devuelve undefined', async () => {
    await expect(
      firmarToken(42, { ...DEPS, fetchImpl: respuesta({ code: 'unauthorized' }, 401) }),
    ).resolves.toBeUndefined();
  });

  it('un cuerpo sin token devuelve undefined', async () => {
    await expect(
      firmarToken(42, { ...DEPS, fetchImpl: respuesta({ token: null }) }),
    ).resolves.toBeUndefined();
  });

  it('un cuerpo que no es JSON devuelve undefined', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(firmarToken(42, { ...DEPS, fetchImpl })).resolves.toBeUndefined();
  });
});
