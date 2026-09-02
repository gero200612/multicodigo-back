/**
 * Transcribe los audios que llegan por Telegram.
 *
 * ## Por que esto se reescribio entero
 *
 * La version anterior le pegaba a `models/<modelo>:generateContent` y leia la
 * respuesta de `candidates[0].content.parts`. Eso es la API de *generacion* de
 * contenido, y `gemini-3.5-transcribe` no vive ahi: es un modelo dedicado de
 * speech-to-text y se usa por la **Interactions API**. O sea que el servicio
 * pedia bien el modelo por la puerta equivocada, y TODO audio fallaba.
 *
 * El comentario que estaba aca decia "verificado con audio real contra la API:
 * responde 200". Lo que se verifico fue el modelo anterior por la puerta vieja;
 * cuando se cambio el modelo, la puerta quedo igual. Es la trampa de un
 * comentario que envejece: seguia sonando a que alguien lo habia probado.
 *
 * ## Lo que cambia y lo que no
 *
 * El audio sigue viajando INLINE, en base64, sin pasar por la Files API. Los
 * audios de Telegram son notas de voz de segundos, y subir el archivo primero
 * seria un viaje de ida y vuelta de mas por cada mensaje, mas un archivo que
 * despues hay que borrar.
 *
 * El modelo sigue siendo fijo y NO un alias tipo `-latest`: un alias que se
 * mueve solo cambiaria como se transcribe sin que nadie toque el repo.
 * Preferimos un 404 ruidoso el dia que este modelo se retire — que es
 * exactamente el fallo que ya nos paso una vez y del que salio este archivo.
 */
const MODEL = 'gemini-3.5-transcribe';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Aca habia un `system_instruction` que pedia "transcribi en español, literal".
 * NO va: el modelo lo rechaza con
 *
 *   400 {"message":"Developer instruction is not enabled for this model"}
 *
 * Verificado contra la API real, con la key de produccion (ver el registro de
 * la prueba al final de este comentario). O sea que dejarlo puesto habria
 * cambiado un fallo de transcripcion por otro, y del mismo tipo: el que solo se
 * nota con el primer audio, en produccion.
 *
 * Tampoco hace falta. `gemini-3.5-transcribe` es un modelo dedicado: transcribir
 * es lo unico que hace, y detecta el idioma solo. Las instrucciones eran para
 * cuando esto le hablaba a un modelo de proposito general, que habia que
 * convencer de no resumir.
 *
 * Prueba: un WAV de un tono de un segundo devuelve
 * `200 {"status":"completed", ...}` sin `steps` —no hay habla que transcribir—
 * y con `system_instruction` devuelve el 400 de arriba.
 */

export interface TranscribeDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * La forma de la respuesta, en lo que nos importa.
 *
 * `output_text` es la comodidad que la API ofrece cuando la salida es una sola
 * pieza de texto; `steps` es la forma completa. Se leen las dos y se prefiere
 * la primera: si algun dia deja de venir, el fallback ya esta puesto en vez de
 * que la transcripcion se vuelva vacia en silencio.
 */
interface RespuestaInteraccion {
  status?: string;
  output_text?: string;
  steps?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}

function textoDe(json: RespuestaInteraccion): string {
  if (typeof json.output_text === 'string' && json.output_text.trim() !== '') {
    return json.output_text.trim();
  }
  return (json.steps ?? [])
    .flatMap((s) => s.content ?? [])
    // Solo las partes de texto: un step puede traer otras cosas, y
    // concatenarlas a ciegas meteria basura adentro del prompt del agente.
    .filter((c) => c.type === undefined || c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

export async function transcribeAudio(
  audio: Uint8Array,
  mimeType: string,
  deps: TranscribeDeps,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(ENDPOINT, {
    method: 'POST',
    // La key por header y no en la query: una URL termina en logs, en metricas
    // y en mensajes de error, y ahi no puede haber una credencial.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.apiKey },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          type: 'audio',
          data: Buffer.from(audio).toString('base64'),
          mime_type: mimeType,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new Error(`gemini ${response.status}: ${await response.text()}`);

  const json = (await response.json()) as RespuestaInteraccion;

  // Un 200 con `status` de fallo es posible: la interaccion se creo y no
  // termino bien. Sin este chequeo el sintoma seria "sin transcripcion", que
  // manda a buscar el problema en el audio en vez de en la respuesta.
  if (json.status && json.status !== 'completed') {
    throw new Error(`gemini devolvio status ${json.status}`);
  }

  const text = textoDe(json);
  if (text === '') throw new Error('gemini devolvio sin transcripcion');
  return text;
}
