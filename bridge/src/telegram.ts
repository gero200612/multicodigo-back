import { Bot, InlineKeyboard } from 'grammy';
import type { AgentId, ApprovalDecision, ApprovalRequest } from '@multicodigo/shared';
import type { PipelineDeps, PipelineOutcome, LoCreado } from './pipeline.js';
import {
  handleIncoming,
  armarMenu,
  armarMenuDeAgentes,
  correrCola,
  planificarCorrida,
} from './pipeline.js';
import {
  parseMenuData,
  tecladoDePermisos,
  tecladoDeModelos,
  NOMBRE_DE_MODO,
  NOMBRE_DE_MODELO,
  tecladoDePlan,
  tecladoDeDesvincular,
  tecladoDeConfirmarDesvinculo,
  type MenuData,
} from './menu.js';
import { saludo, encabezadoDeMenu, NOMBRE } from './identidad.js';
import { MAXIMO_BYTES, TIPOS, TIPOS_IMAGEN, esImagen, tipoDe } from './documentos.js';
import type { Boton } from './render.js';
import type { ModoPermiso, ClaveDeModelo, Proyecto } from './store.js';
import type { Tarea } from './cola.js';
import {
  pliegoDeArchivo,
  TECHO_HORA_POR_DEFECTO,
  TECHO_RONDAS_POR_DEFECTO,
  TOPE_DE_PLIEGO,
  TOPE_DE_FALLOS,
  type Corrida,
  type ResumenDeTareas,
} from './corrida.js';
import { escaparHtml } from './codigo.js';
import { startWatching } from './approvals.js';
import { parseApprovalData, renderApproval, type BotonKind } from './render.js';
import { decidir } from './decisiones.js';
import type { Store } from './store.js';

export function renderOutcome(outcome: PipelineOutcome): string {
  switch (outcome.kind) {
    case 'answer':
      // Sin repetir la transcripcion del audio. Estaba como "🎙 te escuche: …"
      // para mostrar que se habia entendido bien, pero en el uso real es
      // ruido: el que acaba de hablar ya sabe lo que dijo, y en la pantalla de
      // un telefono esas lineas empujan la respuesta —lo unico que se vino a
      // leer— fuera de la vista.
      //
      // Si la transcripcion sale mal se nota igual, porque la respuesta va a
      // hablar de otra cosa.
      return `🤖 ${outcome.agent.toUpperCase()}${avisoDeRelevo(outcome.relevos)}\n\n${outcome.text}`;
    case 'switched':
      return `Listo, ahora le hablás a ${outcome.agent.toUpperCase()}.`;
    case 'status':
      return outcome.corrida
        ? textoDeCorridaEnCurso(
            outcome.corrida,
            outcome.tareas!,
            outcome.haciendo,
            outcome.limite,
          )
        : textoDeActivos(outcome.agent, outcome.otros);
    case 'cowork':
      return textoDeActivos(outcome.primario, outcome.otros);
    case 'permisos':
      return textoDePermisos(outcome.modo, outcome.cambiado);
    case 'modelo':
      return textoDeModelo(outcome.modelo, outcome.cambiado);
    case 'cola':
      return textoDeCola(outcome.tareas, outcome.encoladas, outcome.agente);
    case 'corrida':
      return textoDeCorrida(
        outcome.corrida,
        outcome.recienAbierta,
        outcome.yaHabia,
        outcome.creado,
      );
    case 'corrida_paso':
      return textoDePaso(outcome.paso, outcome.error, outcome.creado);
    case 'corrida_planificando':
      // Un placeholder: el plan de verdad llega cuando el turno termina, y eso
      // tarda minutos. Sin este mensaje, el chat queda mudo justo despues de
      // mandar el pliego y parece que se colgo.
      return [
        `🌙 Corrida abierta en <b>${escaparHtml(outcome.corrida.proyecto)}</b>.`,
        '',
        'Estoy leyendo el pliego y armando el plan. Tarda unos minutos.',
      ].join('\n');
    case 'corrida_sin_armar':
      return [
        `No pude arrancar la corrida: ${escaparHtml(outcome.motivo)}`,
        '',
        // Lo que NO paso es lo importante: sin esta linea queda la duda de si
        // hay algo a medias esperando la noche.
        'No abri ninguna corrida.',
      ].join('\n');
    case 'cola_cancelada': {
      // La corrida se nombra APARTE de las tareas: cerrarla es lo que impide
      // que el ciclo vuelva a rellenar la cola, y quien cancela a las dos de la
      // mañana necesita leer que eso paso. "Saque 4 tareas" a secas dejaria la
      // duda de si el bot va a seguir solo.
      const cola =
        outcome.cuantas === 0
          ? 'No habia nada esperando en la cola.'
          : `Listo, saque ${outcome.cuantas} tarea(s) de la cola. Lo que ya estaba corriendo sigue.`;
      return outcome.corridaCerrada ? `${cola}\n\nY cerre la corrida: no voy a seguir sola.` : cola;
    }
    case 'menu':
      // `/start` se presenta; `/menu` no. Ver `identidad.ts`.
      return outcome.saluda ? saludo() : encabezadoDeMenu();
    case 'project':
      return textoDeProyecto(outcome.project, outcome.mios ?? [], outcome.cambiado ?? false);
    case 'project_desconocido':
      return [
        `No tenes ningun proyecto que se llame <b>${escaparHtml(outcome.pedido)}</b>.`,
        '',
        // Se dice que NO se cambio nada. Sin esta linea queda la duda de si el
        // chat quedo apuntando a algo raro, que es justo lo que pasaba antes.
        'No cambie nada: seguis donde estabas.',
        '',
        outcome.mios.length > 0
          ? 'Elegi uno de estos:'
          : 'Todavia no perteneces a ningun proyecto. Crealo desde el panel.',
      ].join('\n');
    case 'ocupado':
      return textoDeOcupado(outcome.agent, outcome.quien, outcome.desde, outcome.esperandoOk);
    case 'error':
      return `⚠️ ${outcome.text}`;
    case 'ignored':
      return '';
    case 'sin_vincular':
      return outcome.yaEstaba
        ? [
            'Este chat ya esta vinculado a tu cuenta.',
            '',
            'Si queres atarlo a otra, primero desvincula este.',
          ].join('\n')
        : 'No te tengo vinculado a ninguna cuenta. Mandame /vincular y te doy un codigo para pegar en el panel.';
    case 'codigo':
      return (
        `Tu codigo es:\n\n<code>${outcome.codigo}</code>\n\n` +
        `Pegalo en el panel, en Configuracion. Vence en ${outcome.minutos} minutos.`
      );
    case 'menu_proyectos':
      return 'Elegi un proyecto:';
    case 'menu_agentes':
      return (
        `Agentes de <b>${escaparHtml(outcome.proyecto)}</b>:\n\n` +
        '● listo · ○ apagado · ⚠ sin cuenta · ⛔ sin tokens'
      );
    case 'sin_proyectos':
      return 'Todavia no pertenecés a ningun proyecto. Creá uno desde el panel y volvé.';
    case 'elegido':
      // El tick y el slot en la primera linea, como etiqueta de estado y no
      // como frase: lo que se busca al volver al chat es "con cual estoy
      // hablando", y eso tiene que leerse de un vistazo.
      return (
        `✅ <b>${outcome.agente.toUpperCase()} conectado</b>\n` +
        // El nombre del agente lo escribe la persona en el panel, asi que es
        // texto libre que termina en un mensaje con formato.
        `${escaparHtml(outcome.nombre)} · <i>${escaparHtml(outcome.proyecto)}</i>\n\n` +
        'Escribime lo que querés que haga.'
      );
  }
}

/**
 * Con quien estas trabajando.
 *
 * El primario primero y marcado como tal: es a quien le llega lo que escribas
 * sin prefijo, y confundirlo es mandarle un pedido al agente equivocado. Los
 * otros van con el comando al lado —`/c2`— porque saber que estan no sirve si
 * no se sabe como hablarles.
 */
export function textoDeActivos(primario: AgentId, otros: AgentId[]): string {
  const cabeza = `Le hablas a ${primario.toUpperCase()}.`;
  if (otros.length === 0) {
    return `${cabeza}\n\nCon /cowork c2 sumas otro agente a este chat y le hablas con /c2.`;
  }
  const lista = otros.map((a) => `· ${a.toUpperCase()} — escribile con /${a}`).join('\n');
  return `${cabeza}\n\nTambien tenes en este chat:\n${lista}\n\nCon /cowork ${otros[0]} lo sacas.`;
}

/**
 * El modo de permisos, explicado.
 *
 * Cada modo dice QUE deja pasar sin preguntar, y los tres repiten que git
 * pregunta siempre. Repetirlo en los tres es a proposito: es la excepcion que
 * sorprende, y quien elige "aprobar todo" tiene que leerla justo ahi y no en
 * otro mensaje.
 */
