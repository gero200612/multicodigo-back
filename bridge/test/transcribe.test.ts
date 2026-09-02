import { describe, it, expect, vi } from 'vitest';
import { transcribeAudio } from '../src/transcribe.js';

const audio = new Uint8Array([1, 2, 3]);

// El generico de vi.fn es lo que le da tipo a `mock.calls[0][1]`; sin el,
// vitest infiere los argumentos de la lambda (ninguno) y la lectura queda en
// `never`.
function geminiOk(cuerpo: unknown) {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(cuerpo), { status: 200 }),
  );
}

/** La forma corta que devuelve la Interactions API cuando la salida es texto. */
function conOutputText(text: string) {
  return geminiOk({ status: 'completed', output_text: text });
}

describe('transcribeAudio', () => {
  it('devuelve el texto transcripto', async () => {
    const fetchImpl = conOutputText('  que hace el servicio de stock  ');
    const out = await transcribeAudio(audio, 'audio/ogg', {
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('que hace el servicio de stock');
  });

  it('tambien lee la forma larga, por steps', async () => {
    // El fallback existe para no quedarse mudo si `output_text` deja de venir.
    const fetchImpl = geminiOk({
      status: 'completed',
      steps: [{ content: [{ type: 'text', text: 'hola ' }, { type: 'text', text: 'que tal' }] }],
    });
    const out = await transcribeAudio(audio, 'audio/ogg', {
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBe('hola que tal');
  });

  it('le pega a la Interactions API y no a generateContent', async () => {
    // Este es el bug que rompio la transcripcion entera: el modelo correcto por
    // la puerta equivocada. La URL es la mitad del contrato.
    const fetchImpl = conOutputText('hola');
    await transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never });
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(url).not.toContain('generateContent');
  });

  it('manda el audio inline en base64 con su mime type', async () => {
    const fetchImpl = conOutputText('hola');
    await transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('gemini-3.5-transcribe');
    expect(body.input[0].type).toBe('audio');
    expect(body.input[0].mime_type).toBe('audio/ogg');
    expect(body.input[0].data).toBe(Buffer.from(audio).toString('base64'));
  });

  it('manda la api key por header y no por query string', async () => {
    const fetchImpl = conOutputText('hola');
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

  it('tira error si la interaccion no termino bien', async () => {
    // 200 con status de fallo. Sin este chequeo el sintoma seria "sin
    // transcripcion", que manda a mirar el audio en vez de la respuesta.
    const fetchImpl = geminiOk({ status: 'failed' });
    await expect(
      transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('status failed');
  });

  it('tira error si la respuesta no trae texto', async () => {
    const fetchImpl = geminiOk({ status: 'completed', steps: [] });
    await expect(
      transcribeAudio(audio, 'audio/ogg', { apiKey: 'k', fetchImpl: fetchImpl as never }),
    ).rejects.toThrow('sin transcripcion');
  });
});
