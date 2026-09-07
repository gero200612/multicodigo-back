/**
 * La corrida desatendida: dejar el bot trabajando de noche.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
 *
 * Este archivo es SOLO decisiones puras: cuando se corta, que prompt lee el
 * analista, como se cuenta lo que paso. Nada de base ni de red — eso es
 * `store.ts` y `pipeline.ts`. La separacion es lo que hace que los techos se
 * puedan testear con un reloj de mentira en vez de esperando hasta las siete.
 */

import { escaparHtml } from './codigo.js';
import { HORAS_DE_DIFERENCIA } from './horas.js';

/**
 * Por que termino una corrida.
 *
 * Es el campo que se lee PRIMERO a la mañana, y por eso son seis y no dos: la
 * diferencia entre "el analista no encontro nada mas" y "se corto en la ronda
 * 3" es la diferencia entre confiar en el resultado y tener que revisarlo. Un
 * unico "termino" convertiria las dos cosas en la misma linea.
 *
 * Espeja el CHECK de la migracion 023.
 */
export const MOTIVOS_DE_CIERRE = [
  'completo',
  'techo_rondas',
  'techo_hora',
  'cuentas_agotadas',
  'demasiados_fallos',
  'cancelada',
] as const;
export type MotivoDeCierre = (typeof MOTIVOS_DE_CIERRE)[number];

/** Una corrida, como la devuelve el store. */
export interface Corrida {
  id: string;
  chatId: number;
  proyecto: string;
  md: string;
  ronda: number;
  techoRondas: number;
  /** Hora de reloj de Argentina, `HH:MM`. */
  techoHora: string;
  fallosSeguidos: number;
  /**
   * La ultima ronda en que el analista llamo a `reportar_huecos`.
   *
   * Separa "reviso y no falta nada" de "escribio prosa y no llamo la
   * herramienta". Sin esto las dos cierran la corrida diciendo `completo`, y la
   * segunda seria una mentira. Ver el comentario de la columna en la migracion
   * 023.
   */
  huecosDeRonda?: number;
  estado: 'abierta' | 'cerrada';
  motivoDeCierre?: MotivoDeCierre;
  creadoEn: Date;
}

/**
 * Los defaults de los techos.
 *
 * Tres rondas porque el analista y el constructor pueden pasarse la noche
 * agregando y quitando lo mismo, y la tercera vuelta ya no aporta: si algo
 * quedo sin resolver en dos rondas, lo que falta es una decision humana.
 *
 * Las siete porque es la hora en que se lee el informe. Una ronda que sigue
 * despues de eso trabaja sobre algo que ya nadie va a revisar antes de usarlo.
 */
export const TECHO_RONDAS_POR_DEFECTO = 3;
export const TECHO_HORA_POR_DEFECTO = '07:00';

/**
 * Cuantas tareas seguidas pueden fallar antes de cortar.
 *
 * Es el techo que hace que "seguir con la siguiente" no sea una forma elegante
 * de quemar la noche entera contra el mismo error: veinte tareas que dependen
 * de un `pnpm install` roto fallan las veinte, una por una, gastando un turno
 * completo cada vez.
 */
export const TOPE_DE_FALLOS = 3;

const HORA = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

const UN_DIA = 24 * 60 * 60 * 1000;

/**
 * El instante en que corta el techo de hora.
 *
 * `hasta=07:00` no es una fecha: es una hora de reloj, y una corrida que
 * arranca a las 23 tiene que cortar a las 7 del dia SIGUIENTE. Se resuelve
 * contra `creadoEn` y no se guarda calculado al abrir porque asi el numero que
 * quedo en la base sigue siendo el que se dicto.
 *
 * La cuenta se hace corriendo el instante tres horas para atras, para que los
 * campos UTC del Date sean el reloj de Argentina; despues se vuelve. Es la
 * misma razon por la que `horas.ts` hace una resta en vez de usar `Intl`: lo
 * que hay es una hora suelta, no un instante que convertir.
 */
export function limiteDeHora(creadoEn: Date, techoHora: string): Date {
  const m = HORA.exec(techoHora);
  // Una hora que no matchea no puede pasar por el CHECK de la base, asi que
  // llegar aca significa que alguien la construyo a mano. Se elige no cortar
  // nunca antes que cortar en un momento inventado: los otros dos techos siguen
  // valiendo, y una corrida que dura de mas se ve; una que corta a la hora
  // equivocada parece un bug del ciclo.
  if (!m) return new Date(creadoEn.getTime() + UN_DIA * 365);

  const desfase = HORAS_DE_DIFERENCIA * 60 * 60 * 1000;
  const local = new Date(creadoEn.getTime() - desfase);
  const objetivo = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    Number(m[1]),
    Number(m[2]),
  );
  // `<=` y no `<`: abrir una corrida a las 07:00 en punto con `hasta=07:00`
  // significa "hasta las siete de mañana", no "corta ya".
  const limite = objetivo <= local.getTime() ? objetivo + UN_DIA : objetivo;
  return new Date(limite + desfase);
}

