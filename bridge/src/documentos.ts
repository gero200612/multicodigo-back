/**
 * Los documentos que llegan por Telegram.
 *
 * Antes, mandarle un archivo al bot no hacia NADA: el handler de mensajes
 * miraba `voice`, `audio` y `text`, y cualquier otra cosa caia en un `return`
 * sin respuesta. Ni un "no puedo con eso". Y sin embargo el sistema entero ya
 * sabia manejar documentos —la tabla, el bucket, el `_docs` del worktree— solo
 * que por el camino del panel.
 *
 * Esto conecta las dos mitades: un archivo mandado al chat termina en el MISMO
 * lugar que uno arrastrado al panel, y por lo tanto aparece en la configuracion
 * del proyecto y baja al worktree del agente igual que aquel.
 *
 * ## Por que el bridge escribe en Supabase y el panel no lo hace por el
 *
 * La primera idea fue mandarle el archivo al panel, que ya tiene todo esto
 * escrito. No se puede: el panel escribe SIEMPRE con el JWT del usuario, para
 * que RLS sea la unica autoridad, y un mensaje de Telegram no trae ningun JWT.
 * Fabricarle uno tampoco: los JWT de este proyecto se verifican contra el JWKS
 * (asimetrico), asi que firmarlos pide una clave privada que Supabase no
 * entrega.
 *
 * Queda escribir con la `service_role`, y el lugar donde eso cuesta menos es
 * este. El panel la tiene NEGADA a proposito —es el proceso expuesto a
 * internet, y la decision esta documentada desde el diseño original—, pero el
 * bridge ya se conecta al mismo Postgres como `postgres`, sin RLS: le puede
 * escribir a cualquier tabla de cualquier proyecto AHORA. Darle la service_role
 * no le agrega poder, le agrega alcance al Storage, que es la unica pieza que
 * no tiene una puerta por SQL.
 *
 * Sin `SUPABASE_SERVICE_KEY` esto queda apagado y el bot lo dice: es mejor que
 * un archivo que se acepta y se pierde.
 */

/**
 * Lo que el conversor sabe leer.
 *
 * Tiene que coincidir con `TIPOS` de `src/conversor/convertir.py` y con
 * `Documentos.Tipos` del panel. Los tres declaran lo mismo y ninguno puede
 * confiar en los otros: este rechaza antes de bajar el archivo de Telegram.
 */
export const TIPOS = ['pdf', 'xlsx', 'docx', 'csv', 'md', 'txt'] as const;

/** 20 MB, el mismo tope que el panel y el conversor. */
export const MAXIMO_BYTES = 20 * 1024 * 1024;

/** El tipo segun la extension, o undefined si no se sabe leer. */
export function tipoDe(nombreOriginal: string | undefined): string | undefined {
  if (!nombreOriginal) return undefined;
  const punto = nombreOriginal.lastIndexOf('.');
  if (punto < 0) return undefined;
  const ext = nombreOriginal.slice(punto + 1).toLowerCase();
  return (TIPOS as readonly string[]).includes(ext) ? ext : undefined;
}

/**
 * El nombre para el disco, derivado del que mando el usuario.
 *
 * Se DERIVA y no se recibe. Este string termina siendo una ruta en
 * `/srv/work/<slot>/<proyecto>/_docs/`, y el nombre de un archivo de Telegram
 * lo elige quien lo manda. Es el puerto de `Documentos.NombreDeArchivo` del
 * panel, y por las mismas razones:
 *
 *  - Lista BLANCA de caracteres, no negra: lo que no esta se vuelve guion. Una
 *    lista negra deja pasar lo que nadie penso.
 *  - Los acentos a su letra base y no descartados: "especificación" tiene que
 *    quedar "especificacion" y no "especificacin".
 *  - La extension SIEMPRE: el agente la usa para saber que es, y un archivo sin
 *    ella se ve como texto — intentaria leer el binario.
 */
