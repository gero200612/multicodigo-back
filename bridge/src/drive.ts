/**
 * Drive en vivo: lo que el agente hace sobre los archivos de Google.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.
 *
 * Vive en el bridge y no en el panel por la misma razon que los documentos
 * generados: el panel escribe SIEMPRE con el JWT del usuario, y en un turno de
 * Telegram no hay usuario conectado. El bridge ya se conecta a Postgres sin
 * RLS, asi que puede leer el refresh token de quien pidio el turno — y ademas
 * es el proceso que NO esta expuesto a internet, que es donde tiene que estar
 * la credencial permanente de una cuenta de Google.
 *
 * Este modulo habla con Google y nada mas: no toca la base, no arma prosa y no
 * decide aprobaciones. Lo que devuelve son datos; convertirlos en algo que el
 * modelo lea es del handler.
 */

/**
 * El unico scope que se pide, y a proposito.
 *
 * `drive.file` da acceso SOLO a los archivos que la app creo o que la persona
 * eligio con el Picker. Los que darian busqueda sobre todo el Drive —`drive`,
 * `drive.readonly`, `drive.metadata.readonly`— estan clasificados como
 * RESTRINGIDOS por Google: piden verificacion, evaluacion de seguridad anual y
 * calificar en una categoria de app que este producto no es. El hueco que deja
 * `drive.file` se cubre pidiendo acceso por archivo, que ademas deja el control
 * donde tiene que estar.
 */
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface DriveDeps {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /**
   * Para leer lo que no es texto: un PDF, un .docx, un .xlsx.
   *
   * Es el MISMO conversor que usan los documentos del proyecto, y no una
   * segunda forma de leer archivos: si el conversor no sabe con un tipo, el
   * agente escucha el mismo motivo venga el archivo de Drive o de Telegram.
   */
  conversorUrl?: string;
}

/**
 * El refresh token dejo de servir: la persona revoco el acceso desde su cuenta
 * de Google, o la app se desautorizo.
 *
 * Es una clase propia y no un Error suelto porque el handler hace algo distinto
 * con esto que con cualquier otra falla: BORRA la fila. Sin eso, cada turno
 * siguiente reintenta un token muerto y la persona nunca se entera de que tiene
 * que volver a conectar.
 */
export class TokenRevocado extends Error {
  constructor(detalle: string) {
    super(`la cuenta de Google ya no autoriza a este sistema: ${detalle}`);
    this.name = 'TokenRevocado';
  }
}

/**
 * Google contesto algo que hay que contarle a la persona tal cual.
 *
 * El `code` lo mira el handler para decidir el status HTTP; el mensaje esta
 * escrito para que lo lea alguien en un chat de telefono.
 */
export class ErrorDeDrive extends Error {
  constructor(
    readonly code: 'no_encontrado' | 'sin_permiso' | 'esperar' | 'google_fallo',
    message: string,
  ) {
    super(message);
    this.name = 'ErrorDeDrive';
  }
}

/** Un archivo, tal como sale de una busqueda. */
export interface ArchivoDeDrive {
  id: string;
  nombre: string;
  tipo: string;
}

const API = 'https://www.googleapis.com/drive/v3/files';
const SUBIDA = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Un access token a partir del refresh token.
 *
 * Se pide uno por operacion y no se cachea. Duran una hora y un turno dura
 * minutos, asi que un cache ahorraria una llamada HTTP a cambio de tener
 * credenciales de varias personas vivas en la memoria de un proceso que
 * atiende a todas — que es exactamente el intercambio que no conviene hacer.
 */
export async function accessToken(refresh: string, deps: DriveDeps): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.ok) {
    const cuerpo = (await res.json()) as { access_token?: string };
    if (!cuerpo.access_token) throw new ErrorDeDrive('google_fallo', 'Google no devolvio un token');
    return cuerpo.access_token;
  }

  const texto = await res.text();
  // `invalid_grant` es "te revocaron el acceso" y NO un problema de red: se
  // distingue porque la reaccion es distinta —borrar la fila— y porque
  // reintentarlo no lo va a arreglar nunca.
  if (res.status === 400 && texto.includes('invalid_grant')) {
    throw new TokenRevocado('hay que volver a conectarla en Configuracion');
  }
  throw new ErrorDeDrive('google_fallo', `Google no dio un token (${res.status})`);
}