/**
 * El techo que corta, o null si todavia se puede seguir.
 *
 * Se consulta ANTES de tomar cada tarea, no solo cuando la cola se vacia. La
 * diferencia importa para dos de los tres: el de fallos tiene que cortar en
 * medio de la cola —es justo lo que viene a evitar— y el de hora tambien, para
 * que una ronda larga no siga cuando ya no sirve. El de rondas solo puede
 * cambiar en el analisis, asi que da lo mismo donde se mire.
 *
 * El orden de los `if` es el orden en que se reportan cuando coinciden, y esta
 * elegido por cual explica mejor lo que paso: que fallaron tres seguidas es
 * mas informativo que la hora, y la hora es mas informativa que un contador de
 * rondas que quedo alto de arrastre.
 */
export function techoAlcanzado(
  c: Pick<Corrida, 'ronda' | 'techoRondas' | 'techoHora' | 'fallosSeguidos' | 'creadoEn'>,
  ahora: Date,
): MotivoDeCierre | null {
  if (c.fallosSeguidos >= TOPE_DE_FALLOS) return 'demasiados_fallos';
  if (ahora.getTime() >= limiteDeHora(c.creadoEn, c.techoHora).getTime()) return 'techo_hora';
  // `>` y no `>=`: la ronda 3 con techo 3 es la ultima que se CORRE. El
  // contador se pasa a 4 al final de esa ronda y ahi si corta.
  if (c.ronda > c.techoRondas) return 'techo_rondas';
  return null;
}

/** Lo que se le puede pasar a `/corrida` adelante del MD. */
export interface OpcionesDeCorrida {
  md: string;
  techoRondas: number;
  techoHora: string;
  /**
   * Un proyecto NUEVO a crear para esta corrida.
   *
   * Ausente = se usa el proyecto activo del chat, que es el comportamiento de
   * siempre. Con nombre, el bridge lo crea si no existe y lo deja activo: es lo
   * que permite arrancar un cliente nuevo sin salir de Telegram.
   */
  proyecto?: string;
  /**
   * La organizacion de GitHub donde crear los repos.
   *
   * Tiene que ser una que la persona YA haya conectado desde el panel: lo que
   * se hereda es a que proyecto aplica una instalacion consentida, no un
   * permiso nuevo. Ver `instalacionDeCuenta` en el store.
   */
  org?: string;
  /** Los repos a crear, en el orden en que se nombraron. */
  repos: string[];
  /**
   * Repos que ya existen y se montan de REFERENCIA: se leen, no se escriben.
   *
   * Es lo que permite construir mirando un proyecto que ya funciona en vez de
   * arrancar de cero. Tienen que estar en la MISMA cuenta que los otros repos
   * del proyecto: el gateway clona todo con un solo token de instalacion, y una
   * instalacion es de una cuenta.
   */
  referencia: string[];
}

/** `rondas=3`, `hasta=07:00`, `proyecto=x`, `org=y`, `repos=a,b`. */
const OPCION = /^(rondas|hasta|proyecto|org|repos|referencia)=(\S+)$/;

/**
 * La misma forma que valida el CHECK de `repos` y el nombre de proyecto.
 *
 * Estos strings terminan siendo carpetas del worktree del lado del gateway, asi
 * que la lista blanca no es cosmetica. Es el mismo criterio que
 * `NombreDeRepoValido` del panel y que `esNombreValido` del router.
 */
const NOMBRE = /^[A-Za-z0-9._-]+$/;

function nombreSano(n: string): boolean {
  return NOMBRE.test(n) && n !== '.' && n !== '..' && n.length <= 100;
}

/**
 * Los tipos de archivo que sirven de pliego.
 *
 * Subconjunto de `TIPOS` de `documentos.ts`, y corto a proposito: son los que
 * SON texto, asi que el pliego se saca decodificando los bytes y no pasando por
 * el conversor. Un PDF o un xlsx se guardan igual como documento del proyecto
 * —eso ya funcionaba— pero no se aceptan como pliego: el pliego lo lee el
 * analista en cada ronda, y un pliego que salio de un OCR o de una tabla es un
 * pliego contra el que no se puede comparar nada.
 */
export const TIPOS_DE_PLIEGO = ['md', 'txt'] as const;

