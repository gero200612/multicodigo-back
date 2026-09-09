/**
 * Clasificar la respuesta del agente cuando dice algo que NO es trabajo hecho.
 *
 * Hoy hay un solo caso, y viene de produccion: en la corrida `saludos3` del
 * 2026-09-09 la tarea de `c1` contesto "Quiero commitear esto en saludos3-back.
 * ¿Aprobás el commit?". Nadie contesto —era desatendida, a nadie le tocaba— y
 * el sistema la cerro como `lista`: el trabajo quedo sin commitear en el disco
 * de c1 y el informe conto la tarea como hecha.
 *
 * (El otro caso de esta familia, `esAvisoDeLimite`, vive en
 * `@multicodigo/shared` porque lo usan los dos lados. Este lo usa solo el
 * bridge, y shared se consume por tag: agregarlo ahi obliga a un release y a
 * bumpear la dependencia en dos repos.)
 */

/**
 * Los verbos con los que se pide permiso. `puedo` y `procedo` incluidos: son la
 * forma mas comun de preguntarlo sin usar la palabra "aprobar".
 */
const PERMISO = '(aprob(a|á)s|apruebas|autoriz(a|á)s|confirm(a|á)s|puedo|procedo|dale)';

/** Lo que se estaria por hacer y no se hizo. */
const ACCION = '(commit|commite|commitear|commiteo|push|pushear|pusheo|mergear|merge)';

/**
 * Una pregunta que pide permiso para commitear o pushear.
 *
 * ## Por que el patron es angosto
 *
 * El riesgo real no es no detectar: es el FALSO POSITIVO. El agente termina
 * muchas respuestas buenas con una pregunta —"¿agrego tambien el front?",
 * "avisame si querias que /saludo/ tambien devuelva 400"— y marcar esas fallidas
 * tira trabajo que si se hizo. Con tres fallos, ademas, cierra la corrida.
 *
 * Asi que se exige que en la MISMA oracion interrogativa aparezcan un verbo de
 * permiso y la accion que quedaria sin hacer. "¿Agrego el front?" no la cumple:
 * no hay verbo de permiso. "Quedo commiteado" tampoco: no hay pregunta.
 *
 * ## Por que no se mira el worktree
 *
 * Seria la señal objetiva —"quedo trabajo sin commitear"— y es mejor que esta.
 * Pero vive en el disco del gateway y pedirla es otra ruta, otro token y otro
 * viaje por cada tarea. Esto alcanza para el caso que se vio y no puede
 * bloquear una corrida por un error de red.
 */
export function pidePermisoParaCommitear(texto: string): boolean {
  if (texto === '') return false;

  // Solo lo que esta ENTRE signos de pregunta —o desde un `¿` hasta el final—:
  // el resto de la respuesta puede hablar de commits en pasado sin pedir nada.
  const preguntas = texto.match(/¿[^¿?]{0,200}\?|¿[^¿?]{0,200}$/g) ?? [];
  const conPermiso = new RegExp(`\\b${PERMISO}\\b`, 'i');
  const conAccion = new RegExp(`\\b${ACCION}`, 'i');

  return preguntas.some((p) => conPermiso.test(p) && conAccion.test(p));
}
