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
import { HORAS_DE_DIFERENCIA, instanteDeReset } from './horas.js';

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

/**
 * Los cierres que NO significan "el trabajo esta hecho", y por eso se pueden
 * reanudar con `/reanudar`.
 *
 * `completo` queda afuera porque no hay nada que seguir. `cancelada` tambien,
 * y esa es la que importa justificar: la corto una persona a proposito, y
 * ofrecerle reanudarla seria ofrecerle deshacer lo que acaba de pedir.
 *
 * Los otros cuatro son todos "se corto en el medio": el trabajo que falta sigue
 * siendo valido y el que se hizo tambien. Volver a dictar el pliego seria
 * empezar de cero al lado de lo que ya esta — es lo que paso en `despacho2`
 * (2026-09-10), que cerro por tres fallas con el back entero hecho.
 */
export const SE_PUEDE_REANUDAR: readonly MotivoDeCierre[] = [
  'demasiados_fallos',
  'techo_rondas',
  'techo_hora',
  'cuentas_agotadas',
];

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
  /**
   * Los cables que quedan por conectar a mano.
   *
   * El bot crea la base y le aplica el esquema, pero las claves de esa base las
   * pone una persona en el env de la app; y un repo recien creado no esta
   * conectado a Vercel hasta que alguien lo conecta. Sin esta lista el informe
   * dice "18 tareas hechas" sobre algo que no arranca.
   */
  pendientes?: string[];
  /**
   * Lo que el planificador quiso preguntar antes de armar la cola.
   *
   * Un pliego ambiguo produce un plan sobre supuestos que nadie confirmo.
   * Preguntar cuesta un mensaje y cambia todo lo que sigue. Ver la migracion
   * 028.
   */
  preguntas?: string[];
  /** Lo que se contesto, en crudo. Ausente = todavia no contesto. */
  respuestas?: string;
  /**
   * Lo que dictamino cada uno de los cuatro analistas.
   *
   * Uno por eje como maximo: el del cierre pisa al de la ronda 1, porque lo que
   * vale es el ultimo. Vacio en una corrida vieja o en una que no llego a
   * revisar.
   */
  veredictos?: Veredicto[];
  /** Cuando se pregunto. Sin esto el tope no sobrevive a un reinicio. */
  preguntadoEn?: Date;
}

/**
 * Cuanto se espera una respuesta antes de planificar igual: 20 minutos.
 *
 * El numero sale de la tension de la feature: si estas despierto contestas en
 * minutos, y si te fuiste a dormir la corrida no puede quedarse esperando toda
 * la noche. Veinte minutos alcanzan para el primer caso sin arruinar el segundo.
 *
 * Pasado el tope el plan se arma igual, y los supuestos van al informe: es
 * peor una corrida que no hizo nada que una que hizo algo sobre una
 * interpretacion declarada.
 */
export const MINUTOS_DE_PREGUNTAS = 20;

/**
 * Lo que se guarda como "respuesta" cuando nadie contesto.
 *
 * Un centinela y no una cadena vacia: el codigo distingue "todavia no contesto"
 * de "no contesto y seguimos igual" por la PRESENCIA del campo, y una cadena
 * vacia se leeria como ausente.
 *
 * Vive en este archivo —el de las decisiones puras— y no en telegram.ts, donde
 * estaba primero: pipeline.ts lo necesita, y pipeline <- telegram <- pipeline es
 * un ciclo de modulos que en tiempo de ejecucion deja la constante en
 * `undefined`.
 */
export const SIN_RESPUESTA = '(nadie contesto: elegi lo razonable y decilo)';

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

/**
 * Cuanto se espera como MAXIMO a que vuelva una cuenta: 6 horas.
 *
 * Los limites de Anthropic se reponen cada ~5 horas, asi que 6 cubre el caso
 * normal con margen. El tope existe para el caso raro: un cartel con una hora
 * que se leyo mal, o un reset que nunca llega. Sin el, el ciclo dormiria hasta
 * mañana sin que nadie se entere.
 */
export const HORAS_DE_ESPERA = 6;