/** Cuanto puede pesar un pliego: 400 KB. */
export const TOPE_DE_PLIEGO = 400 * 1024;

/**
 * Decodifica un archivo adjunto como pliego, o dice por que no.
 *
 * `fatal: true` en el decoder es lo que importa: un `.md` que en realidad es un
 * binario mal nombrado se convertiria en un texto lleno de U+FFFD, y ese texto
 * quedaria guardado como el pliego contra el que el analista compara TODAS las
 * rondas. Es mejor rechazarlo cuando la persona esta mirando el chat.
 */
export function pliegoDeArchivo(
  nombre: string,
  datos: Uint8Array,
): { ok: true; md: string } | { ok: false; motivo: string } {
  const punto = nombre.lastIndexOf('.');
  const tipo = punto === -1 ? '' : nombre.slice(punto + 1).toLowerCase();
  if (!(TIPOS_DE_PLIEGO as readonly string[]).includes(tipo)) {
    return {
      ok: false,
      motivo:
        `no puedo usar un .${tipo || 'archivo sin extension'} como instructivo. ` +
        `Mandame un ${TIPOS_DE_PLIEGO.join(' o un ')}, o pegame el texto en el mensaje.`,
    };
  }
  if (datos.byteLength > TOPE_DE_PLIEGO) {
    return {
      ok: false,
      motivo: `ese instructivo pasa los ${TOPE_DE_PLIEGO / 1024} KB. Es mas de lo que puedo releer en cada ronda.`,
    };
  }
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(datos);
  } catch {
    return { ok: false, motivo: 'ese archivo no es texto que pueda leer (no es UTF-8).' };
  }
  if (texto.trim() === '') return { ok: false, motivo: 'ese archivo esta vacio.' };
  return { ok: true, md: texto };
}

/**
 * Parte el argumento de `/corrida` en opciones y MD.
 *
 * Las opciones se consumen SOLO de la corrida inicial de tokens de la primera
 * linea. Es lo que permite pegar un MD que empieza con un titulo sin que el
 * parser se coma nada: el primer token que no es `rondas=` ni `hasta=` termina
 * la zona de opciones, y de ahi en adelante todo es pliego.
 *
 * Un valor invalido cae al default en vez de rechazar el comando: quien pega un
 * MD de doscientas lineas y escribe mal la hora no quiere que se le devuelva un
 * error de sintaxis a las once de la noche. La respuesta del comando dice con
 * que techos quedo, asi que un default silencioso igual se ve.
 */
export function parseOpcionesDeCorrida(rest: string): OpcionesDeCorrida {
  const lineas = rest.split('\n');
  const primera = (lineas[0] ?? '').trim();
  const tokens = primera === '' ? [] : primera.split(/\s+/);

  let techoRondas = TECHO_RONDAS_POR_DEFECTO;
  let techoHora = TECHO_HORA_POR_DEFECTO;
  let proyecto: string | undefined;
  let org: string | undefined;
  let repos: string[] = [];
  let referencia: string[] = [];
  let consumidos = 0;
  for (const t of tokens) {
    const m = OPCION.exec(t);
    if (!m) break;
    consumidos += 1;
    const valor = m[2]!;
    if (m[1] === 'rondas') {
      const n = Number(valor);
      if (Number.isInteger(n) && n >= 1 && n <= 20) techoRondas = n;
    } else if (m[1] === 'hasta') {
      if (HORA.test(valor)) techoHora = valor;
    } else if (m[1] === 'proyecto') {
      if (nombreSano(valor)) proyecto = valor;
    } else if (m[1] === 'org') {
      if (nombreSano(valor)) org = valor;
    } else {
      // Los invalidos se descartan UNO POR UNO en vez de tirar la lista
      // entera: un `repos=front,back,` con una coma de mas no puede costar los
      // otros dos. El tope de 10 es para que un pegado accidental no dispare
      // veinte llamadas a GitHub — y para `referencia`, para que no se claven
      // veinte repos en el worktree de una noche.
      const lista = [
        ...new Set(valor.split(',').map((r) => r.trim()).filter(nombreSano)),
      ].slice(0, 10);
      if (m[1] === 'repos') repos = lista;
      else referencia = lista;
    }
  }

  const restoDePrimera = tokens.slice(consumidos).join(' ');
  const md = [restoDePrimera, ...lineas.slice(1)].join('\n').trim();
  return {
    md,
    techoRondas,
    techoHora,
    ...(proyecto ? { proyecto } : {}),
    ...(org ? { org } : {}),
    repos,
    referencia,
  };
}

