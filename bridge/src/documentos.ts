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

import type { FilaDeDocumento } from './store.js';

/**
 * Lo que el conversor sabe leer.
 *
 * Tiene que coincidir con `TIPOS` de `src/conversor/convertir.py` y con
 * `Documentos.Tipos` del panel. Los tres declaran lo mismo y ninguno puede
 * confiar en los otros: este rechaza antes de bajar el archivo de Telegram.
 */
export const TIPOS = ['pdf', 'xlsx', 'docx', 'csv', 'md', 'txt'] as const;

/**
 * Las imagenes que el agente puede VER.
 *
 * No pasan por el conversor y no tienen `.md`: el agente las abre con `Read`,
 * que el SDK procesa como imagen. Eso es mejor que un OCR — ve el diagrama, la
 * captura de pantalla o el error entero, no solo el texto que tenga adentro.
 *
 * La lista es la de formatos con soporte de vision. Un SVG o un video se
 * rechazan igual que antes: guardar algo que el agente no puede abrir es
 * aceptar un archivo para perderlo.
 */
export const TIPOS_IMAGEN = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

/** Si este tipo es una imagen, o sea: se guarda tal cual y no se convierte. */
export function esImagen(tipo: string): boolean {
  return (TIPOS_IMAGEN as readonly string[]).includes(tipo);
}

/** 20 MB, el mismo tope que el panel y el conversor. */
export const MAXIMO_BYTES = 20 * 1024 * 1024;

