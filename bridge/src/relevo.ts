/**
 * El relevo: cuando un slot se queda sin tokens, sigue otro.
 *
 * ## Por que el contexto se reinyecta como texto
 *
 * Lo primero que uno intenta es pasarle el `sessionId` al slot siguiente y
 * dejar que el SDK haga `resume`. No funciona, y no es un detalle de
 * implementacion: el transcript de una sesion vive en el HOME del slot
 * (`recetaDeSlot` monta `/srv/homes/<slot>` como `/home/agent`), asi que para
 * `c2` la sesion de `c1` no existe. Un `resume` con ese id falla.
 *
 * Compartir los transcripts entre slots lo arreglaria y rompe el aislamiento:
 * hoy cada slot ve solo su propio HOME, y eso es deliberado — ahi vive la sesion
 * de una cuenta de Claude.
 *
 * Asi que el contexto se reconstruye de `jobs`, que es el registro que el bridge
 * ya lleva de cada turno. **No es el mismo contexto**: se pierde el razonamiento
 * intermedio y las lecturas de archivos que el modelo hizo. Lo que NO se pierde
 * es el trabajo, que esta en el worktree del disco — y el worktree es compartido
 * por proyecto, no por slot.
 *
 * ## Que no hace
 *
 * No espera a que el limite se libere. Si no hay otro slot con cuenta, el turno
 * falla con `usage_limit` y el usuario ve por que. Reintentar contra el mismo
 * slot no sirve: el limite es de la cuenta y no se va reintentando.
 */

/** Cuantos turnos del hilo se le pasan al slot que releva. */
const TURNOS_DE_CONTEXTO = 6;

/** Tope de caracteres del resumen. Un prompt gigante gasta el token que se quiere ahorrar. */
const TOPE_CONTEXTO = 6000;

export interface Candidato {
  id: string;
  cuenta: boolean;
  arriba: boolean;
}

/**
 * A quien le toca seguir.
 *
 * Se pide la lista completa y se filtra aca en vez de preguntar "dame uno
 * libre": el gateway no sabe cuales ya se probaron en ESTE turno, y sin eso el
 * relevo puede volver al que ya fallo.
 *
 * `arriba` NO se mira: los slots estan apagados por defecto y el turno los
 * prende. Exigir que ya este corriendo dejaria el relevo sin candidatos justo
 * en el caso normal.
 */
export function proximoSlot(
  candidatos: Candidato[],
  yaProbados: readonly string[],
): string | undefined {
  return candidatos
    .filter((c) => c.cuenta && !yaProbados.includes(c.id))
    // Por id y no por el orden que devuelve el gateway: con un orden estable, el
    // relevo de un turno es reproducible y "c1 se agoto, sigue c2" es una frase
    // que se puede verificar.
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((c) => c.id)[0];
}

/**
 * El prompt con el que arranca el slot que releva.
 *
 * Se le dice explicitamente que es un relevo y que el trabajo esta en el disco.
 * Sin eso, el modelo recibe un pedido a mitad de camino sin saber que hubo un
 * antes, y lo mas probable es que empiece de cero y pise lo que ya estaba hecho.
 */
export function promptDeRelevo(
  original: string,
  turnos: ReadonlyArray<{ prompt: string; respuesta: string }>,
  slotAnterior: string,
): string {
  const hilo = turnos
    .slice(-TURNOS_DE_CONTEXTO)
    .map((t) => `Se te pidio: ${t.prompt}\nContestaste: ${t.respuesta}`)
    .join('\n\n');

  // Se recorta por el PRINCIPIO: los turnos mas nuevos son los que importan
  // para seguir, y son los que estan al final.
  const recortado =
    hilo.length > TOPE_CONTEXTO
      ? `[...se omitio el principio de la conversacion...]\n\n${hilo.slice(-TOPE_CONTEXTO)}`
      : hilo;

  const partes = [
    `Estas continuando el trabajo de otro agente (${slotAnterior}), que se quedo sin tokens.`,
    '',
    'IMPORTANTE: el codigo que se escribio hasta ahora YA ESTA en tu worktree, en',
    'disco. No lo rehagas: leelo primero y segui desde donde quedo.',
  ];

  if (recortado !== '') {
    partes.push('', 'Esto es lo que venia pasando:', '', recortado);
  } else {
    // Sin hilo previo el aviso igual sirve: el worktree puede tener cambios de
    // un turno que fallo antes de guardar su respuesta.
    partes.push('', 'No hay registro de los turnos anteriores, asi que revisa el estado del worktree.');
  }

  partes.push('', 'Y esto es lo que hay que hacer ahora:', '', original);
  return partes.join('\n');
}