/**
 * Cuando conviene volver a intentar, si todas las cuentas estan agotadas.
 *
 * Devuelve el reset MAS CERCANO de los slots agotados, acotado por el techo de
 * hora de la corrida: esperar hasta despues del corte es dormir para nada.
 *
 * `null` significa "no esperes, cerra". Los tres casos que lo devuelven:
 *
 *  - No se sabe cuando vuelve ninguna. El cartel de Anthropic no siempre trae
 *    la hora, y esperar a ciegas seria dormir sin saber cuanto.
 *  - El primer reset cae DESPUES del techo de la corrida. La noche ya termino:
 *    lo correcto es cerrar y contarlo, no despertarse cuando ya no sirve.
 *  - El reset esta a mas de `HORAS_DE_ESPERA`. Es la red para una hora mal
 *    leida.
 *
 * Pura y con el reloj por parametro: es lo que permite probar los tres casos sin
 * esperar seis horas.
 */
export function cuandoReintentar(
  agotados: ReadonlyMap<string, { resets?: string }>,
  limiteDeLaCorrida: Date,
  ahora: Date,
): Date | null {
  const instantes = [...agotados.values()]
    .map((a) => (a.resets ? instanteDeReset(a.resets, ahora) : undefined))
    .filter((d): d is Date => d !== undefined);
  if (instantes.length === 0) return null;

  // El mas cercano: con seis cuentas, la primera que vuelve alcanza para seguir.
  const primero = new Date(Math.min(...instantes.map((d) => d.getTime())));
  if (primero.getTime() > limiteDeLaCorrida.getTime()) return null;
  if (primero.getTime() - ahora.getTime() > HORAS_DE_ESPERA * 60 * 60 * 1000) return null;
  return primero;
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
   * Si los repos a crear nacen PUBLICOS. Por defecto no.
   *
   * Los repos del bot son privados, y eso no cambia: la razon esta en
   * `panel-api/GitHubApp.cs` y sigue valiendo —privado a publico es un click,
   * publico a privado no borra lo que ya se indexo, se clono y quedo en caches
   * que nadie controla— y lo que se crea es el trabajo de un cliente.
   *
   * Existe porque un repo privado no lo puede fetchear Render sin su proveedor
   * conectado al workspace, y ese vinculo pide un click que no se puede
   * automatizar: verificado el 2026-09-09, con la app instalada en la org y
   * acceso a todos los repos, el workspace igual no ve ninguno. Con el repo
   * publico, `POST /v1/services` funciona —probado, 201—.
   *
   * Asi que la decision es explicita y por corrida. Sin la opcion, nada se
   * expone.
   */
  publico: boolean;
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

/** `rondas=3`, `hasta=07:00`, `proyecto=x`, `org=y`, `repos=a,b`, `publico=si`. */
const OPCION = /^(rondas|hasta|proyecto|org|repos|referencia|publico)=(\S+)$/;

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
  let publico = false;
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
    } else if (m[1] === 'publico') {
      // SOLO `si` prende. Un `publico=quizas` —o un `publico=true` de quien
      // piensa en ingles— deja los repos privados en vez de exponer el trabajo
      // de un cliente por un typo. El default nunca puede salir de un valor que
      // no se entendio.
      publico = valor.toLowerCase() === 'si';
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
    publico,
  };
}

/**
 * Los cuatro ejes que se revisan por separado.
 *
 * Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-10-piso-minimo-y-cuatro-analistas-design.md`.
 *
 * El orden importa y no es alfabetico: es el orden en que se leen al pie del
 * informe, de lo que mas se nota a lo que menos. Que no se puedan cargar datos
 * se ve al segundo de abrir; que falte un test no se ve nunca hasta que rompe.
 */
export const EJES = ['usuario', 'visual', 'funcionamiento', 'testeos'] as const;
export type Eje = (typeof EJES)[number];

/** Que mira cada uno, en una linea. Para los avisos del chat. */
export const QUE_MIRA: Record<Eje, string> = {
  usuario: 'si se puede usar de verdad',
  visual: 'como se ve',
  funcionamiento: 'si hace lo que dice',
  testeos: 'si esta probado',
};