export function textoDePermisos(modo: ModoPermiso, cambiado: boolean): string {
  const cabeza = cambiado ? 'Listo, cambie el modo.' : 'Asi estan tus permisos.';
  const que: Record<ModoPermiso, string> = {
    preguntar: 'Te pregunto antes de escribir, editar y correr tareas.',
    ediciones: 'Escribo y edito archivos sin preguntarte. Para correr tareas te pregunto.',
    todo: 'Escribo, edito y corro tareas sin preguntarte.',
  };
  return [
    cabeza,
    '',
    `<b>${NOMBRE_DE_MODO[modo]}</b>`,
    que[modo],
    '',
    'Commit y push te los pregunto SIEMPRE, en cualquier modo: salen de la maquina y ' +
      'quedan en la historia del repo.',
    'Y nunca toco un .env ni nada fuera del proyecto, elijas lo que elijas.',
  ].join('\n');
}

/**
 * El cartel de que contesto otro agente.
 *
 * Va pegado al nombre y en la MISMA linea, no como un parrafo aparte: es una
 * aclaracion sobre quien firma la respuesta, y abajo del texto se leeria
 * despues de haber asumido que hablabas con el de antes.
 *
 * Se dice porque el hilo NO se muda con el relevo. El que sigue arranca una
 * sesion nueva con el contexto reinyectado como texto —el transcript vive en el
 * HOME del slot viejo y no se puede resumir desde otro, ver relevo.ts— asi que
 * se pierde el razonamiento intermedio. Quien escriba el proximo mensaje tiene
 * que saber que le esta hablando a otro.
 *
 * Solo los DOS extremos y no la cadena entera: con varios saltos, lo que
 * importa es quien te habla ahora y de donde venia; el medio es historia.
 */
export function avisoDeRelevo(relevos: string[] | undefined): string {
  if (!relevos || relevos.length === 0) return '';
  const desde = relevos[0]!.split(' -> ')[0]!.toUpperCase();
  const hasta = relevos[relevos.length - 1]!.split(' -> ')[1]!.toUpperCase();
  return ` · sigue ${hasta} porque ${desde} se quedo sin tokens`;
}

/**
 * Como va la cola.
 *
 * Se muestra lo que FALTA y lo que esta corriendo, no el historial completo:
 * en un chat lo que importa es cuanto queda. Lo ya hecho se cuenta en una
 * linea, que alcanza para saber que avanzo.
 */
export function textoDeCola(tareas: Tarea[], encoladas: number, agente?: AgentId): string {
  const pendientes = tareas.filter((t) => t.estado === 'pendiente');
  const corriendo = tareas.find((t) => t.estado === 'corriendo');
  const hechas = tareas.filter((t) => t.estado === 'lista').length;
  const fallidas = tareas.filter((t) => t.estado === 'fallida').length;

  if (tareas.length === 0) {
    return [
      'La cola esta vacia.',
      '',
      'Mandame <b>/cola</b> y abajo la lista de cosas que hay que hacer, una por linea.',
      'Las voy haciendo en orden y te aviso al terminar cada una.',
      '',
      // El punto de descubrimiento de /corrida: quien esta mirando la cola
      // vacia es justo quien tiene trabajo para dictar.
      'Si es un proyecto entero y lo queres dejar toda la noche, mandame <b>/corrida</b>',
      'con el pliego: cuando la cola se vacie reviso contra el pliego y sigo sola.',
    ].join('\n');
  }

  const lineas: string[] = [];
  if (encoladas > 0) {
    lineas.push(
      `Anote ${encoladas} tarea(s)${agente ? ` para ${agente.toUpperCase()}` : ''}. Arranco.`,
      '',
    );
  }
  if (corriendo) lineas.push(`▶ Haciendo: ${escaparHtml(corriendo.texto)}`, '');
  if (pendientes.length > 0) {
    lineas.push('<b>Falta:</b>');
    // Numeradas porque ACA el orden es real: se hacen en esta secuencia.
    pendientes.forEach((t, i) => lineas.push(`${i + 1}. ${escaparHtml(t.texto)}`));
  } else if (!corriendo) {
    lineas.push('No queda nada pendiente.');
  }
  if (hechas > 0 || fallidas > 0) {
    lineas.push('', `Hechas: ${hechas}${fallidas > 0 ? ` · fallaron: ${fallidas}` : ''}`);
  }
  if (pendientes.length > 0) lineas.push('', 'Con /cancelar corto lo que falta.');
  return lineas.join('\n');
}

/**
 * El proyecto activo del chat, y a que otro se puede pasar.
 *
 * La lista va SIEMPRE, tambien cuando se acaba de cambiar: el mensaje que dice
 * "estas en X" es el mismo momento en que uno se pregunta "¿y los otros?".
 * Antes esto era un `Proyecto activo: X.` pelado, y para cambiar habia que
 * saber de memoria el nombre exacto —con sus mayusculas— de un proyecto que no
 * se ve en ningun lado del chat.
 */
export function textoDeProyecto(
  activo: string,
  mios: Proyecto[],
  cambiado: boolean,
): string {
  const lineas = [
    cambiado
      ? `Listo, estas trabajando en <b>${escaparHtml(activo)}</b>.`
      : `Estas trabajando en <b>${escaparHtml(activo)}</b>.`,
  ];

  const otros = mios.filter((p) => p.nombre !== activo);
  if (otros.length > 0) {
    lineas.push('', 'Podes pasarte a:');
  } else if (mios.length <= 1) {
    // Con un solo proyecto no hay nada que elegir, y ofrecer una lista de uno
    // seria ruido. Se dice que es el unico para que no parezca que falta algo.
    lineas.push('', 'Es el unico que tenes.');
  }
  return lineas.join('\n');
}

/**
 * Lo que hay que contestar en cada paso del `/corrida` conversacional.
 *
 * Cada mensaje pide UNA cosa. Es lo que reemplaza a explicar como se arma un
 * comando de cinco opciones: quien lo lee no tiene que entender la sintaxis,
 * solo contestar lo que se le pregunta.
 */
export function textoDePaso(
  paso: 'nombre' | 'pliego',
  error?: string,
  creado?: LoCreado,
): string {
  if (paso === 'nombre') {
    return [
      ...(error ? [`⚠️ ${escaparHtml(error)}.`, ''] : ['🌙 <b>Arrancamos una corrida.</b>', '']),
      '¿Como se llama el proyecto?',
      '',
      // Se dice QUE se va a hacer con el nombre: sin esto, "acme" parece una
      // etiqueta y no la raiz de dos repos que van a existir de verdad.
      'Con ese nombre creo el proyecto y dos repos: <code>&lt;nombre&gt;-front</code> y',
      '<code>&lt;nombre&gt;-back</code>. Escribilo sin espacios ni acentos.',
      '',
      // La salida, dicha SIEMPRE y no solo cuando algo falla.
      //
      // Mientras esto espera, TODO lo que se escriba se lee como la respuesta.
      // Si no se dice como salir, la unica forma de descubrirlo es adivinar — y
      // el caso real fue alguien pidiendo un archivo de Drive tres veces y
      // recibiendo el mismo cartel las tres.
      'Si no querias arrancar una corrida, manda <b>/cancelar</b> y seguimos como siempre.',
    ].join('\n');
  }

  const lineas: string[] = [];
  if (creado?.proyecto) lineas.push(`✅ Cree el proyecto <b>${escaparHtml(creado.proyecto)}</b>.`);
  if (creado?.repos.length) {
    lineas.push(
      'Y los repos:',
      ...creado.repos.map((r) => ` · <code>${escaparHtml(r)}</code>`),
    );
  }
  if (creado?.referencia.length) {
    // Se nombra que son AUTOMATICAS: sin esto parece que aparecieron solas por
    // un error, y lo que hicieron fue ahorrarle escribirlas.
    lineas.push(
      `Monte de referencia lo que ya tenias (${creado.referencia.length}), para copiar de ahi.`,
    );
  }
  if (lineas.length > 0) lineas.push('');

  if (error) lineas.push(`⚠️ ${escaparHtml(error)}.`, '');
  lineas.push(
    '<b>Ahora mandame el pliego</b>: que hay que construir.',
    '',
    'Puede ser un <b>.md</b> o <b>.txt</b> adjunto, o el texto pegado en el chat.',
    'Aunque sea un parrafo — con eso armo el plan y te lo muestro antes de empezar.',
  );
  return lineas.join('\n');
}

/**
 * El plan que armo el planificador, para confirmarlo.
 *
 * Se muestra ANTES de arrancar y no despues, que es el punto entero del paso:
 * una cola de veinte tareas que salio mal se ve en treinta segundos leyendola, y
 * en ocho horas dejandola correr.
 */
export function textoDePlan(proyecto: string, tareas: Tarea[]): string {
  return [
    `📋 <b>El plan para ${escaparHtml(proyecto)}</b>`,
    '',
    `${tareas.length} tarea(s), en este orden:`,
    '',
    ...tareas.map((t, i) => `${i + 1}. ${escaparHtml(t.texto)}`),
    '',
    '¿Arranco?',
  ].join('\n');
}