export function nombreDeArchivo(nombreOriginal: string, tipo: string): string {
  // Cualquier cosa que parezca una ruta se descarta antes que nada. Es
  // REDUNDANTE con la lista blanca de abajo, y se deja igual porque esto arma
  // una ruta en disco y dos capas cuestan una linea.
  const sinRuta = nombreOriginal.split(/[/\\]/).pop() ?? '';
  const punto = sinRuta.lastIndexOf('.');
  const sinExt = punto > 0 ? sinRuta.slice(0, punto) : sinRuta;

  const limpio = sinExt
    .normalize('NFD')
    // Las marcas diacriticas, ya separadas de su letra por el NFD.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-');

  // Los guiones repetidos salen de reemplazar espacios y parentesis;
  // "informe--final-" es feo sin ninguna razon.
  const base = limpio.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');

  // Si no quedo nada usable, un nombre igual: una cadena vacia armaria la ruta
  // del directorio en vez de un archivo.
  const nombre = base === '' ? 'documento' : base;

  return nombre.toLowerCase().endsWith(`.${tipo}`) ? nombre : `${nombre}.${tipo}`;
}

export interface DocumentosDeps {
  /** La URL del proyecto de Supabase, sin barra final. */
  supabaseUrl: string;
  /**
   * La service_role.
   *
   * Se llama `serviceKey` y no `apiKey` para que quien la lea sepa que no es la
   * anon: esta pasa por encima de RLS.
   */
  serviceKey: string;
  /** Por la red del compose: http://conversor:8096. */
  conversorUrl?: string;
  fetchImpl?: typeof fetch;
}

const BUCKET = 'documentos';

/**
 * Cuanto vive una URL firmada. Una hora, igual que en el panel: tiene que
 * durar lo que dura un turno y no mas.
 */
const SEGUNDOS_DE_URL = 3600;

function cabeceras(deps: DocumentosDeps): Record<string, string> {
  return { apikey: deps.serviceKey, authorization: `Bearer ${deps.serviceKey}` };
}

/**
 * Convierte el documento a Markdown, que es lo que el agente puede leer.
 *
 * Nunca lanza: si el conversor no esta o falla, el documento se guarda igual
 * con el motivo anotado. Es la misma decision que toma el panel — perder el
 * original que la persona ya mando es peor que no poder convertirlo, y la
 * conversion se puede reintentar despues.
 */
async function convertir(
  datos: Uint8Array,
  tipo: string,
  deps: DocumentosDeps,
): Promise<{ texto?: string; error?: string }> {
  if (!deps.conversorUrl) return { error: 'el conversor no esta configurado' };
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${deps.conversorUrl.replace(/\/$/, '')}/convertir?tipo=${encodeURIComponent(tipo)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: datos as unknown as BodyInit,
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      // El 422 del conversor trae un mensaje escrito para una persona ("este
      // PDF es un escaneo"), asi que se propaga tal cual.
      const cuerpo = (await res.json().catch(() => ({}))) as { message?: string };
      return { error: cuerpo.message ?? `el conversor respondio ${res.status}` };
    }
    const cuerpo = (await res.json()) as { texto?: string };
    return typeof cuerpo.texto === 'string' ? { texto: cuerpo.texto } : { error: 'conversion vacia' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'no se pudo convertir' };
  }
}

