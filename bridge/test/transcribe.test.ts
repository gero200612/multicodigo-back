import { describe, it, expect, vi } from 'vitest';
import { transcribeAudio } from '../src/transcribe.js';

const audio = new Uint8Array([1, 2, 3]);

// El generico de vi.fn es lo que le da tipo a `mock.calls[0][1]`; sin el,
// vitest infiere los argumentos de la lambda (ninguno) y la lectura queda en
// `never`.
function geminiOk(text: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
        status: 200,
      }),
  );
}

describe('transcribeAudio', () => {
  it('devuelve el texto transcripto', async () => {
    const fetchImpl = geminiOk('  que hace el servicio de stock  ');
    const out = await transcribeAudio(audio, 'audio/ogg', {
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('que hace el servicio de stock');
  });

  it('manda el audio en base64 con su mime type', async () => {
    const fetchImpl = geminiOk('hola');
    await transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    const inline = body.contents[0].parts[1].inline_data;
    expect(inline.mime_type).toBe('audio/ogg');
    expect(inline.data).toBe(Buffer.from(audio).toString('base64'));
  });

  it('manda la api key por header y no por query string', async () => {
    const fetchImpl = geminiOk('hola');
    await transcribeAudio(audio, 'audio/ogg', { apiKey: 'secreta', fetchImpl: fetchImpl as never });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain('secreta');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('secreta');
  });

  it('tira error si gemini responde no-ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 429 }));
    await expect(
      transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('gemini 429');
  });

  it('tira error si la respuesta no trae texto', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    await expect(
      transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('sin transcripcion');
  });
});