/**
 * Como va una corrida que esta corriendo AHORA.
 *
 * Es lo que contesta `/status` a mitad de la noche, y esta ordenado por lo que
 * se pregunta primero: ¿sigue viva?, ¿en que anda?, ¿cuanto lleva hecho?,
 * ¿cuando corta?
 *
 * La linea de "que esta haciendo" es la que justifica el comando: sin ella,
 * "18 hechas" no distingue un bot trabajando de uno colgado hace dos horas.
 * Cuando no hay ninguna tarea tomada y la corrida sigue abierta, esta
 * revisando contra el pliego — que es un estado real y dura varios minutos.
 */
export function textoDeCorridaEnCurso(
  c: Corrida,
  t: ResumenDeTareas,
  haciendo: string | undefined,
  limite: Date | undefined,
): string {
  const lineas = [
    `🌙 <b>Corrida en curso</b> — ${escaparHtml(c.proyecto)}`,
    `Ronda ${c.ronda} de ${c.techoRondas}.`,
    '',
    haciendo
      ? `▶ Haciendo: ${escaparHtml(haciendo)}`
      : // Sin tarea tomada y con la corrida abierta: el analista esta leyendo
        // el repo contra el pliego. Decirlo evita que un silencio de diez
        // minutos se lea como que se colgo.
        '🔎 Revisando el repo contra el pliego.',
    '',
    `Tareas: ${t.hechas} hechas · ${t.fallidas} fallaron · ${t.pendientes} sin hacer`,
  ];

  // Los fallos SEGUIDOS solo cuando ya hay alguno: en una noche normal el
  // contador esta en cero y nombrarlo seria ruido. Cuando no lo esta, es lo mas
  // urgente de la pantalla — falta poco para que corte.
  if (c.fallosSeguidos > 0) {
    lineas.push(
      `⚠️ ${c.fallosSeguidos} fallo(s) seguido(s): a los ${TOPE_DE_FALLOS} corto.`,
    );
  }

  if (limite) {
    const faltan = Math.round((limite.getTime() - Date.now()) / 60000);
    lineas.push(
      '',
      faltan > 60
        ? `Corta a las ${c.techoHora} (faltan ${Math.floor(faltan / 60)}h ${faltan % 60}m).`
        : faltan > 0
          ? `Corta a las ${c.techoHora} (faltan ${faltan}m).`
          : `Ya paso la hora de corte (${c.techoHora}): cierro en la proxima vuelta.`,
    );
  }

  lineas.push('', 'Con /cola ves la lista. Con /cancelar corto la corrida.');
  return lineas.join('\n');
}

/**
 * Una corrida desatendida.
 *
 * Los tres casos que contesta el mismo comando: recien abierta, ya habia una, y
 * `/corrida` a secas. El de "ya habia una" dice CUAL, porque la pregunta que
 * sigue siempre es esa.
 */
export function textoDeCorrida(
  c: Corrida | undefined,
  recienAbierta: boolean,
  yaHabia: boolean,
  creado?: LoCreado,
): string {
  if (!c) {
    // Antes esto abria con "No hay ninguna corrida abierta" y seguia
    // explicando el ciclo. Estaba mal por donde arrancaba: quien escribe
    // /corrida ya sabe que no hay ninguna —por eso la esta pidiendo— y lo que
    // necesita es saber QUE tiene que mandar. La ausencia como titular convertia
    // una invitacion en un informe de estado.
    return [
      '🌙 <b>¿Arrancamos una corrida?</b>',
      '',
      'Mandame el instructivo de lo que hay que construir. Puede ser:',
      '',
      ' · un <b>.md</b> o <b>.txt</b> adjunto, con <code>/corrida</code> en el texto del archivo',
      ' · o un <code>/corrida</code> y abajo el texto, aunque sea un parrafo',
      '',
      'Despues me dictas las primeras tareas con /cola y me podes dejar: cuando',
      'se vacie, releo tu instructivo, comparo contra lo que hay y sigo sola.',
      '',
      'A la mañana te dejo un informe con lo que se hizo y por que pare.',
      '',
      `Los techos vienen en ${TECHO_RONDAS_POR_DEFECTO} rondas y hasta las ${TECHO_HORA_POR_DEFECTO}.`,
      'Se cambian: <code>/corrida rondas=2 hasta=05:00</code>.',
      '',
      // El caso que este comando vino a resolver: un cliente nuevo, de cero,
      // sin salir de Telegram. Va al final porque es lo menos frecuente, pero
      // va: nadie adivina que existe.
      'Y si es un cliente nuevo te armo todo:',
      '<code>/corrida proyecto=acme org=Sincro-arg repos=acme-front,acme-back</code>',
      'Creo el proyecto en el panel y los repos en GitHub, y arranco ahi.',
      '',
      'Con <code>referencia=otro-repo</code> monto un repo que ya existe para',
      'que lo mire y copie: se lee, no se toca.',
    ].join('\n');
  }

  if (yaHabia) {
    return [
      `Ya tenes una corrida abierta en <b>${escaparHtml(c.proyecto)}</b>, en la ronda ${c.ronda}.`,
      '',
      // Se explica POR QUE no se abre otra: sin esto se lee como un limite
      // arbitrario y el reflejo es reintentar.
      'No abro una segunda: las dos pelearian por los mismos agentes y ninguna',
      'de las dos terminaria.',
      '',
      'Con /cancelar cierro esta y podes arrancar la nueva.',
    ].join('\n');
  }

  const lineas = recienAbierta
    ? [`🌙 Corrida abierta en <b>${escaparHtml(c.proyecto)}</b>.`, '']
    : [`🌙 Corrida abierta en <b>${escaparHtml(c.proyecto)}</b>, ronda ${c.ronda}.`, ''];

  // Lo que se creo de paso se DICE, y con el nombre completo: son cosas que
  // quedan afuera de este chat —un proyecto en el panel, repos en GitHub— y si
  // no se nombran, nadie sabe que existen ni donde buscarlas.
  if (creado?.proyecto) lineas.push(`Cree el proyecto <b>${escaparHtml(creado.proyecto)}</b>.`);
  if (creado?.repos.length) {
    lineas.push(
      `Cree ${creado.repos.length} repo(s) en GitHub:`,
      ...creado.repos.map((r) => ` · <code>${escaparHtml(r)}</code>`),
    );
  }
  // Los de referencia se nombran APARTE de los creados, y se dice que son de
  // solo lectura: si aparecieran en la misma lista, se leeria como que tambien
  // se crearon — y peor, como que el agente los va a modificar.
  if (creado?.referencia.length) {
    lineas.push(
      'Y monte de referencia (solo lectura):',
      ...creado.referencia.map((r) => ` · <code>${escaparHtml(r)}</code>`),
    );
  }
  if (creado?.proyecto || creado?.repos.length || creado?.referencia.length) lineas.push('');

  lineas.push(
    `Techos: ${c.techoRondas} ronda(s) · hasta las ${c.techoHora}.`,
    '',
    recienAbierta
      ? 'Ahora mandame la cola con <b>/cola</b> y una tarea por linea. Cuando se vacie, reviso contra el pliego y sigo sola.'
      : 'Con /cola ves lo que falta. Con /cancelar cierro la corrida.',
  );
  return lineas.join('\n');
}

/**
 * Con que modelo escribe la IA.
 *
 * Cuando nadie eligio se dice ASI, y no se nombra un modelo: el turno corre con
 * el default del CLI de Claude, y afirmar cual es seria inventarlo — el dia que
 * el CLI cambie el suyo, el cartel estaria mintiendo.
 */
export function textoDeModelo(modelo: ClaveDeModelo | undefined, cambiado: boolean): string {
  if (!modelo) {
    return [
      'Estas usando el modelo que viene por defecto.',
      '',
      'Podes elegir otro: uno mas capaz para lo dificil, o uno mas barato para lo simple.',
    ].join('\n');
  }
  const m = NOMBRE_DE_MODELO[modelo];
  return [
    cambiado ? 'Listo, cambie el modelo.' : 'Este es el modelo que estas usando.',
    '',
    `<b>${m.nombre}</b>`,
    m.para,
    '',
    'Cambiarlo no borra la conversacion: el agente sigue el mismo hilo.',
  ].join('\n');
}

/**
 * Hace cuanto que alguien tiene el slot, en palabras.
 *
 * Importa mas de lo que parece: "hace 1 min" invita a esperar y "hace 40 min"
 * invita a cambiar de agente. Un aviso sin el tiempo obliga a preguntar.
 */
function haceCuanto(desde: number | undefined, ahora: number): string {
  if (desde === undefined) return '';
  const minutos = Math.floor((ahora - desde) / 60_000);
  if (minutos < 1) return ' (recien)';
  if (minutos === 1) return ' (hace 1 min)';
  return ` (hace ${minutos} min)`;
}