/**
 * El prompt del turno de analisis.
 *
 * Arranca en sesion LIMPIA —quien lo llama no pasa `sessionId`— y eso es la
 * mitad del diseño: si heredara la conversacion del constructor heredaria
 * tambien sus puntos ciegos y sus justificaciones. Un agente que paso la noche
 * diciendo "listo, hecho" lee su propio trabajo con los mismos anteojos.
 *
 * Se le pide la lista por la HERRAMIENTA y no en prosa, y se lo repite: un
 * analista que escribe "parece que falta el modulo de stock" en vez de llamar
 * `reportar_huecos` se traduce en cero tareas encoladas y una corrida que
 * cierra diciendo que esta completa. Con una tool, o llamo o no llamo, y eso es
 * verificable.
 */
export function promptDeAnalisis(md: string, ronda: number): string {
  return [
    'Sos el analista de esta corrida. No construis nada: revisas.',
    '',
    `Esta es la ronda ${ronda}. Abajo esta el pliego completo de lo que hay que`,
    'construir. En el worktree esta lo que se construyo hasta ahora.',
    '',
    'Tu trabajo: leer el codigo que hay y compararlo contra el pliego, punto por',
    'punto. Buscas HUECOS: lo que el pliego pide y el codigo todavia no hace,',
    'lo que quedo a medias, y lo que esta escrito pero sin ninguna prueba que lo',
    'respalde.',
    '',
    // El analista es quien REDACTA las tareas, asi que es el que tiene que
    // nombrar la referencia: si el hueco dice "falta el modulo de stock" a
    // secas, el constructor arranca de cero. Si dice "falta el modulo de stock,
    // mira StockController.cs en la referencia", copia una estructura que ya
    // funciona.
    'Si hay repos de REFERENCIA montados —los que no se pueden escribir—, leé su',
    'INDICE.md antes de redactar los huecos. Cuando algo que falta ya exista ahi,',
    'DECILO en la tarea: "falta X; en la referencia esta resuelto en <archivo>".',
    'Eso es lo que hace que quien lo construya copie en vez de inventar.',
    '',
    'No arregles nada. No escribas ni edites archivos. Solo mira y reporta.',
    '',
    'Cuando termines de revisar, llama a la herramienta reportar_huecos con la',
    'lista. Es OBLIGATORIO: si escribis los huecos en prosa y no llamas la',
    'herramienta, nadie los recibe y la corrida cierra como si estuviera',
    'completa. Cada hueco tiene que estar redactado como una TAREA que otro',
    'agente pueda tomar sin volver a leer el pliego.',
    '',
    'Si revisaste todo y de verdad no falta nada, llama igual a reportar_huecos',
    'con la lista vacia. Eso es lo que cierra la corrida como completa.',
    '',
    '--- PLIEGO ---',
    md,
  ].join('\n');
}

/**
 * El prompt del turno de PLANIFICACION: el que arma la cola inicial.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
 *
 * Corre UNA vez, al abrir la corrida, y es lo que reemplaza a dictar las tareas
 * a mano. Usa la MISMA herramienta que el analista —`reportar_huecos`— y no una
 * nueva: en los dos casos la salida es "esta lista de cosas hay que hacer", y
 * una segunda herramienta con la misma forma seria un segundo lugar donde
 * arreglar el dia que algo falle.
 *
 * La diferencia con el analisis es contra QUE compara: el analista mira el repo
 * ya construido, este mira un repo vacio. Por eso el prompt le pide que ordene
 * por dependencias, cosa que el analista no necesita — cuando el analista corre,
 * lo que falta ya no tiene un orden natural.
 */
export function promptDePlan(md: string, referencias: readonly string[]): string {
  return [
    'Vas a planificar un proyecto nuevo. Todavia no construis nada: armas la lista.',
    '',
    'Abajo esta el pliego de lo que hay que construir. En tu worktree estan los',
    'repos del proyecto —vacios o casi— donde va a ir el trabajo.',
    ...(referencias.length > 0
      ? [
          '',
          `Y estan montados de REFERENCIA: ${referencias.join(', ')}.`,
          'Son proyectos que YA funcionan y estan ahi para que copies como estan hechos.',
          'Son de solo lectura: no los edites ni intentes commitearlos.',
          '',
          'ANTES de armar la lista, leé el INDICE.md de esos repos. Dice que existe y',
          'donde, sin que tengas que recorrerlos enteros. Para cada cosa del pliego,',
          'fijate si ahi ya esta resuelta.',
        ]
      : []),
    '',
    'Despues llama a la herramienta reportar_huecos con las tareas, en el ORDEN en',
    'que hay que hacerlas: lo que otras cosas necesitan va primero.',
    '',
    'Cada tarea tiene que poder tomarla otro agente sin volver a leer el pliego:',
    'decí que hay que hacer y donde. Cuando algo ya exista en la referencia,',
    'NOMBRALO en la tarea ("...; en la referencia esta en <archivo>"): es lo que',
    'hace que se copie una estructura que anda en vez de inventar una nueva.',
    '',
    'Entre 5 y 25 tareas. Menos es que te falto abrir el pliego; mas es que estas',
    'partiendo en pedazos que no se pueden entregar solos.',
    '',
    'Es OBLIGATORIO llamar la herramienta: si escribis la lista en prosa, nadie la',
    'recibe y no hay con que arrancar.',
    '',
    '--- PLIEGO ---',
    md,
  ].join('\n');
}

