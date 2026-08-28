const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const INSTRUCTION = [
  'Transcribi este audio en español, literal, sin agregar comentarios ni resumir.',
  'Devolve unicamente el texto transcripto.',
].join(' ');

export interface TranscribeDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export async function transcribeAudio(
  audio: Uint8Array,
  mimeType: string,
  deps: TranscribeDeps,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.apiKey },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: INSTRUCTION },
            { inline_data: { mime_type: mimeType, data: Buffer.from(audio).toString('base64') } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new Error(`gemini ${response.status}: ${await response.text()}`);

  const json = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (text.trim() === '') throw new Error('gemini devolvio sin transcripcion');
  return text.trim();
}