/**
 * El piso minimo: lo que toda corrida tiene que cumplir, pida o no el pliego.
 *
 * ## Por que existe
 *
 * `mesas` (2026-09-10) salio de una corrida entera con los tests verdes y el
 * analista diciendo que no faltaba nada, y no habia forma de cargar datos ni de
 * mirarlo sin que doliera. No fue un bug: el sistema verificaba que se
 * construyera lo que el pliego pide, y "un panel de mesas con metricas" se
 * cumple con una tabla gris de solo lectura. El pliego no miente; le falta
 * decir lo que nadie escribe porque se da por obvio.
 *
 * ## Por que esta redactado asi
 *
 * Cada linea tiene que poder contestarse con si o no mirando el proyecto. "Que
 * se vea lindo" no es revisable —dos personas no coinciden— y un analista al
 * que se le pide eso contesta con adjetivos. "Hay estados de vacio, cargando y
 * error" si es revisable, y ademas es lo que hace que se vea bien.
 *
 * Se usa en TRES lugares, y el primero es el que mas rinde: el prompt del plan.
 * Una tarea que desde el principio dice "con su formulario de alta" cuesta lo
 * mismo que una que no lo dice; descubrirlo en la ronda 3 cuesta una ronda.
 */
const PISO: Record<Eje, readonly string[]> = {
  usuario: [
    'Se puede CARGAR, EDITAR y BORRAR desde la interfaz. Que solo se pueda mirar no alcanza.',
    'Todo lo que el back acepta tiene por donde entrar desde el front.',
    'Al abrir hay datos de ejemplo: una pantalla vacia no se puede ni evaluar ni mostrar.',
  ],
  visual: [
    'Hay una paleta y una tipografia elegidas, no el default del navegador.',
    // Lo primero que se nota cuando falta: la pantalla arranca en el contenido,
    // sin nada que diga de quien es ni que es. Una app sin marca se ve como una
    // demo, por bien resuelto que este lo de abajo.
    'Hay MARCA: un header con el nombre del producto y algo util al lado (el usuario, ' +
      'la fecha, un buscador, lo que la pantalla pida), y un footer que cierre la pagina.',
    'Cada pantalla que trae datos tiene sus estados de VACIO, CARGANDO y ERROR.',
    'Se puede usar en un telefono.',
    'Algo confirma cuando guardaste.',
    // Sin pedirlo, todo sale igual: tarjeta blanca, bordecito de color a la
    // izquierda, cero movimiento. Se reconoce de lejos como "hecho por un
    // modelo" y es justo lo que hace que no parezca un producto.
    'Esta VIVO al usarlo: sombras y cambios al pasar el mouse, transiciones donde algo ' +
      'aparece o cambia, foco visible al tabular. Una pantalla donde nada reacciona se ' +
      'siente rota aunque funcione.',
    'Y NO el molde de siempre: tarjetas blancas con una franja de color al costado, todo ' +
      'del mismo tamaño, sin jerarquia ni movimiento. Eso se reconoce de lejos como ' +
      'plantilla y no como producto.',
  ],
  funcionamiento: [
    'Cada cosa que pide el pliego existe y responde.',
    'Los errores devuelven un mensaje que se entiende, no un stack.',
    'El front no se rompe si el back no esta: avisa que no se pudo conectar.',
  ],
  testeos: [
    'Hay tests y CORRIERON VERDES con la herramienta run. "Se escribieron tests" no cuenta.',
    'Cubren el camino feliz y al menos un error de cada endpoint.',
  ],
};

/** El piso de un eje, como lineas de prompt. */
export function pisoDeEje(eje: Eje): string[] {
  return PISO[eje].map((l) => ` · ${l}`);
}

/** El piso entero, agrupado por eje. Para el plan, que los necesita a los cuatro. */
export function pisoCompleto(): string[] {
  return EJES.flatMap((eje) => [`${eje} (${QUE_MIRA[eje]}):`, ...pisoDeEje(eje)]);
}

/** Lo que un analista dictamino sobre su eje. */
export interface Veredicto {
  eje: Eje;
  cumple: boolean;
  resumen: string;
}