/** Lo que el informe necesita saber de las tareas de la corrida. */
export interface ResumenDeTareas {
  hechas: number;
  fallidas: number;
  pendientes: number;
  /** Lo que no salio, con la ronda en que se detecto. Para nombrarlo. */
  sinResolver: { texto: string; ronda?: number }[];
}

/** Como se cuenta cada motivo, en una linea. */
const POR_QUE: Record<MotivoDeCierre, string> = {
  completo: 'el analista no encontro huecos',
  techo_rondas: 'se alcanzo el techo de rondas',
  techo_hora: 'se alcanzo la hora de corte',
  // No es un fallo y se dice asi: si se agotaron todas las cuentas no hay nada
  // roto, hay que esperar. Contarlo como error mandaria a buscar un bug que no
  // existe.
  cuentas_agotadas: 'se agotaron los tokens de todas las cuentas',
  demasiados_fallos: `fallaron ${TOPE_DE_FALLOS} tareas seguidas`,
  cancelada: 'la cancelaste',
};

/**
 * El informe de la mañana.
 *
 * La primera linea es el motivo, y ese orden no es estetico: si dice "se
 * alcanzo el techo de rondas", el trabajo puede estar a medias aunque las 18
 * tareas figuren hechas. Poner el conteo arriba invitaria a leer "18 hechas" y
 * cerrar el chat.
 */
export function textoDeInforme(
  c: Pick<Corrida, 'proyecto' | 'ronda' | 'techoRondas'>,
  motivo: MotivoDeCierre,
  t: ResumenDeTareas,
  rama?: string,
): string {
  // Todo lo que no escribimos nosotros va escapado. El informe se manda con
  // `parse_mode: 'HTML'`, y aca entran dos textos libres: el nombre del
  // proyecto y —lo importante— el texto de cada hueco, que lo REDACTO el
  // analista. Un hueco como "el chequeo de stock < 0 falta" tiene un `<` que
  // Telegram lee como etiqueta y rechaza el mensaje ENTERO con "can't parse
  // entities": el informe de la mañana no llegaria, y ese es el unico mensaje
  // de toda la feature que no se puede perder.
  const lineas = [
    `🌙 <b>Corrida terminada</b> — ${escaparHtml(c.proyecto)}`,
    '',
    `Termino porque: ${POR_QUE[motivo]}`,
    // Las rondas CORRIDAS, no el contador: `ronda` se pasa uno de largo justo
    // cuando corta el techo —es asi como el techo se detecta— y un informe que
    // dice "rondas: 4" con techo 3 se lee como un bug del ciclo.
    `Rondas: ${Math.min(c.ronda, c.techoRondas)}`,
    `Tareas: ${t.hechas} hechas · ${t.fallidas} fallaron · ${t.pendientes} sin hacer`,
  ];

  if (t.sinResolver.length > 0) {
    lineas.push('', '<b>Quedo sin resolver:</b>');
    for (const s of t.sinResolver) {
      lineas.push(` · ${escaparHtml(s.texto)}${s.ronda !== undefined ? ` (ronda ${s.ronda})` : ''}`);
    }
  }

  // La rama es lo unico que hace accionable el informe: sin ella, "18 hechas"
  // no dice donde mirar.
  if (rama) {
    lineas.push('', `El trabajo esta en <code>${escaparHtml(rama)}</code>`);
    // Y donde VERLO andando, que es lo que uno quiere a la mañana.
    //
    // NO se arma una URL: el preview lo publica Vercel o Render cuando el push
    // llega, con un nombre que este proceso no conoce y que depende de como se
    // configuro el proyecto alla. Inventarlo seria mandar a alguien a un 404.
    // Nombrar donde buscarlo es cierto y alcanza.
    lineas.push('Si el repo esta conectado a Vercel o Render, el preview de esa rama sale ahi.');
  }
  return lineas.join('\n');
}