/**
 * Canjea el codigo de OAuth por un refresh token, y averigua de que cuenta es.
 *
 * Es el unico momento en que nace la credencial permanente. El flujo que hay
 * hoy en el front devuelve un token de una hora y nada mas; para un refresh
 * token hace falta el flujo con CODIGO, y este canje —que necesita el
 * `client_secret`— es su segunda mitad.
 *
 * Quien llama tiene que haber mandado a Google con `access_type=offline` y
 * `prompt=consent`. Lo segundo no es decorativo: sin eso Google devuelve el
 * refresh token SOLO la primera vez que la cuenta autoriza la app, y el sintoma
 * seria una feature que anda para las cuentas nuevas y no para la que la pidio
 * —que es justo la de quien ya conecto Drive desde el navegador—.
 */
export async function canjearCodigo(
  code: string,
  redirectUri: string,
  deps: DriveDeps,
): Promise<{ refreshToken: string; email: string }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detalle = (await res.text()).slice(0, 200);
    // `invalid_client` casi siempre es el secret mal configurado en el
    // servidor, no algo que hizo la persona. Se dice distinto para que quien
    // mire el log no mande a nadie a reconectar una cuenta que esta bien.
    if (detalle.includes('invalid_client')) {
      throw new ErrorDeDrive('google_fallo', 'el servidor tiene mal configurada la app de Google');
    }
    throw new ErrorDeDrive('google_fallo', 'Google rechazo la autorizacion');
  }

  const cuerpo = (await res.json()) as { refresh_token?: string; access_token?: string };
  if (!cuerpo.refresh_token) {
    // Pasa cuando la cuenta ya habia autorizado la app y el pedido fue sin
    // `prompt=consent`. Se dice con esas palabras porque el arreglo no es de la
    // persona: es del pedido que arma el panel.
    throw new ErrorDeDrive(
      'google_fallo',
      'Google no devolvio un permiso permanente. Hay que pedir la autorizacion con prompt=consent.',
    );
  }

  // Con que cuenta se conecto. Es lo unico que se muestra despues, y existe
  // para que se pueda ver que se autorizo la cuenta que se queria: conectar la
  // personal en vez de la del trabajo no tiene sintoma sin esto.
  let email = '';
  if (cuerpo.access_token) {
    const quien = await doFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${cuerpo.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (quien.ok) email = ((await quien.json()) as { email?: string }).email ?? '';
  }

  return { refreshToken: cuerpo.refresh_token, email };
}

/**
 * Traduce un status de Google a algo que se pueda decir.
 *
 * El 404 es el caso interesante: con `drive.file`, "no existe" y "existe pero
 * esta app no lo tiene autorizado" son EL MISMO status, y no hay forma de
 * distinguirlos desde afuera. Por eso el mensaje no afirma que el archivo no
 * exista —seria mentira la mitad de las veces— sino que este sistema no lo ve,
 * que es lo unico que se sabe y ademas es lo que se arregla pidiendo acceso.
 */
async function comoError(res: Response, quePasaba: string): Promise<never> {
  const detalle = (await res.text()).slice(0, 300);
  if (res.status === 404) {
    throw new ErrorDeDrive(
      'no_encontrado',
      'ese archivo no esta entre los que puedo ver. Puedo pedirte acceso a el.',
    );
  }
  if (res.status === 403 && detalle.includes('rateLimitExceeded')) {
    throw new ErrorDeDrive('esperar', 'Google esta limitando los pedidos: hay que esperar un rato');
  }
  if (res.status === 403) {
    throw new ErrorDeDrive('sin_permiso', 'la cuenta de Google no tiene permiso para eso');
  }
  if (res.status === 429) {
    // No se reintenta en el turno, y es deliberado: un reintento silencioso
    // sobre una ESCRITURA la duplica, y desde aca no se sabe si la primera
    // llego a aplicarse.
    throw new ErrorDeDrive('esperar', 'Google esta limitando los pedidos: hay que esperar un rato');
  }
  throw new ErrorDeDrive('google_fallo', `${quePasaba}: Google respondio ${res.status}`);
}

/**
 * Escapa un valor para la query de `files.list`.
 *
 * La query de Drive es un lenguaje con comillas simples, asi que un nombre con
 * un apostrofo la rompe, y uno armado a proposito la puede reescribir. El
 * nombre lo propone el MODELO, que es texto libre: es justo el lugar donde esto
 * tiene que estar.
 */