/**
 * El aviso de que el slot lo tiene otro.
 *
 * Sin nombre queda "otra persona": no saber como se llama degrada el mensaje
 * pero no lo invalida, y voltearlo por no poder leer un email seria cambiar un
 * mensaje incompleto por ninguno.
 */
export function textoDeOcupado(
  agente: AgentId,
  quien: string | undefined,
  desde: number | undefined,
  esperandoOk = false,
  ahora = Date.now(),
): string {
  const duenio = quien ?? 'otra persona';
  // Un turno frenado en una aprobacion se destraba con un toque de la otra
  // persona; uno trabajando hay que esperarlo. Es la diferencia entre esperar
  // un cachito e irse a otro agente, y sin decirlo hay que adivinar.
  const porque = esperandoOk
    ? `\nEsta frenado esperando que ${duenio} apruebe algo, asi que puede destrabarse en cualquier momento.`
    : '';
  return (
    `⛔ ${agente.toUpperCase()} lo esta usando ${duenio}${haceCuanto(desde, ahora)}.${porque}\n\n` +
    'Te paso a otro y le mando lo que me escribiste:'
  );
}

/**
 * Que outcomes van con parse_mode HTML.
 *
 * Lista explicita y no "todos": el texto que no pasa por un armador propio es
 * arbitrario, y un `<` suelto rompe el mensaje entero con "can't parse
 * entities" — no se ve mal, no llega.
 *
 * `answer` esta en la lista desde que la respuesta del agente pasa por
 * `conCodigoParaTelegram`, que escapa TODO —prosa incluida— antes de meter sus
 * `<pre>`. Sin ese escapado, esto no podria estar aca.
 */
export function usaHtml(outcome: PipelineOutcome): boolean {
  return (
    outcome.kind === 'answer' ||
    outcome.kind === 'codigo' ||
    outcome.kind === 'menu_agentes' ||
    outcome.kind === 'elegido' ||
    // El nombre del bot va en negrita: es lo que separa "esto lo dice Punchi"
    // de "esto lo contesto el agente".
    outcome.kind === 'menu' ||
    outcome.kind === 'permisos' ||
    outcome.kind === 'modelo' ||
    outcome.kind === 'cola' ||
    outcome.kind === 'corrida' ||
    outcome.kind === 'corrida_sin_armar' ||
    // Los dos pasos del `/corrida` conversacional. Se olvidaron al agregarlos y
    // el sintoma fue exactamente este: el mensaje llegaba con `<b>` y
    // `&lt;nombre&gt;` a la vista, o sea "lleno de simbolos".
    //
    // Es la tercera vez que pasa lo mismo con esta lista. Por eso el test de
    // abajo la recorre entera en vez de mirar un caso: un outcome que arma HTML
    // y no esta declarado aca no falla, se ve mal — y verse mal no rompe ningun
    // test que no lo busque.
    outcome.kind === 'corrida_paso' ||
    outcome.kind === 'corrida_planificando' ||
    // `status` lleva HTML desde que muestra la corrida: el nombre del proyecto
    // va en negrita y el texto de la tarea es libre. Sin declararlo, las
    // etiquetas se leerian crudas — el mismo agujero que tenia el informe.
    outcome.kind === 'status' ||
    // Los dos llevan el nombre del proyecto en negrita: es el dato de la
    // frase, y en una lista de seis nombres parecidos es lo que se busca con
    // la vista.
    outcome.kind === 'project' ||
    outcome.kind === 'project_desconocido'
  );
}

/** Un InlineKeyboard a partir de filas de botones. */
function tecladoDeTeclas(filas: Boton[][]): InlineKeyboard {
  const teclado = new InlineKeyboard();
  for (const fila of filas) {
    for (const b of fila) teclado.text(b.label, b.data);
    teclado.row();
  }
  return teclado;
}

/** El teclado de un outcome de menu, si lo tiene. */
function tecladoDe(outcome: PipelineOutcome): InlineKeyboard | undefined {
  // El de permisos se arma con el modo actual y no viene en el outcome: es el
  // unico teclado que depende de un valor y no de una lista.
  if (outcome.kind === 'permisos' || outcome.kind === 'modelo') {
    const filas =
      outcome.kind === 'permisos'
        ? tecladoDePermisos(outcome.modo)
        : tecladoDeModelos(outcome.modelo);
    const teclado = new InlineKeyboard();
    for (const fila of filas) {
      for (const b of fila) teclado.text(b.label, b.data);
      teclado.row();
    }
    return teclado;
  }

  const botones: Boton[][] | undefined =
    outcome.kind === 'menu' ||
    outcome.kind === 'menu_proyectos' ||
    outcome.kind === 'menu_agentes' ||
    // El error tambien puede traer botones: `usage_limit` ofrece los otros
    // Claude. Ver `botonesDeRelevo` en el pipeline.
    outcome.kind === 'error' ||
    // Y ocupado SIEMPRE los trae: sin otro agente que ofrecer, el aviso seria
    // un "no" sin salida.
    outcome.kind === 'ocupado' ||
    // El de proyecto los trae para poder cambiarse de una lista real en vez de
    // escribir el nombre exacto. Los reusa del menu —son los MISMOS botones,
    // con el mismo callback— asi que elegir por /proyecto y elegir por /menu
    // terminan en el mismo lugar.
    outcome.kind === 'project' ||
    outcome.kind === 'project_desconocido' ||
    // Solo cuando YA estaba vinculado trae el boton de desvincular.
    outcome.kind === 'sin_vincular'
      ? outcome.botones
      : undefined;
  if (!botones || botones.length === 0) return undefined;

  const teclado = new InlineKeyboard();
  for (const fila of botones) {
    for (const b of fila) teclado.text(b.label, b.data);
    teclado.row();
  }
  return teclado;
}

export interface DecidirDeps {
  store: Store;
  send: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  /** Refleja la decision en el mensaje del chat. Puede fallar sin consecuencias. */
  editarMensaje: (chatId: number, messageId: number, texto: string) => Promise<void>;
}

/**
 * Traduce un toque de boton en una decision.
 *
 * `claimApproval` va ANTES del `send`: si se mandara primero al agente y
 * despues se marcara, dos toques simultaneos mandarian dos decisiones. Al
 * reves, el segundo toque no llega nunca al agente.
 */
export async function decidirAprobacion(
  accion: { kind: BotonKind; approvalId: string },
  deps: DecidirDeps,
  usuarioId?: string,
): Promise<{ text: string }> {
  const rec = await deps.store.getApproval(accion.approvalId);
  if (!rec) return { text: 'Esa aprobacion no existe o ya no esta en juego.' };

  if (accion.kind === 'ex') {
    // Todavia no se decide nada: primero hace falta el motivo. El proximo
    // mensaje del chat ES el motivo, no un prompt nuevo.
    await deps.store.setAwaitingFeedback(rec.chatId, accion.approvalId);
    return { text: 'Contame por que no, con un mensaje o un audio.' };
  }

  const decision: ApprovalDecision =
    accion.kind === 'ok' ? { decision: 'allow' } : { decision: 'deny' };

  // Por `decidir` y no a mano: es el unico camino, y ahora la misma aprobacion
  // se puede tocar tambien desde el panel. Dos caminos serian dos reglas.
  const r = await decidir(
    { store: deps.store, send: deps.send, editarMensaje: deps.editarMensaje },
    { approvalId: accion.approvalId, decision, desde: 'telegram', usuarioId },
  );

  if (r === 'ya_decidida') return { text: 'Eso ya estaba contestado.' };
  if (r === 'desconocida') return { text: 'Esa aprobacion no existe.' };
  return { text: accion.kind === 'ok' ? '✅ Aprobado.' : '❌ Rechazado.' };
}

export interface BridgeDeps extends PipelineDeps {
  botToken: string;
  fetchPending: (agent: AgentId) => Promise<ApprovalRequest[]>;
  sendDecision: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  /**
   * Guarda un archivo que llego por el chat como documento del proyecto.
   *
   * Opcional: sin `SUPABASE_SERVICE_KEY` el bridge no puede escribir en el
   * Storage, y entonces esto no se pasa. El bot lo dice en vez de aceptar un
   * archivo que se iba a perder — ver el handler de `message:document`.
   */
  guardarDocumento?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    nombreOriginal: string;
    datos: Uint8Array;
  }) => Promise<{ nombre: string; error?: string }>;
}

/**
 * Baja cualquier archivo de Telegram por su file_id.
 *
 * Telegram no manda el contenido en el update: manda un id que hay que canjear
 * por una ruta con `getFile` y despues bajar del CDN, con el token del bot en
 * la URL. Por eso esto necesita el token y no alcanza con el `ctx`.
 */