async function subirArchivo(
  ruta: string,
  datos: Uint8Array,
  deps: DocumentosDeps,
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.supabaseUrl}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: {
      ...cabeceras(deps),
      'content-type': 'application/octet-stream',
      // Para que mandar dos veces el mismo archivo lo reemplace en vez de
      // fallar: la fila hace upsert, y sin esto las dos mitades quedarian
      // desincronizadas.
      'x-upsert': 'true',
    },
    body: datos as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${await res.text()}`);
}

export interface DocumentoGuardado {
  nombre: string;
  tipo: string;
  bytes: number;
  /** Por que no se pudo convertir, si no se pudo. El archivo se guardo igual. */
  error?: string;
}

/**
 * Guarda un documento que llego por Telegram.
 *
 * El orden es: convertir, subir el original, subir el texto, escribir la fila.
 * La fila ULTIMA a proposito — es lo que hace que el documento exista para el
 * panel y para el turno, asi que si algo falla antes, no queda una fila que
 * apunta a un archivo que no esta.
 */
export async function guardarDocumento(
  entrada: {
    proyectoId: string;
    usuarioId: string;
    nombreOriginal: string;
    datos: Uint8Array;
  },
  deps: DocumentosDeps,
): Promise<DocumentoGuardado> {
  const tipo = tipoDe(entrada.nombreOriginal);
  if (!tipo) throw new Error('tipo_desconocido');
  if (entrada.datos.byteLength > MAXIMO_BYTES) throw new Error('muy_grande');

  const nombre = nombreDeArchivo(entrada.nombreOriginal, tipo);
  const ruta = `${entrada.proyectoId}/${nombre}`;

  const { texto, error } = await convertir(entrada.datos, tipo, deps);

  await subirArchivo(ruta, entrada.datos, deps);

  let rutaTexto: string | null = null;
  if (texto !== undefined) {
    // El `.md` pegado al nombre entero y no reemplazando la extension: asi
    // `precios.xlsx` y `precios.csv` no se pisan entre si en el bucket.
    rutaTexto = `${ruta}.md`;
    await subirArchivo(rutaTexto, new TextEncoder().encode(texto), deps);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.supabaseUrl}/rest/v1/documentos`, {
    method: 'POST',
    headers: {
      ...cabeceras(deps),
      'content-type': 'application/json',
      // Upsert: mandar de nuevo el mismo archivo lo reemplaza, que es lo que la
      // persona espera al mandar una version corregida.
      prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      proyecto_id: entrada.proyectoId,
      nombre,
      nombre_original: entrada.nombreOriginal,
      ruta,
      ruta_texto: rutaTexto,
      tipo,
      bytes: entrada.datos.byteLength,
      error: error ?? null,
      // Quien lo mando, que es el usuario del panel atado a este chat. La
      // columna es NOT NULL y referencia auth.users: sin el vinculo no habria
      // documento, y sin vinculo tampoco hay turno.
      subido_por: entrada.usuarioId,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`documentos ${res.status}: ${await res.text()}`);

  return { nombre, tipo, bytes: entrada.datos.byteLength, error };
}

export interface DocumentoDelTurno {
  nombre: string;
  url: string;
  url_texto?: string | null;
}

async function firmar(ruta: string, deps: DocumentosDeps): Promise<string | undefined> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.supabaseUrl}/storage/v1/object/sign/${BUCKET}/${ruta}`, {
      method: 'POST',
      headers: { ...cabeceras(deps), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: SEGUNDOS_DE_URL }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const cuerpo = (await res.json()) as { signedURL?: string };
    if (!cuerpo.signedURL) return undefined;
    // Supabase devuelve la URL relativa al endpoint de storage; el gateway
    // corre en otro contenedor y necesita la absoluta.
    return `${deps.supabaseUrl}/storage/v1${cuerpo.signedURL}`;
  } catch {
    return undefined;
  }
}

/**
 * Los documentos del proyecto con URLs firmadas, para que el gateway los baje.
 *
 * Es el equivalente de `ParaElTurnoAsync` del panel, y existe porque los turnos
 * de Telegram no pasan por ahi. Sin esto, un documento mandado al chat se
 * guardaba y el agente igual no lo veia: `documentos` solo lo llenaba el panel.
 *
 * **Nunca lanza.** Sin documentos el turno corre igual y el agente trabaja
 * sobre el codigo, que es como funcionaba antes. Cortar un turno porque no se
 * pudo firmar una URL seria cambiar una degradacion por una caida.
 */
export async function documentosDelTurno(
  proyectoId: string,
  deps: DocumentosDeps,
): Promise<DocumentoDelTurno[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `${deps.supabaseUrl}/rest/v1/documentos?proyecto_id=eq.${proyectoId}` +
        '&select=nombre,ruta,ruta_texto&order=nombre',
      { headers: cabeceras(deps), signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];

    const filas = (await res.json()) as Array<{
      nombre: string;
      ruta: string;
      ruta_texto: string | null;
    }>;

    const salida: DocumentoDelTurno[] = [];
    for (const f of filas) {
      const url = await firmar(f.ruta, deps);
      // Sin URL no viaja: el gateway lo tomaria por un documento que no se pudo
      // bajar y anotaria un aviso por algo que ya sabemos aca.
      if (!url) continue;
      salida.push({
        nombre: f.nombre,
        url,
        url_texto: f.ruta_texto ? await firmar(f.ruta_texto, deps) : null,
      });
    }
    return salida;
  } catch {
    return [];
  }
}