function escaparQuery(valor: string): string {
  return valor.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Busca por nombre entre los archivos accesibles.
 *
 * Devolver poco es parte del diseño: el modelo elige un id de esta lista y no
 * de otro lado, asi que la lista es la superficie entera de lo que puede tocar.
 *
 * **El indice de Drive es eventualmente consistente.** Un archivo recien
 * autorizado con el Picker se puede LEER por id de inmediato y todavia no
 * aparecer aca — se verifico en el spike: `files.list` devolvio 0 y dos minutos
 * despues devolvio 1. Por eso el flujo de pedir acceso sigue con el id que
 * devuelve el Picker y NO vuelve a buscar por nombre: si lo hiciera, la persona
 * autorizaria el archivo y el agente le diria que no lo encuentra.
 */
export async function buscar(
  token: string,
  nombre: string,
  deps: DriveDeps,
): Promise<ArchivoDeDrive[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = new URL(API);
  url.searchParams.set('q', `name contains '${escaparQuery(nombre)}' and trashed = false`);
  url.searchParams.set('fields', 'files(id,name,mimeType)');
  url.searchParams.set('pageSize', '20');

  const res = await doFetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) await comoError(res, 'no pude buscar en Drive');

  const cuerpo = (await res.json()) as {
    files?: Array<{ id: string; name: string; mimeType: string }>;
  };
  return (cuerpo.files ?? []).map((f) => ({ id: f.id, nombre: f.name, tipo: f.mimeType }));
}

/** Los datos de UN archivo. Sirve para saber de que tipo es antes de leerlo. */
export async function metadatos(
  token: string,
  id: string,
  deps: DriveDeps,
): Promise<ArchivoDeDrive> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${API}/${encodeURIComponent(id)}?fields=id,name,mimeType`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) await comoError(res, 'no pude abrir ese archivo');
  const f = (await res.json()) as { id: string; name: string; mimeType: string };
  return { id: f.id, nombre: f.name, tipo: f.mimeType };
}

/**
 * Los tipos nativos de Google, que no se bajan: se EXPORTAN.
 *
 * Un Google Doc no tiene bytes propios —no hay un .docx adentro— asi que
 * `alt=media` sobre uno devuelve un 403 y no un archivo. Hay que pedirle a
 * Google que lo convierta al salir, y a que formato es una decision: un Doc a
 * texto plano se lee entero, y una planilla a CSV conserva las filas y las
 * columnas, que es lo que se le va a preguntar.
 */
const EXPORTA_COMO: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/**
 * Lo que ya es texto y se lee sin convertir nada.
 *
 * Se mira con `startsWith` para `text/`: `text/markdown`, `text/csv` y
 * `text/plain` son todos legibles y no vale la pena enumerarlos.
 */
function esTexto(tipo: string): boolean {
  return tipo.startsWith('text/') || tipo === 'application/json';
}

/** Que le pasa al conversor cada tipo binario que sabe leer. */
const AL_CONVERSOR: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * El contenido de un archivo, como texto.
 *
 * Tres caminos, porque son tres cosas distintas: los nativos de Google se
 * exportan, el texto se baja tal cual, y lo binario que el conversor conoce
 * pasa por el conversor. Lo que no entra en ninguno se dice CON EL TIPO
 * ADENTRO: "no se leer un application/zip" le permite a la persona entender que
 * pasa; "no pude leerlo" la deja sin nada que hacer.
 */
export async function leer(token: string, id: string, deps: DriveDeps): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const archivo = await metadatos(token, id, deps);

  const exportar = EXPORTA_COMO[archivo.tipo];
  if (exportar) {
    const url = `${API}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportar)}`;
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) await comoError(res, 'no pude exportar ese archivo');
    return await res.text();
  }

  if (esTexto(archivo.tipo)) {
    const res = await doFetch(`${API}/${encodeURIComponent(id)}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) await comoError(res, 'no pude bajar ese archivo');
    return await res.text();
  }

  const tipoDelConversor = AL_CONVERSOR[archivo.tipo];
  if (!tipoDelConversor) {
    throw new ErrorDeDrive(
      'google_fallo',
      `no se leer un archivo de tipo ${archivo.tipo} (${archivo.nombre})`,
    );
  }
  if (!deps.conversorUrl) {
    throw new ErrorDeDrive('google_fallo', 'este servidor no puede leer ese tipo de archivo');
  }

  const bytes = await doFetch(`${API}/${encodeURIComponent(id)}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!bytes.ok) await comoError(bytes, 'no pude bajar ese archivo');

  const res = await doFetch(
    `${deps.conversorUrl.replace(/\/$/, '')}/convertir?tipo=${tipoDelConversor}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(await bytes.arrayBuffer()) as unknown as BodyInit,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    // El 422 del conversor viene escrito para una persona ("este PDF es un
    // escaneo, no tiene texto"), asi que se propaga tal cual.
    const cuerpo = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ErrorDeDrive('google_fallo', cuerpo.message ?? `no pude leer ${archivo.nombre}`);
  }
  const cuerpo = (await res.json()) as { texto?: string };
  if (typeof cuerpo.texto !== 'string') {
    throw new ErrorDeDrive('google_fallo', `no pude leer ${archivo.nombre}`);
  }
  return cuerpo.texto;
}