async function bajarArchivo(
  api: { getFile: (id: string) => Promise<{ file_path?: string }> },
  fileId: string,
  botToken: string,
): Promise<Uint8Array> {
  const file = await api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram devolvio ${res.status} al bajar el archivo`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Baja un audio de Telegram. Se usa tanto para un prompt como para un motivo. */
async function bajarAudio(
  api: { getFile: (id: string) => Promise<{ file_path?: string }> },
  fileId: string,
  mimeType: string,
  botToken: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType };
}

/**
 * Los comandos que Telegram muestra en el boton de menu del chat.
 *
 * Sin registrarlos, los comandos existen pero son invisibles: el boton de menu
 * aparece vacio y hay que adivinar que `/menu` cambia de agente. `getMyCommands`
 * devolvia `[]`.
 *
 * `/start` NO va en la lista aunque el bot lo entienda: Telegram ya lo ofrece
 * solo al abrir un chat nuevo, y repetirlo en el menu ocupa un renglon para algo
 * que ya paso.
 *
 * Tampoco van `/c1`..`/c6`: son seis renglones para elegir agente, que es
 * exactamente lo que `/menu` hace con botones y sabiendo cuales tienen cuenta.
 * Siguen funcionando escritos a mano.
 */
const COMANDOS = [
  { command: 'menu', description: 'Qué puedo hacer por vos' },
  { command: 'cola', description: 'Todo lo que hay que hacer, una tarea por línea' },
  // Abajo de /cola a proposito: es la version larga de lo mismo, y quien no
  // sabe que existe la cola no tiene por que empezar por una corrida de ocho
  // horas.
  { command: 'corrida', description: 'Dejarme trabajando toda la noche sobre un pliego' },
  { command: 'cancelar', description: 'Cortar lo que queda en la cola' },
  { command: 'agente', description: 'Elegir con qué agente hablar' },
  { command: 'proyecto', description: 'Ver o cambiar el proyecto activo' },
  { command: 'status', description: 'Con qué agentes estás trabajando' },
  { command: 'cowork', description: 'Sumar o sacar un agente de este chat' },
  { command: 'permisos', description: 'Cuánto te pregunto antes de actuar' },
  { command: 'modelo', description: 'Con qué modelo te contesto' },
  { command: 'vincular', description: 'Conectar este chat con tu cuenta del panel' },
];

/**
 * Los chats que ya tienen su cola corriendo.
 *
 * Sin esto, mandar `/cola` dos veces seguidas arranca dos bucles sobre la misma
 * cola: los dos hacen `tomarProxima` y se reparten las tareas de a pares,
 * corriendo dos turnos a la vez contra el mismo agente —que la tenencia
 * rechaza con un 409—. El resultado serian tareas fallando por chocarse entre
 * si.
 *
 * En memoria y no en la base: es del PROCESO que esta corriendo el bucle. Si el
 * bridge se reinicia, no hay ningun bucle vivo que proteger, y las tareas que
 * quedaron en 'corriendo' se ven en /cola.
 */
const colasVivas = new Set<number>();

/** Arranca la cola de un chat si no la esta corriendo ya. */
async function arrancarCola(
  chatId: number,
  deps: BridgeDeps,
  avisar: (texto: string) => Promise<void>,
): Promise<void> {
  if (colasVivas.has(chatId)) return;
  colasVivas.add(chatId);
  try {
    await correrCola(chatId, deps, avisar);
  } catch (err) {
    console.error(`[bridge] la cola de ${chatId} se corto:`, err);
    await avisar('Se me corto la cola por un error mio. Mandame /cola para ver que quedo.').catch(
      () => {},
    );
  } finally {
    // En `finally`: si el bucle explota y no se saca la marca, ese chat no
    // puede volver a arrancar su cola hasta que se reinicie el bridge.
    colasVivas.delete(chatId);
  }
}

/**
 * Contesta un paso del `/corrida` conversacional.
 *
 * Vive aca y no en el pipeline porque el paso del pliego dispara un turno que
 * tarda minutos, y despues manda OTRO mensaje con el plan. El pipeline devuelve
 * un outcome y termina; esto necesita hablar dos veces.
 */
async function responderPaso(
  ctx: {
    chat: { id: number };
    reply: (t: string, o?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard }) => Promise<unknown>;
  },
  texto: string,
  deps: BridgeDeps,
): Promise<void> {
  const out = await handleIncoming(
    { chatId: ctx.chat.id, messageId: 0, text: `/corrida ${texto}` },
    deps,
  );

  // El paso del pliego devuelve `corrida_planificando`: hay que correr el turno
  // y despues mostrar el plan. Los demas outcomes se contestan y listo.
  if (out.kind !== 'corrida_planificando') {
    await ctx.reply(renderOutcome(out), {
      ...(usaHtml(out) ? { parse_mode: 'HTML' as const } : {}),
    });
    return;
  }

  await ctx.reply(renderOutcome(out), { parse_mode: 'HTML' });

  const usuarioId = await deps.store.usuarioDeChat(ctx.chat.id);
  if (!usuarioId) return;

  const plan = await planificarCorrida(out.corrida, usuarioId, deps);
  if (!plan.ok) {
    // La corrida se CIERRA: sin plan no hay con que arrancar, y dejarla abierta
    // haria que el ciclo corra un analisis sobre un repo vacio esta misma
    // noche.
    await deps.store.cerrarCorrida(out.corrida.id, 'cancelada');
    await ctx.reply(
      `No pude armar el plan: ${escaparHtml(plan.motivo)}

Cerre la corrida. Proba de nuevo con /corrida.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const teclado = new InlineKeyboard();
  for (const fila of tecladoDePlan()) {
    for (const b of fila) teclado.text(b.label, b.data);
    teclado.row();
  }
  await ctx.reply(textoDePlan(out.corrida.proyecto, plan.tareas), {
    parse_mode: 'HTML',
    reply_markup: teclado,
  });
}

/**
 * Retoma las corridas que quedaron abiertas, al arrancar el bridge.
 *
 * El bucle de la cola y la espera por tokens viven en MEMORIA. Un deploy a
 * mitad de la noche los mata: la corrida queda abierta con sus tareas
 * pendientes y nadie la retoma, porque `correrCola` solo arranca cuando llega
 * un mensaje. Sin esto, un deploy a las 3am cuesta la noche entera —y los
 * deploys a esa hora son justo los que pasan cuando uno esta probando esto—.
 *
 * Se llama DESPUES de armar el bot, no antes: necesita poder avisar al chat.
 *
 * Los techos se siguen respetando solos: `correrCola` los mira en cada vuelta,
 * asi que una corrida cuya hora ya paso se cierra en el primer paso y manda su
 * informe. Retomar no es lo mismo que revivir.
 */
export function retomarCorridas(bot: Bot, deps: BridgeDeps): void {
  void (async () => {
    let abiertas;
    try {
      abiertas = await deps.store.corridasAbiertas();
    } catch (err) {
      // Un fallo aca no puede impedir que el bot arranque: sin retomar, el
      // sistema se comporta como antes de esta funcion.
      console.error('[bridge] no pude buscar corridas abiertas:', err);
      return;
    }
    if (abiertas.length === 0) return;
    console.log(`[bridge] retomando ${abiertas.length} corrida(s) abierta(s)`);

    for (const c of abiertas) {
      const avisar = async (texto: string) => {
        await bot.api
          .sendMessage(c.chatId, texto, { parse_mode: 'HTML' })
          .then(() => undefined)
          // Un chat al que no se puede escribir —bloqueado, borrado— no puede
          // frenar el resto.
          .catch(() => undefined);
      };
      await avisar('Me reinicie. Retomo la corrida donde habia quedado.');
      void arrancarCola(c.chatId, deps, avisar);
    }
  })();
}