/** El tipo segun la extension, o undefined si no se sabe leer. */
export function tipoDe(nombreOriginal: string | undefined): string | undefined {
  if (!nombreOriginal) return undefined;
  const punto = nombreOriginal.lastIndexOf('.');
  if (punto < 0) return undefined;
  const ext = nombreOriginal.slice(punto + 1).toLowerCase();
  const aceptados: readonly string[] = [...TIPOS, ...TIPOS_IMAGEN];
  return aceptados.includes(ext) ? ext : undefined;
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
  /**
   * Donde se escriben los archivos: el directorio que el gateway tambien monta.
   *
   * Antes esto subia a Supabase Storage. Los dos procesos corren en la misma
   * maquina, asi que era mandar el archivo a internet para que el gateway lo
   * bajara — y ademas obligaba a tener la service_role cargada solo para eso.
   */
  docsRaiz: string;
  crearDir: (ruta: string) => Promise<void>;
  escribir: (ruta: string, datos: Uint8Array) => Promise<void>;
  /**
   * Registra el documento en la base.
   *
   * Se inyecta —y no se llama al store directo— por lo mismo que `escribir`:
   * asi este modulo se puede testear sin una base y sin un disco.
   */
  guardarFila: (fila: FilaDeDocumento) => Promise<void>;
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

/**
 * Deja el archivo en el disco del servidor.
 *
 * `escribir` sobrescribe: mandar dos veces el mismo archivo lo reemplaza en vez
 * de fallar. La fila de la tabla hace upsert, y si esto no hiciera lo mismo las
 * dos mitades quedarian desincronizadas.
 */
async function subirArchivo(
  ruta: string,
  datos: Uint8Array,
  deps: DocumentosDeps,
): Promise<void> {
  const destino = `${deps.docsRaiz}/${ruta}`;
  const dir = destino.slice(0, destino.lastIndexOf('/'));
  await deps.crearDir(dir);
  await deps.escribir(destino, datos);
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

  // Una imagen no se convierte: el agente la abre con `Read` y la ve. Pedirle
  // al conversor una conversion que no sabe hacer dejaria un error anotado que
  // no significa nada —"el conversor respondio 422" sobre un archivo que esta
  // perfecto—.
  const { texto, error } = esImagen(tipo)
    ? { texto: undefined, error: undefined }
    : await convertir(entrada.datos, tipo, deps);

  await subirArchivo(ruta, entrada.datos, deps);

  let rutaTexto: string | null = null;
  if (texto !== undefined) {
    // El `.md` pegado al nombre entero y no reemplazando la extension: asi
    // `precios.xlsx` y `precios.csv` no se pisan entre si en el bucket.
    rutaTexto = `${ruta}.md`;
    await subirArchivo(rutaTexto, new TextEncoder().encode(texto), deps);
  }

  // La fila por el STORE y no por la API REST con la service_role.
  //
  // Era lo ultimo que ataba los documentos a esa clave: el archivo ya iba al
  // disco, pero sin la clave el bot aceptaba el archivo y despues no lo podia
  // registrar. El bridge se conecta a la misma base como `postgres`.
  await deps.guardarFila({
    proyectoId: entrada.proyectoId,
    nombre,
    nombreOriginal: entrada.nombreOriginal,
    ruta,
    rutaTexto,
    tipo,
    bytes: entrada.datos.byteLength,
    error,
    subidoPor: entrada.usuarioId,
  });

  return { nombre, tipo, bytes: entrada.datos.byteLength, error };
}

/**
 * Los formatos en los que el agente puede pedir un documento.
 *
 * Subconjunto de `TIPOS`: son los que el conversor sabe GENERAR (ver `FORMATOS`
 * en `multicodigo-vm/src/conversor/generar.py`). `xlsx` esta afuera a proposito
 * —se puede leer y no escribir— y las imagenes tambien: un modelo produce
 * texto.
 */
export const FORMATOS_GENERABLES = ['md', 'txt', 'csv', 'docx', 'pdf'] as const;

/**
 * Los formatos que NO necesitan al conversor: el contenido ya ES el archivo.
 *
 * Es la degradacion que pide el diseño. Con el conversor caido, una sentencia
 * en `.md` se guarda igual; perderla porque un contenedor no responde, cuando
 * el contenido es el texto, no tendria sentido.
 */
const SIN_CONVERSOR: readonly string[] = ['md', 'txt'];

/**
 * Convierte el Markdown del agente en el archivo que la persona se lleva.
 *
 * Al reves que `convertir`, esta SI lanza. La diferencia no es un descuido: en
 * un documento subido hay un original de la persona que se perderia si
 * cortaramos, asi que se guarda con el error anotado. Aca no hay nada que
 * perder todavia — y guardar un `.pdf` que no es un PDF seria peor que el
 * error.
 */
async function generar(
  contenido: string,
  formato: string,
  deps: DocumentosDeps,
): Promise<Uint8Array> {
  if (!deps.conversorUrl) throw new Error('el conversor no esta configurado');
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(
    `${deps.conversorUrl.replace(/\/$/, '')}/generar?formato=${encodeURIComponent(formato)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      body: contenido,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    // El 422 del conversor trae un mensaje escrito para una persona ("este
    // servidor no puede generar un .pdf"): se propaga tal cual, porque termina
    // en la pantalla de quien lo pidio.
    const cuerpo = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(cuerpo.message ?? `el conversor respondio ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Guarda un documento que ESCRIBIO el agente.
 *
 * Es la direccion inversa de `guardarDocumento`: en vez de bytes que hay que
 * convertir a texto, llega texto que hay que convertir a bytes.
 *
 * La diferencia que importa es el `.md`: aca es la FUENTE, no una conversion.
 * El agente escribio Markdown, asi que se guarda ese mismo Markdown como
 * version de texto en vez de pasar el PDF de vuelta por el conversor — un
 * round-trip que perderia los titulos y las tablas para recuperar un texto que
 * ya estaba en la mano.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md`.
 */
export async function guardarDocumentoGenerado(
  entrada: {
    proyectoId: string;
    /** Quien pidio el turno que produjo el documento. */
    usuarioId: string;
    /** Como lo llamo el agente, sin extension. */
    nombre: string;
    /** El documento, en Markdown. */
    contenido: string;
    formato: string;
  },
  deps: DocumentosDeps,
): Promise<DocumentoGuardado> {
  const formato = entrada.formato.toLowerCase();
  if (!(FORMATOS_GENERABLES as readonly string[]).includes(formato)) {
    throw new Error('formato_desconocido');
  }
  if (entrada.contenido.trim() === '') throw new Error('documento_vacio');

  // El nombre se DERIVA, igual que el de un archivo subido: es lo que arma la
  // ruta en /srv/docs, y el agente produce texto libre.
  const nombre = nombreDeArchivo(entrada.nombre, formato);
  const ruta = `${entrada.proyectoId}/${nombre}`;

  const datos = SIN_CONVERSOR.includes(formato)
    ? new TextEncoder().encode(entrada.contenido)
    : await generar(entrada.contenido, formato, deps);

  if (datos.byteLength > MAXIMO_BYTES) throw new Error('muy_grande');

  await subirArchivo(ruta, datos, deps);

  // El `.md` SIEMPRE, y con la fuente adentro: es lo que el agente lee en el
  // proximo turno. Para un `.md` seria el mismo archivo dos veces, asi que se
  // apunta al original en vez de duplicarlo.
  let rutaTexto: string | null = `${ruta}.md`;
  if (formato === 'md') {
    rutaTexto = ruta;
  } else {
    await subirArchivo(rutaTexto, new TextEncoder().encode(entrada.contenido), deps);
  }

  await deps.guardarFila({
    proyectoId: entrada.proyectoId,
    nombre,
    nombreOriginal: nombre,
    ruta,
    rutaTexto,
    tipo: formato,
    bytes: datos.byteLength,
    subidoPor: entrada.usuarioId,
    origen: 'agente',
  });

  return { nombre, tipo: formato, bytes: datos.byteLength };
}

export interface DocumentoDelTurno {
  nombre: string;
  /** Donde esta el archivo, relativo a la raiz de documentos del servidor. */
  ruta: string;
  /** La version en texto (.md), si el conversor la pudo hacer. */
  ruta_texto?: string | null;
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

    // La ruta viaja tal cual, sin firmar nada.
    //
    // El gateway lee el archivo del disco: el panel lo dejo en un directorio
    // que los dos montan. Antes se firmaba una URL de Storage por documento
    // —dos llamadas mas por turno— para mandar un archivo entre dos procesos de
    // la misma maquina.
    return filas.map((f) => ({
      nombre: f.nombre,
      ruta: f.ruta,
      ruta_texto: f.ruta_texto,
    }));
  } catch {
    return [];
  }
}

/**
 * Un documento del proyecto tal como sale de la base, con la marca.
 *
 * Es la misma forma que viaja al gateway. `es_instruccion` es opcional porque
 * toda fila vieja la trae en `false` por el default de la columna, y porque un
 * panel sin actualizar no la manda.
 */
export interface DocumentoConMarca {
  nombre: string;
  ruta: string;
  ruta_texto?: string | null;
  es_instruccion?: boolean;
}

export interface DocumentosSeparados<T extends DocumentoConMarca> {
  /**
   * TODOS los documentos, incluido el instructivo.
   *
   * El instructivo se queda en la lista a proposito: de aca sale la copia a
   * `_docs` del worktree, que es lo que le deja al agente CITARLO ("el paso 4
   * del instructivo dice..."). Sacarlo le daria el texto en el prompt y ningun
   * archivo que nombrar.
   */
  documentos: T[] | undefined;
  /** El instructivo, si el proyecto tiene uno. */
  instrucciones: T | undefined;
}

/**
 * Separa el instructivo del proyecto del resto de los documentos.
 *
 * Vive en el bridge, y no en el panel, porque hay DOS caminos que llegan al
 * gateway: el del panel —los documentos vienen en el pedido— y el de Telegram,
 * donde el bridge los busca solo contra la base. Separar en el panel dejaria al
 * bot sin instructivo, que es justo el camino que mas se usa.
 *
 * Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md`.
 */
export function separarInstructivo<T extends DocumentoConMarca>(
  documentos: T[] | undefined,
): DocumentosSeparados<T> {
  if (!documentos) return { documentos: undefined, instrucciones: undefined };

  // El indice unico parcial de la base impide dos instructivos por proyecto,
  // asi que este `sort` no deberia decidir nada. Esta igual porque "no deberia
  // pasar" no es un comportamiento: si alguna vez hay dos, lo que no puede es
  // que el instructivo cambie de turno en turno segun como venga ordenada la
  // lista.
  const candidatos = documentos
    .filter((d) => d.es_instruccion === true)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return { documentos, instrucciones: candidatos[0] };
}
