// gemini-2.5-flash estaba hardcodeado aca y dejo de estar disponible para
// cuentas nuevas: la API contesta 404 "no longer available to new users". O
// sea que este servicio venia con una bomba de tiempo que solo se iba a notar
// con el primer audio, en produccion, meses despues de escribirlo.
//
// Se cambia por el modelo dedicado a transcribir, que es exactamente lo que
// hace esta funcion. Verificado con audio real contra la API: responde 200.
//
// Deliberadamente NO se usa un alias tipo `gemini-flash-latest`: un alias que
// se mueve solo cambiaria el comportamiento de la transcripcion sin que nadie
// toque el repo. Preferimos un 404 ruidoso el dia que este modelo se retire.
const MODEL = 'gemini-3.5-transcribe';
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