export function buildBot(deps: BridgeDeps): Bot {
  const bot = new Bot(deps.botToken);

  // Al arrancar y sin esperarlo: es una llamada a la API de Telegram que puede
  // tardar o fallar, y un bot que no levanta porque no pudo publicar su menu
  // seria peor que un menu vacio. Si falla se loguea y el bot anda igual.
  void bot.api.setMyCommands(COMANDOS).catch((err: unknown) => {
    console.error('[bridge] no se pudieron publicar los comandos:', err);
  });

  bot.on('callback_query:data', async (ctx) => {
    const accion = parseApprovalData(ctx.callbackQuery.data);
    if (!accion) {
      // No es una aprobacion: puede ser el menu. Un dato que tampoco es del
      // menu —un boton viejo de antes de un deploy, o el inerte de un agente
      // sin cuenta— se contesta y se ignora.
      const menu = parseMenuData(ctx.callbackQuery.data);
      // answerCallbackQuery primero: sin eso Telegram deja el boton
      // "cargando" hasta que se conteste, y armar el menu siguiente tarda.
      await ctx.answerCallbackQuery();
      if (menu) await manejarMenu(ctx, menu, deps);
      return;
    }

    // Quien decidio, para poder mostrarlo despues en el panel. Puede no haber:
    // un chat sin vincular igual puede tocar el boton de una aprobacion vieja.
    const usuarioId = ctx.chat ? await deps.store.usuarioDeChat(ctx.chat.id) : undefined;

    const { text } = await decidirAprobacion(
      {
        ...accion,
      },
      {
        store: deps.store,
        send: deps.sendDecision,
        editarMensaje: (chatId, messageId, texto) =>
          ctx.api.editMessageText(chatId, messageId, texto).then(() => undefined),
      },
      usuarioId,
    );

    // answerCallbackQuery saca el relojito del boton; sin esto el cliente lo
    // deja "cargando" hasta que se rinde.
    await ctx.answerCallbackQuery({ text });
    // Se sacan los botones: ya no hay nada que tocar ahi.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  /**
   * Guarda un archivo del chat, venga como documento o como foto.
   *
   * Los dos caminos hacen lo mismo salvo de donde sacan el `file_id`, el nombre
   * y el tamaño — una foto de Telegram no trae nombre y viene recomprimida—,
   * asi que la diferencia se resuelve en el llamador y esto queda igual para
   * los dos.
   */
  const guardarDelChat = async (
    ctx: {
      chat: { id: number };
      api: { getFile: (id: string) => Promise<{ file_path?: string }>; editMessageText: (c: number, m: number, t: string, o?: { parse_mode?: 'HTML' }) => Promise<unknown> };
      reply: (t: string) => Promise<{ message_id: number }>;
    },
    archivo: { fileId: string; nombreOriginal: string; bytes?: number },
  ): Promise<void> => {
    const usuarioId = await deps.store.usuarioDeChat(ctx.chat.id);
    if (!usuarioId) {
      await ctx.reply(
        'No te tengo vinculado a ninguna cuenta, asi que no se a que proyecto guardar esto. ' +
          'Mandame /vincular.',
      );
      return;
    }

    if (!deps.guardarDocumento) {
      // Se dice, no se ignora: aceptar el archivo en silencio y perderlo es
      // justo el comportamiento que esta feature vino a sacar.
      await ctx.reply('Todavia no puedo guardar archivos. Subilo desde el panel, en Configuracion.');
      return;
    }

    const { nombreOriginal } = archivo;

    // El tamaño se mira ANTES de bajar: Telegram ya lo dice en el update, y
    // bajar 20 MB para despues rechazarlos es tiempo y memoria por nada.
    if (archivo.bytes !== undefined && archivo.bytes > MAXIMO_BYTES) {
      await ctx.reply(`Ese archivo pasa los ${MAXIMO_BYTES / (1024 * 1024)} MB.`);
      return;
    }

    const tipo = tipoDe(nombreOriginal);
    if (!tipo) {
      await ctx.reply(
        `No se leer ese tipo de archivo. Puedo con: ${[...TIPOS, ...TIPOS_IMAGEN].join(', ')}.`,
      );
      return;
    }

    // El proyecto al que va: el activo del chat. Es el mismo con el que
    // hablarian los turnos, asi que el documento aparece donde la persona
    // espera y no en otro proyecto.
    const proyecto = (await deps.store.getActiveProject(ctx.chat.id)) ?? deps.project;
    const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
    const proyectoId = proyectos.find((p) => p.nombre === proyecto)?.id;
    if (!proyectoId) {
      await ctx.reply(
        `El proyecto activo (${proyecto}) no existe en el panel, asi que no tiene donde guardarse. ` +
          'Elegi otro con /menu.',
      );
      return;
    }

    const aviso = await ctx.reply('📎 guardando…');
    try {
      const datos = await bajarArchivo(ctx.api as never, archivo.fileId, deps.botToken);
      const guardado = await deps.guardarDocumento({
        proyectoId,
        usuarioId,
        nombreOriginal,
        datos,
      });

      // El error de conversion NO es un fallo del guardado: el original quedo,
      // y se puede descargar del panel. Se cuenta aparte para que se entienda
      // que el archivo esta pero el agente no lo va a poder leer.
      // Una imagen no se convierte y no le falta nada: el agente la VE con
      // `Read`. Decir "ya lo pueden leer" sonaria a que se le saco el texto.
      const cola = esImagen(tipo)
        ? '\n\nLos agentes de este proyecto ya la pueden ver.'
        : guardado.error
          ? `\n\n⚠️ No pude convertirlo a texto (${guardado.error}), asi que el agente no va a poder leerlo.`
          : '\n\nYa lo pueden leer los agentes de este proyecto.';

      await ctx.api.editMessageText(
        ctx.chat.id,
        aviso.message_id,
        `✅ Guardado en <b>${proyecto}</b> como <code>${guardado.nombre}</code>.${cola}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        aviso.message_id,
        `⚠️ No pude guardar el archivo: ${message}`,
      );
    }
  };

  /**
   * Un archivo mandado al chat.
   *
   * Va ANTES del handler general de mensajes porque un documento no es un
   * prompt: no arranca un turno, se guarda.
   */
  /**
   * Un archivo adjunto con `/corrida` en el texto: el instructivo de una
   * corrida.
   *
   * Devuelve si LO manejo. Va antes de guardarlo como documento comun porque
   * es un pedido distinto: no es "guardame esto", es "arranca con esto".
   *
   * El archivo se guarda TAMBIEN como documento del proyecto, y no es
   * redundante: el pliego que se guarda en la corrida es el texto contra el que
   * compara el analista, y el documento es el archivo que la persona puede
   * volver a bajar del panel. Uno es para el ciclo y el otro es para ella.
   */
  /**
   * Baja un adjunto y lo devuelve como texto de pliego, o `undefined`.
   *
   * Salio de `corridaConArchivo` cuando el paso a paso necesito lo mismo: bajar,
   * validar que sea texto, y decir POR QUE no si no lo es. Duplicarlo dejaba dos
   * lugares donde acordarse de que un .pdf no sirve de pliego.
   */
  const pliegoDelAdjunto = async (
    ctx: {
      chat: { id: number };
      api: { getFile: (id: string) => Promise<{ file_path?: string }> };
      reply: (t: string, o?: { parse_mode?: 'HTML' }) => Promise<{ message_id: number }>;
    },
    archivo: { fileId: string; nombreOriginal: string; bytes?: number },
  ): Promise<string | undefined> => {
    if (archivo.bytes !== undefined && archivo.bytes > TOPE_DE_PLIEGO) {
      await ctx.reply(`Ese instructivo pasa los ${TOPE_DE_PLIEGO / 1024} KB.`);
      return undefined;
    }
    let datos: Uint8Array;
    try {
      datos = await bajarArchivo(ctx.api as never, archivo.fileId, deps.botToken);
    } catch (err) {
      await ctx.reply(
        `No pude bajar el archivo: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    const pliego = pliegoDeArchivo(archivo.nombreOriginal, datos);
    if (!pliego.ok) {
      await ctx.reply(pliego.motivo);
      return undefined;
    }
    return pliego.md;
  };

  const corridaConArchivo = async (
    ctx: {
      chat: { id: number };
      message: { caption?: string };
      api: { getFile: (id: string) => Promise<{ file_path?: string }> };
      reply: (t: string, o?: { parse_mode?: 'HTML' }) => Promise<{ message_id: number }>;
    },
    archivo: { fileId: string; nombreOriginal: string; bytes?: number },
  ): Promise<boolean> => {
    const caption = (ctx.message.caption ?? '').trim();
    if (!/^\/corrida(?:@[\w_]+)?\b/i.test(caption)) return false;

    if (archivo.bytes !== undefined && archivo.bytes > TOPE_DE_PLIEGO) {
      await ctx.reply(`Ese instructivo pasa los ${TOPE_DE_PLIEGO / 1024} KB.`);
      return true;
    }

    let datos: Uint8Array;
    try {
      datos = await bajarArchivo(ctx.api as never, archivo.fileId, deps.botToken);
    } catch (err) {
      await ctx.reply(
        `No pude bajar el archivo: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }

    const pliego = pliegoDeArchivo(archivo.nombreOriginal, datos);
    if (!pliego.ok) {
      await ctx.reply(pliego.motivo);
      return true;
    }

    // Se reconstruye el comando con el texto del archivo como pliego: asi las
    // opciones del caption (`/corrida rondas=2`) siguen valiendo y el comando
    // no tiene dos formas de entrar. Ver `parseOpcionesDeCorrida`.
    const opciones = caption.replace(/^\/corrida(?:@[\w_]+)?\s*/i, '');
    const out = await handleIncoming(
      { chatId: ctx.chat.id, messageId: 0, text: `/corrida ${opciones}\n${pliego.md}` },
      deps,
    );
    await ctx.reply(renderOutcome(out), { parse_mode: 'HTML' });
    return true;
  };

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const archivo = {
      fileId: doc.file_id,
      nombreOriginal: doc.file_name ?? 'documento',
      bytes: doc.file_size,
    };
    // Un archivo con un `/corrida` A MEDIAS es el pliego del paso 2: no hace
    // falta que le escriba /corrida en el texto del archivo, porque el chat ya
    // sabe que lo estaba esperando.
    const borrador = await deps.store.borradorDeChat(ctx.chat.id);
    if (borrador?.paso === 'pliego') {
      const pliego = await pliegoDelAdjunto(ctx as never, archivo);
      if (pliego) {
        await responderPaso(ctx as never, pliego, deps);
        await guardarDelChat(ctx as never, archivo);
        return;
      }
      // Si no se pudo leer, `pliegoDelAdjunto` ya lo dijo. Se guarda igual como
      // documento —el archivo no se pierde— y el paso sigue esperando.
    }

    // Con /corrida en el texto del archivo abre la corrida; sin eso no hace
    // nada. En los dos casos el archivo se guarda como documento del proyecto,
    // y no es redundante: el pliego de la corrida es el texto contra el que
    // compara el analista, y el documento es el archivo que la persona puede
    // volver a bajar del panel.
    await corridaConArchivo(ctx as never, archivo);
    await guardarDelChat(ctx as never, archivo);
  });

  /**
   * Una foto, mandada como foto.
   *
   * Antes se ignoraba: Telegram las manda recomprimidas y sin nombre, y el
   * conversor no lee imagenes. Esa razon dejo de valer — el agente las abre con
   * `Read` y las VE, asi que no hay texto que sacar. Y mandar una captura desde
   * el celular es el caso normal: obligar a adjuntarla "como archivo" es un
   * paso de mas que se olvida siempre.
   *
   * Se toma la ULTIMA del array, que es la de mayor resolucion: Telegram manda
   * varias miniaturas y la primera es diminuta.
   */
  bot.on('message:photo', async (ctx) => {
    const foto = ctx.message.photo[ctx.message.photo.length - 1];
    if (!foto) return;
    // Sin nombre: Telegram no lo manda para las fotos. Se arma con el id del
    // mensaje para que dos capturas del mismo chat no se pisen entre si.
    await guardarDelChat(ctx as never, {
      fileId: foto.file_id,
      nombreOriginal: `captura-${ctx.message.message_id}.jpg`,
      bytes: foto.file_size,
    });
  });

  bot.on('message', async (ctx) => {
    // Antes habia aca un filtro por TELEGRAM_ALLOWED_USER_IDS. Quien puede
    // hablarle al bot ahora sale de telegram_vinculos, y lo resuelve el
    // pipeline: un chat sin vincular recibe una linea y nada mas.
    const voice = ctx.message.voice ?? ctx.message.audio;

    // Las fotos ya no caen aca: las agarra `message:photo`, que las guarda
    // como documento. El agente las VE con `Read`.

    if (!voice && !ctx.message.text) return;

    // Si hay un `/corrida` a medias, este mensaje ES la respuesta al paso y no
    // un prompt nuevo. Mismo criterio —y mismo lugar— que el motivo de una
    // aprobacion: va antes que todo lo demas.
    //
    // Un comando NO se secuestra: `/cancelar` tiene que poder sacarte de acá, y
    // sin esta excepcion un borrador olvidado deja el chat atrapado.
    const textoDelMensaje = ctx.message.text ?? '';
    if (!textoDelMensaje.startsWith('/')) {
      const borrador = await deps.store.borradorDeChat(ctx.chat.id);
      if (borrador) {
        await responderPaso(ctx, textoDelMensaje, deps);
        return;
      }
    }

    // Si el chat quedo esperando un motivo, este mensaje ES el motivo y no un
    // prompt nuevo. Va antes que todo lo demas por eso.
    const esperando = await deps.store.getAwaitingFeedback(ctx.chat.id);
    if (esperando) {
      const rec = await deps.store.getApproval(esperando);

      let motivo = ctx.message.text ?? '';
      if (!motivo && voice) {
        // El motivo por audio es el caso normal: se explica mas rapido
        // hablando que escribiendo, y por eso este boton es el mas usado.
        const a = await bajarAudio(
          ctx.api,
          voice.file_id,
          voice.mime_type ?? 'audio/ogg',
          deps.botToken,
        );
        motivo = await deps.transcribe(a.bytes, a.mimeType);
      }
      // Se limpia SIEMPRE, aunque falte el motivo: si no, el chat queda
      // atrapado y ningun mensaje siguiente llega al agente.
      await deps.store.setAwaitingFeedback(ctx.chat.id, null);
      if (rec && motivo) {
        const decision: ApprovalDecision = { decision: 'deny', feedback: motivo };
        await decidir(
          {
            store: deps.store,
            send: deps.sendDecision,
            editarMensaje: (chatId, messageId, texto) =>
              ctx.api.editMessageText(chatId, messageId, texto).then(() => undefined),
          },
          {
            approvalId: esperando,
            decision,
            desde: 'telegram',
            usuarioId: await deps.store.usuarioDeChat(ctx.chat.id),
          },
        );
        await ctx.reply('Listo, se lo paso y sigue con eso en cuenta.');
      }
      return;
    }

    // Un mensaje por job: se manda el placeholder y despues se edita.
    //
    // Y COLGADO del mensaje que lo pidio. Con dos agentes trabajando a la vez
    // en el mismo chat —`/c1 esto` y `/c2 aquello`— las dos respuestas llegan
    // mezcladas y no hay como saber cual contesta a cual. El reply lo dice sin
    // que nadie tenga que leer las dos.
    const placeholder = await ctx.reply('🤖 trabajando…', {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    try {
      let audio: { bytes: Uint8Array; mimeType: string } | undefined;
      if (voice) {
        audio = await bajarAudio(
          ctx.api,
          voice.file_id,
          voice.mime_type ?? 'audio/ogg',
          deps.botToken,
        );
      }

      const outcome = await handleIncoming(
        { chatId: ctx.chat.id, messageId: placeholder.message_id, text: ctx.message.text, audio },
        {
          ...deps,
          watchApprovals: ({ agent, jobId, chatId, messageId }) =>
            startWatching(
              {
                fetchPending: () => deps.fetchPending(agent),
                announce: async (a) => {
                  // recordApproval devuelve false si ya se anuncio en otra
                  // corrida: Render puede reiniciar a mitad de turno.
                  const nueva = await deps.store.recordApproval({
                    approvalId: a.approvalId,
                    jobId,
                    chatId,
                    messageId,
                    agent,
                    tool: a.tool,
                    summary: a.summary,
                  });
                  if (!nueva) return;

                  // El turno esta bloqueado esperando el OK. Sin esto la tabla
                  // dice 'running' y no hay forma de distinguir un agente que
                  // piensa de uno que espera hace diez minutos.
                  const estado =
                    a.tool === 'mcp__multicodigo__run' ? 'awaiting_build' : 'awaiting_approval';
                  await deps.store.setJobStatus(jobId, estado);

                  const { text, buttons } = renderApproval(a);
                  const teclado = new InlineKeyboard();
                  for (const fila of buttons) {
                    for (const b of fila) teclado.text(b.label, b.data);
                    teclado.row();
                  }
                  // Mensaje NUEVO, no editando el de "trabajando…": ese tiene
                  // que seguir mostrando el progreso, y un mensaje con botones
                  // que se edita encima pierde los botones.
                  const anuncio = await ctx.reply(text, { reply_markup: teclado });

                  // Y se apunta la aprobacion a ESTE mensaje, que es el que
                  // tiene los botones.
                  //
                  // `recordApproval` de arriba guardo el id del placeholder,
                  // porque es el unico que existe antes de mandar esto — y ese
                  // orden es a proposito: ahi vive la deduplicacion. Sin esta
                  // correccion, decidir editaba el placeholder y el pedido
                  // quedaba intacto: se seguia leyendo "aprobas?" con los
                  // botones vivos despues de haber aprobado.
                  await deps.store.setApprovalMessage(a.approvalId, anuncio.message_id);
                },
                seen: new Set(),
              },
              2000,
            ),
        },
      );

      const text = renderOutcome(outcome);
      if (text === '') return;
      const teclado = tecladoDe(outcome);
      await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, {
        // Solo donde hace falta: ver `usaHtml`.
        ...(usaHtml(outcome) ? { parse_mode: 'HTML' as const } : {}),
        ...(teclado ? { reply_markup: teclado } : {}),
      });

      // Recien encolo algo: se arranca a hacerlo.
      //
      // SIN `await` a proposito: una cola de cinco tareas puede tardar media
      // hora y este handler tiene que devolver el control ya. El progreso
      // llega por mensajes sueltos, uno por tarea terminada.
      if (outcome.kind === 'cola' && outcome.encoladas > 0) {
        // Con parse_mode HTML, y hacia falta: lo que manda `correrCola` ya
        // venia con formato —`conCodigoParaTelegram` arma `<pre>`, y el informe
        // de una corrida usa `<b>`— y sin esto se leia CRUDO en el chat, con
        // las etiquetas a la vista y los `&lt;` sin resolver.
        //
        // El precio es que todo lo que viaje por aca tiene que estar escapado.
        // Lo esta: ver `escaparHtml` en los mensajes de `correrCola` y de
        // `textoDeInforme`.
        void arrancarCola(ctx.chat.id, deps, (t) =>
          ctx.reply(t, { parse_mode: 'HTML' }).then(() => undefined),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        placeholder.message_id,
        `⚠️ Se rompio algo en el puente: ${message}`,
      );
    }
  });

  return bot;
}

/**
 * Un toque del menu.
 *
 * La membresia se verifica aunque el boton haya salido de este mismo bot: el
 * callback_data vuelve del cliente y no hay nada que garantice que sea el que
 * mandamos.
 */
/**
 * Exportada para poder testearla.
 *
 * Es el handler de todos los botones y decide si cada paso reemplaza al
 * anterior o manda un mensaje nuevo — la diferencia entre un menu que se
 * navega y un chat que se llena. Ejercitarla de otra forma pide levantar el
 * bot entero contra la API de Telegram.
 */
export async function manejarMenu(
  ctx: {
    chat?: { id: number };
    reply: (
      texto: string,
      opciones?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard },
    ) => Promise<unknown>;
    /**
     * Edita el mensaje que tiene el boton que se toco.
     *
     * Es lo que hace que navegar el menu no llene el chat: cada paso REEMPLAZA
     * al anterior en vez de apilarse. Sin esto, elegir proyecto y despues
     * agente dejaba tres mensajes —el menu, la lista de agentes y la
     * confirmacion— y el chat quedaba lleno de pantallas que ya no sirven.
     */
    editMessageText?: (
      texto: string,
      opciones?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard },
    ) => Promise<unknown>;
  },
  menu: MenuData,
  deps: BridgeDeps,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  /**
   * Muestra un paso del menu EDITANDO el mensaje que se toco.
   *
   * Cae a `reply` si no se puede editar, que pasa de verdad: Telegram rechaza
   * la edicion cuando el texto y el teclado son identicos a lo que ya estaba,
   * y ademas un mensaje de mas de 48 horas no se puede editar. En los dos
   * casos, un mensaje nuevo es peor que nada.
   */
  const mostrar = async (texto: string, opciones: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard }) => {
    if (texto === '') return;
    if (ctx.editMessageText) {
      try {
        await ctx.editMessageText(texto, opciones);
        return;
      } catch {
        // Sigue al reply de abajo.
      }
    }
    await ctx.reply(texto, opciones);
  };

  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return;

  // El boton que trae el mensaje de "se quedo sin tokens". Es el MISMO menu que
  // /menu: no hay una pantalla especial de agentes agotados, porque el menu ya
  // los marca con su hora de vuelta.
  /**
   * Los botones del menu, y los del modo de permisos, pasan por
   * `handleIncoming` como si la persona hubiera escrito el comando.
   *
   * No es un atajo: es lo que hace que el boton y el comando no se puedan
   * separar. Cada accion del menu ya tiene su comando —`/permisos`, `/cowork`,
   * `/status`— y reimplementarlas aca dejaria dos caminos que hay que acordarse
   * de cambiar juntos.
   */
  const comoComando = async (texto: string): Promise<void> => {
    const out = await handleIncoming({ chatId, messageId: 0, text: texto }, deps);
    await mostrar(renderOutcome(out), {
      ...(usaHtml(out) ? { parse_mode: 'HTML' as const } : {}),
      reply_markup: tecladoDe(out),
    });
  };

  if (menu.kind === 'accion') {
    // 'agentes' es el unico que no tiene comando propio con ese nombre: el
    // selector se pide con /agente.
    const comando: Record<typeof menu.accion, string> = {
      cola: '/cola',
      agentes: '/agente',
      proyectos: '/proyecto',
      permisos: '/permisos',
      modelo: '/modelo',
      cowork: '/cowork',
      estado: '/status',
    };
    await comoComando(comando[menu.accion]);
    return;
  }

  if (menu.kind === 'permiso') {
    await comoComando(`/permisos ${menu.modo}`);
    return;
  }

  if (menu.kind === 'modelo') {
    await comoComando(`/modelo ${menu.modelo}`);
    return;
  }

  if (menu.kind === 'menu') {
    const out = await armarMenu(usuarioId, chatId, deps);
    await ctx.reply(renderOutcome(out), {
      parse_mode: 'HTML',
      reply_markup: tecladoDe(out),
    });
    return;
  }

  if (menu.kind === 'desvincular') {
    if (!menu.confirmado) {
      // Se dice QUE se pierde y que se recupera: sin eso, "¿seguro?" invita a
      // decir que si sin saber contra que.
      await mostrar(
        [
          '¿Desvinculo este chat de tu cuenta?',
          '',
          'Dejo de poder trabajar en tus proyectos desde acá. No se borra nada:',
          'tus proyectos, documentos y el historial quedan donde estan.',
          '',
          'Para volver a atarlo vas a necesitar un codigo nuevo del panel.',
        ].join('\n'),
        { reply_markup: tecladoDeTeclas(tecladoDeConfirmarDesvinculo()) },
      );
      return;
    }

    const fue = await deps.store.desvincularChat(chatId, usuarioId);
    await mostrar(
      fue
        ? 'Listo, desvincule este chat. Mandame /vincular cuando quieras volver a atarlo.'
        : 'Este chat ya no estaba vinculado.',
      {},
    );
    return;
  }

  if (menu.kind === 'plan') {
    const corrida = await deps.store.corridaAbierta(chatId);
    if (!corrida) {
      // El boton quedo de una corrida que ya se cerro. Se dice en vez de
      // ignorar: un boton que no hace nada se toca tres veces.
      await mostrar('Esa corrida ya no esta abierta.', {});
      return;
    }

    if (!menu.arrancar) {
      // Descartar CIERRA la corrida y cancela lo que el planificador encolo.
      // Sin lo segundo, las tareas quedan pendientes y el proximo /cola las
      // haria — o sea que "descartar" no descartaria nada.
      await deps.store.cancelarCola(chatId);
      await deps.store.cerrarCorrida(corrida.id, 'cancelada');
      await mostrar('Listo, descarte el plan y cerre la corrida.', {});
      return;
    }

    await mostrar(`▶ Arranco con <b>${escaparHtml(corrida.proyecto)}</b>. Te aviso al terminar cada tarea.`, {
      parse_mode: 'HTML',
    });
    // Sin await: la cola puede tardar ocho horas y este handler tiene que
    // contestarle a Telegram ya. El progreso llega por los avisos.
    void arrancarCola(chatId, deps, (t) =>
      ctx.reply(t, { parse_mode: 'HTML' }).then(() => undefined),
    );
    return;
  }

  if (menu.kind === 'proyecto') {
    const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
    const elegido = proyectos.find((p) => p.id === menu.id);
    if (!elegido) return;

    await deps.store.setActiveProject(chatId, elegido.nombre);
    const out = await armarMenuDeAgentes(elegido, deps);
    await mostrar(renderOutcome(out), {
      parse_mode: 'HTML',
      reply_markup: tecladoDe(out),
    });
    return;
  }

  await deps.store.setActiveAgent(chatId, menu.slot);
  const proyecto = (await deps.store.getActiveProject(chatId)) ?? deps.project;

  // El nombre que le puso la persona, si tiene: el slot esta anotado con
  // nombre en su proyecto y en ningun otro lado.
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  const p = proyectos.find((x) => x.nombre === proyecto);
  const registrados = p ? await deps.store.agentesDeProyecto(p.id) : [];
  const nombre = registrados.find((a) => a.slot === menu.slot)?.nombre ?? menu.slot.toUpperCase();

  await mostrar(renderOutcome({ kind: 'elegido', agente: menu.slot, nombre, proyecto }), {
    parse_mode: 'HTML',
  });

  // Lo que habias escrito cuando el slot anterior estaba ocupado. Se manda al
  // agente recien elegido en vez de hacerte reescribirlo.
  //
  // `tomarPendiente` lo saca y lo borra en la misma sentencia: dos toques
  // seguidos al boton no pueden mandar el mismo mensaje dos veces.
  const pendiente = await deps.store.tomarPendiente(chatId).catch(() => undefined);
  if (pendiente === undefined) return;

  const out = await handleIncoming(
    { chatId, messageId: 0, text: `/${menu.slot} ${pendiente}` },
    deps,
  );
  // `reply` y NO `mostrar`: la respuesta de un turno es contenido nuevo, no un
  // paso del menu. Editar el mensaje del menu para poner ahi la respuesta
  // borraria la pantalla desde la que se eligio, y encima la dejaria sin
  // teclado. Los pasos del menu se reemplazan; lo que el agente contesta, no.
  await ctx.reply(renderOutcome(out), { reply_markup: tecladoDe(out) });
}