/** Reemplaza el contenido de un archivo que ya existe. */
export async function escribir(
  token: string,
  id: string,
  contenido: string,
  deps: DriveDeps,
): Promise<ArchivoDeDrive> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(
    `${SUBIDA}/${encodeURIComponent(id)}?uploadType=media&fields=id,name,mimeType`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain; charset=utf-8' },
      body: contenido,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) await comoError(res, 'no pude escribir ese archivo');
  const f = (await res.json()) as { id: string; name: string; mimeType: string };
  return { id: f.id, nombre: f.name, tipo: f.mimeType };
}

/**
 * Crea un archivo nuevo.
 *
 * Lo que la app crea le queda accesible PARA SIEMPRE sin que nadie lo elija, y
 * eso es lo que hace que el ciclo "escribime este informe" -> "ahora cambiale
 * la conclusion" funcione entero sin pedir permiso en el medio.
 *
 * Se sube en dos partes —metadatos y contenido— porque `uploadType=media` solo
 * manda bytes y el archivo quedaria llamandose "Untitled".
 */
export async function crear(
  token: string,
  nombre: string,
  contenido: string,
  deps: DriveDeps,
): Promise<ArchivoDeDrive> {
  const doFetch = deps.fetchImpl ?? fetch;
  const limite = `mc${Date.now().toString(36)}`;
  const cuerpo =
    `--${limite}\r\n` +
    'content-type: application/json; charset=utf-8\r\n\r\n' +
    `${JSON.stringify({ name: nombre, mimeType: 'text/plain' })}\r\n` +
    `--${limite}\r\n` +
    'content-type: text/plain; charset=utf-8\r\n\r\n' +
    `${contenido}\r\n` +
    `--${limite}--`;

  const res = await doFetch(`${SUBIDA}?uploadType=multipart&fields=id,name,mimeType`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${limite}`,
    },
    body: cuerpo,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) await comoError(res, 'no pude crear ese archivo');
  const f = (await res.json()) as { id: string; name: string; mimeType: string };
  return { id: f.id, nombre: f.name, tipo: f.mimeType };
}

/**
 * Escribe celdas de un rango de una planilla.
 *
 * Es un camino propio y no un `escribir` con otro contenido, porque una
 * planilla no es un archivo de texto: tiene celdas, y el pedido real es "marca
 * la tarea 4 como lista". Tocar `D7` cambia `D7`; regenerar la planilla entera
 * convertiria cualquier error del modelo en la perdida de algo que alguien
 * mantiene a mano.
 *
 * `USER_ENTERED` y no `RAW`: es lo que hace que un "31/12" entre como fecha y
 * un "=SUMA(A1:A9)" como formula, o sea que el resultado se parezca a lo que
 * hubiera escrito una persona en esa celda.
 */
export async function editarPlanilla(
  token: string,
  id: string,
  rango: string,
  valores: string[][],
  deps: DriveDeps,
): Promise<number> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url =
    `${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(rango)}` +
    '?valueInputOption=USER_ENTERED';
  const res = await doFetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: valores }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) await comoError(res, 'no pude escribir en esa planilla');
  const cuerpo = (await res.json()) as { updatedCells?: number };
  return cuerpo.updatedCells ?? 0;
}

/**
 * Manda un archivo a la papelera. NO lo borra.
 *
 * Es `files.update` con `trashed: true` y no `files.delete`, y es la unica
 * asimetria con borrar en el worktree: alla el archivo esta en git y se
 * recupera de ahi, aca no hay nada atras. La papelera de Drive es el "deshacer"
 * que en el worktree da el repo.
 */
export async function borrar(token: string, id: string, deps: DriveDeps): Promise<ArchivoDeDrive> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${API}/${encodeURIComponent(id)}?fields=id,name,mimeType`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) await comoError(res, 'no pude mandar ese archivo a la papelera');
  const f = (await res.json()) as { id: string; name: string; mimeType: string };
  return { id: f.id, nombre: f.name, tipo: f.mimeType };
}