/**
 * El prompt del turno de analisis.
 *
 * Arranca en sesion LIMPIA —el turno lleva `sesionLimpia`— y eso es la
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
export function promptDeAnalisis(
  md: string,
  ronda: number,
  /**
   * El eje que le toca, si es uno de los cuatro.
   *
   * Ausente = el analista generico de las rondas del medio, que es el de
   * siempre y compara contra el pliego a secas.
   */
  opciones: { eje?: Eje; cierre?: boolean } = {},
): string {
  const { eje, cierre } = opciones;
  return [
    eje
      ? `Sos el analista de ${eje.toUpperCase()} de esta corrida: mirás ${QUE_MIRA[eje]}. No construis nada: revisas.`
      : 'Sos el analista de esta corrida. No construis nada: revisas.',
    '',
    ...(eje
      ? [
          // Sin esto revisa todo y contesta poco de lo suyo. Son cuatro turnos
          // justamente para que cada uno entre hondo en una cosa; un analista
          // de visual que ademas opina de los tests es el analista generico de
          // antes, pagado cuatro veces.
          'Hay otros tres analistas mirando los otros ejes. Vos mirás SOLO el tuyo:',
          'lo que caiga en el eje de otro, dejaselo.',
          '',
        ]
      : []),
    ...(cierre
      ? [
          // El peso de este turno tiene que estar dicho: es la ultima palabra
          // sobre si la corrida cierra, y un analista que no lo sabe lo trata
          // como una revision mas.
          'Esta es la revision de CIERRE: la corrida termina despues de esto. Lo que',
          'no digas ahora queda sin hacer y se lee a la mañana como terminado.',
          '',
        ]
      : []),
    `Esta es la ronda ${ronda}. Abajo esta el pliego completo de lo que hay que`,
    'construir. En el worktree esta lo que se construyo hasta ahora.',
    '',
    'Tu trabajo: leer el codigo que hay y compararlo contra el pliego, punto por',
    'punto. Buscas HUECOS: lo que el pliego pide y el codigo todavia no hace,',
    'lo que quedo a medias, y lo que esta escrito pero sin ninguna prueba que lo',
    'respalde.',
    '',
    ...(eje
      ? [
          // El piso va DESPUES del pliego-vs-codigo y no antes: primero lo que
          // se pidio, despues lo que se da por obvio. Al reves, el analista
          // llena la lista con el piso y no lee el pliego.
          'Y ademas del pliego, esto se exige SIEMPRE aunque el pliego no lo diga.',
          'Es lo que separa algo que anda de algo que se puede usar:',
          '',
          ...pisoDeEje(eje),
          '',
          'Cada punto de esa lista se contesta con si o no mirando el proyecto. Si la',
          'respuesta es no, es un hueco, y va en la lista igual que lo del pliego.',
          '',
        ]
      : []),
    // Visual y usuario MIRAN. Leyendo el codigo no se ve si algo "se ve mal" ni
    // si hay por donde cargar datos: `mesas` tenia CSS y tenia endpoints de
    // alta, y en la pantalla no habia ni color ni un solo formulario.
    ...(eje === 'visual' || eje === 'usuario'
      ? [
          'Para esto NO alcanza con leer el codigo: MIRALO. Tenes la herramienta mirar,',
          'que levanta el front —y el back del proyecto, si hay— y te devuelve capturas',
          'de pantalla en tamaño computadora y telefono. Pasale el repo del front y las',
          'rutas principales. Juzga por lo que VES en las capturas.',
          '',
          'Si no arranca, eso ya es un hueco: reportalo igual, y segui revisando el',
          'codigo como puedas.',
          '',
        ]
      : []),
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
    ...(eje
      ? [
          '',
          'Y DESPUES llama a dar_veredicto con tu eje, si cumple o no, y dos lineas de',
          'por que. Es lo que se lee firmado al pie del informe de la mañana, con tu',
          'nombre al lado. Las dos herramientas: reportar_huecos deja el trabajo',
          'encolado, dar_veredicto deja tu opinion. Son distintas y van las dos.',
          '',
          // Sin esta linea el veredicto se vuelve decorativo: el modelo pone
          // `cumple: true` y lista tres huecos, porque "en general esta bien".
          'Si encontraste aunque sea un hueco de los que exige el piso, tu veredicto es',
          'que NO cumple. No hay "cumple con observaciones".',
        ]
      : []),
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
export function promptDePlan(
  md: string,
  referencias: readonly string[],
  respuestas?: string,
): string {
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
    ...(respuestas
      ? [
          '',
          'Ya preguntaste lo que no estaba claro y esto es lo que te contestaron:',
          '',
          respuestas,
          '',
          'Planifica con eso. No vuelvas a preguntar.',
        ]
      : [
          '',
          // La puerta a preguntar, con el umbral bien alto a proposito: un
          // modelo al que se le ofrece preguntar pregunta SIEMPRE, y cada
          // pregunta es un momento en que la corrida espera a una persona que
          // puede estar durmiendo.
          'Si algo del pliego es AMBIGUO de una forma que cambiaria el plan entero —no un',
          'detalle— podes llamar UNA vez a preguntar_antes_de_planificar con hasta 3',
          'preguntas concretas, y esperar la respuesta antes de armar la lista.',
          'Usala solo si de verdad no podes decidir: si podes elegir algo razonable,',
          'elegilo y segui. Preguntar cuesta que alguien te conteste a las tres de la',
          'mañana.',
        ]),
    '',
    'Despues llama a la herramienta reportar_huecos con las tareas, en el ORDEN en',
    'que hay que hacerlas: lo que otras cosas necesitan va primero.',
    '',
    // El piso, en el plan y no solo en la revision.
    //
    // Es lo mismo que van a exigir los cuatro analistas, dicho ANTES de que se
    // construya nada. La diferencia de costo es toda: una tarea que ya dice
    // "con su formulario de alta" cuesta lo mismo que una que no lo dice, y
    // descubrirlo en la ronda 3 cuesta una ronda entera.
    '',
    'ADEMAS de lo que pide el pliego, esto se exige SIEMPRE y no hace falta que el',
    'pliego lo diga. Es lo que separa algo que anda de algo que se puede usar, y',
    'al terminar lo van a revisar cuatro analistas, uno por eje:',
    '',
    ...pisoCompleto(),
    '',
    'No son tareas aparte: son parte de las tareas que armes. Una pantalla se',
    'entrega con su forma de cargar datos y sus estados, no en dos tareas.',
    '',
    'Cada tarea tiene que poder tomarla otro agente sin volver a leer el pliego:',
    'decí que hay que hacer y donde. Cuando algo ya exista en la referencia,',
    'NOMBRALO en la tarea ("...; en la referencia esta en <archivo>"): es lo que',
    'hace que se copie una estructura que anda en vez de inventar una nueva.',
    '',
    // Las tres cosas que un planificador convierte en tareas y no lo son.
    //
    // Visto en la primera corrida real: un pliego de una app de TODO —cuatro
    // endpoints y una pantalla— salio con 17 tareas, y cinco eran estas. Sin
    // decirlo, el modelo trata "escribir tests", "correr tests" y "commitear"
    // como pasos de un proceso, y los enumera para cada repo.
    //
    // El costo no es la lista larga: cada tarea es un TURNO, con su arranque de
    // sesion y su gasto de tokens. Cinco tareas que no construyen nada son
    // cinco turnos que la noche no tenia por que pagar.
    'LO QUE NO ES UNA TAREA, y no va en la lista:',
    ' · "correr los tests" — corre los tests DENTRO de la tarea que escribio el codigo.',
    ' · "commitear" — commitea al terminar cada tarea; es parte de terminarla.',
    ' · "anotar el pendiente X" — eso se hace llamando anotar_pendiente cuando pasa,',
    '   no encolando una tarea para hacerlo.',
    'Una tarea deja CODIGO nuevo o cambiado. Si no lo deja, no va.',
    '',
    'Entre 4 y 15 tareas. Menos es que te falto abrir el pliego; mas es que estas',
    'partiendo en pedazos que no se pueden entregar solos, o contando como tareas',
    'cosas que son parte de hacer una.',
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
 * El texto de una tarea, acortado para el informe.
 *
 * Las tareas las redacta el analista y salen largas —parrafos con rutas de
 * archivo, nombres de componentes y el por que— porque estan escritas para que
 * otro AGENTE las tome sin contexto. En el informe eso se lee al reves: cinco
 * tareas sin resolver ocupan la pantalla entera de un telefono y tapan lo unico
 * que importa a la mañana, que es CUALES quedaron.
 *
 * El detalle no se pierde: sigue entero en la cola, y `/cola` lo muestra.
 */
function enUnaLinea(texto: string, tope = 120): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  if (plano.length <= tope) return plano;
  // Se corta en el ultimo espacio para no partir una palabra al medio.
  const corte = plano.lastIndexOf(' ', tope);
  return `${plano.slice(0, corte > tope * 0.6 ? corte : tope)}…`;
}

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
  pendientes?: readonly string[],
  publicados?: readonly { repo: string; url: string }[],
  veredictos?: readonly Veredicto[],
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
      lineas.push(
        ` · ${escaparHtml(enUnaLinea(s.texto))}${s.ronda !== undefined ? ` (ronda ${s.ronda})` : ''}`,
      );
    }
  }

  // Los cables sueltos, ANTES de la rama.
  //
  // Van al final del informe y no al principio porque el motivo de cierre sigue
  // siendo lo primero que hay que leer. Pero van DESPUES del conteo y no
  // mezclados con los huecos, porque son de otra clase: un hueco es trabajo que
  // falta hacer, esto es un cable que falta conectar — y lo segundo lo tiene que
  // hacer una persona, hoy, o el sistema no arranca.
  //
  // Sin esta seccion el informe dice "18 tareas hechas" sobre algo que no
  // levanta, y averiguar por que es media hora mirando tres paneles.
  // Lo que SI quedo andando, arriba de lo que falta.
  //
  // Solo si hay algo: una corrida que fallo no gana una seccion vacia que haya
  // que interpretar. Y la URL va COMPLETA y sola en su linea porque es lo
  // primero que se toca a la mañana — en un chat de telefono, un link adentro
  // de un parrafo es un link que no se encuentra.
  if (publicados && publicados.length > 0) {
    lineas.push('', '<b>Publicado:</b>');
    for (const p of publicados) {
      lineas.push(` · ${escaparHtml(p.repo)} → ${escaparHtml(p.url)}`);
      // Decia "se actualiza solo en cada push", y dejo de ser cierto cuando los
      // servicios pasaron a crearse con `autoDeploy: 'no'` (ver render-api.ts).
      // Un informe que promete un despliegue automatico que no existe manda a
      // buscar por que "no se actualizo" algo que nadie iba a actualizar.
      lineas.push('   (main, desplegado recien; los push que vengan no se despliegan solos)');
    }
  }

  if (pendientes && pendientes.length > 0) {
    lineas.push(
      '',
      '<b>Para que ande, falta que hagas esto:</b>',
      // Acortados por lo mismo que los huecos: un pendiente que trae la salida
      // cruda de git —con sus `hint:` y su "See the Note about fast-forwards"—
      // ocupa media pantalla y no dice nada mas que la primera linea.
      ...pendientes.map((p) => ` · ${escaparHtml(enUnaLinea(p))}`),
    );
  }

  // Lo que dijeron los cuatro, firmado.
  //
  // Va al pie y no arriba porque el motivo de cierre sigue siendo lo primero
  // que hay que leer. Pero es lo que contesta la pregunta que uno se hace de
  // verdad a la mañana —"¿esto se puede abrir y usar?"— que el conteo de tareas
  // no contesta: `mesas` cerro con todas las tareas hechas y no se podia usar.
  //
  // El eje que NO contesto se nombra igual. Un veredicto ausente que
  // desaparece del informe se lee como aprobado, y esa es exactamente la falla
  // silenciosa que los cuatro existen para evitar.
  if (veredictos && veredictos.length > 0) {
    lineas.push('', '<b>Los cuatro analistas:</b>');
    for (const eje of EJES) {
      const v = veredictos.find((x) => x.eje === eje);
      if (!v) {
        lineas.push(` · ❔ ${eje} — no llego a dar su veredicto`);
        continue;
      }
      lineas.push(` · ${v.cumple ? '✅' : '⚠️'} ${eje} — ${escaparHtml(v.resumen)}`);
    }
  }

  // Y como seguir, cuando el cierre no fue "esta hecho".
  //
  // Va DESPUES de todo lo demas a proposito: es lo ultimo que se lee y lo
  // primero que se hace. Sin esta linea, la unica salida visible de una corrida
  // que se corto en el medio era volver a dictar el pliego entero, que empieza
  // de cero al lado del trabajo que ya esta.
  //
  // Solo si quedo algo por hacer: ofrecer reanudar una corrida que se corto por
  // la hora con todas sus tareas listas es mandar a alguien a mirar una cola
  // vacia.
  if (SE_PUEDE_REANUDAR.includes(motivo) && t.fallidas + t.pendientes > 0) {
    lineas.push(
      '',
      `Quedaron ${t.fallidas + t.pendientes} sin hacer. Con <b>/reanudar</b> sigo desde ahi, ` +
        'sin repetir lo que ya esta.',
    );
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

/**
 * El prompt de una tarea que corre adentro de una corrida.
 *
 * ## Por que hace falta decirlo
 *
 * En la corrida `saludos3` del 2026-09-09, la tarea de `c1` contesto "Quiero
 * commitear esto. ¿Aprobás el commit?" y nadie contesto —eran las 13:24 de una
 * corrida desatendida, a nadie le tocaba— asi que el trabajo quedo sin
 * commitear y la tarea se conto como hecha.
 *
 * Lo importante: **el agente NO estaba bloqueado**. `policy.ts` devuelve `free`
 * para `git_commit` en modo `desatendido`; tenia la herramienta libre y eligio
 * preguntar. Un permiso suelto no es una instruccion, y el modelo no tiene forma
 * de saber que del otro lado no hay nadie: en un turno normal de Telegram,
 * preguntar es lo correcto.
 *
 * `pidePermisoParaCommitear` en `respuesta.ts` es la red que evita contar eso
 * como trabajo hecho. Esto es lo que evita que pase.
 *
 * La tarea va al FINAL, y no es estetico: es lo que hay que hacer, y lo ultimo
 * que se lee es lo que mas pesa. El aviso es contexto.
 */
export function promptDeTareaDesatendida(texto: string, numero?: number): string {
  return [
    'Esto corre en una corrida desatendida: del otro lado no hay nadie despierto',
    'para contestarte, asi que una pregunta tuya no la va a leer nadie hasta la',
    'mañana y el turno se cierra igual.',
    '',
    'Tenes commit y push habilitados en este modo. Usalos: cuando el trabajo de la',
    'tarea este listo, commitealo vos y segui. NO pidas aprobacion para commitear',
    'ni preguntes si conviene hacerlo — si lo dejas sin commitear, se pierde.',
    '',
    // El mensaje del commit se escribia como un informe: parrafos, listas de
    // archivos, el detalle de cada decision. Eso ya viaja en la respuesta del
    // turno, que es donde se lee. En la historia del repo estorba: `git log`
    // deja de servir para ver de un vistazo que paso.
    'El mensaje del commit va CORTO, en una linea:',
    numero === undefined
      ? '  "<que hiciste, en una oracion>"'
      : `  "tarea ${numero}: <que hiciste, en una oracion>"`,
    'Nada de listas ni parrafos ahi: el detalle va en tu respuesta, que es donde se lee.',
    '',
    '',
    // La respuesta del turno es lo que llega al chat como "✅ <tarea>". Venia
    // como un informe de ingenieria: listas de archivos, rutas con numero de
    // linea, fragmentos de codigo, la justificacion de cada decision. A la
    // mañana eso se lee en un telefono, una tarea atras de otra, y tapa lo
    // unico que se quiere saber de un vistazo: que quedo hecho.
    //
    // El detalle no hace falta pedirlo: esta en el commit y en el repo.
    'CUANDO TERMINES, contesta asi:',
    '',
    'Un parrafo corto —tres o cuatro oraciones— contando QUE quedo hecho, en',
    'castellano y en palabras. Sin codigo, sin listas, sin nombres de archivo ni',
    'rutas, sin numeros de linea. Se lee en un telefono a la mañana, no es un',
    'informe tecnico: lo que hiciste ya esta en el commit y en el repo.',
    '',
    'Y si algo te bloqueo de verdad, una linea aparte DEBAJO del parrafo, que',
    'empiece con "Problema:". Solo si es algo que una persona tiene que resolver',
    '—una credencial que falta, una decision que no te corresponde—. Si no hubo',
    'ninguno, no escribas nada: no hace falta aclarar que salio todo bien.',
    '',
    'La tarea:',
    '',
    texto,
  ].join('\n');
}
