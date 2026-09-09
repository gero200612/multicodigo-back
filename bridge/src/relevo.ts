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
  /** true si lo esta usando alguien ahora mismo. */
  ocupado?: boolean;
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
 *
 * `ocupado` SI se mira, y es lo contrario: un slot que esta usando otra persona
 * no es un candidato. Relevar ahi manda el turno contra un 409 y se pierde un
 * intento de los tres que hay, ademas de mostrarle el aviso de ocupado a quien
 * pregunto por otra cosa.
 */
export function proximoSlot(
  candidatos: Candidato[],
  yaProbados: readonly string[],
): string | undefined {
  return candidatos
    .filter((c) => c.cuenta && !c.ocupado && !yaProbados.includes(c.id))
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
    '',
    // De DONDE sale, que es lo que antes no se decia y volvia falso el aviso de
    // arriba en cuanto el otro slot habia construido algo. Cada tarea que
    // cierra se mergea a main y tu worktree se rebasea sobre `origin/main`, asi
    // que lo de antes llega por ahi. Si ese merge fallo no llego, y entonces
    // sigue estando en la rama del otro slot — que este worktree ve, porque el
    // clone es compartido.
    `Te llega por main: cada tarea que cierra se mergea ahi y tu worktree se`,
    `actualiza contra origin/main antes de cada turno. Si algo no aparece, el`,
    `merge de esa tarea puede haber fallado: mira la rama claude/${slotAnterior}/trabajo,`,
    `que este repo ya tiene, antes de escribir una linea de cero.`,
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

/**
 * De que slots quedo el trabajo de una corrida.
 *
 * ## Por que existe
 *
 * El informe decia `claude/c2/*` cuando el trabajo estaba en
 * `claude/c1/trabajo`, y por el mismo camino la feature de publicar preguntaba
 * por el worktree del slot equivocado, no encontraba `package.json` y salteaba
 * el repo en silencio. Verificado en la corrida `gastos` del 2026-09-09 — ver
 * `multicodigo-vm/docs/RETOMAR-relevo-agente.md`.
 *
 * La causa eran dos datos que NO dicen quien trabajo: `cola_tareas.agente`
 * guardaba el asignado, y `getActiveAgent` devuelve el ultimo slot activo, que
 * suele ser el del analista. Ahora la tarea guarda el agente REAL al cerrarse
 * —`cerrarTarea` lo recibe de `ejecutarTurnoConRelevo`, que ya lo sabia— y esta
 * funcion lo lee de ahi. Es un registro, no una adivinanza: la alternativa
 * —que el gateway busque solo en que slot esta el trabajo— anda, pero deja el
 * dato mintiendo para cualquier otro consumidor.
 *
 * ## Por que devuelve una LISTA
 *
 * Con cowork puede haber varios slots construyendo el mismo proyecto a la vez,
 * cada uno con commits en su rama. No hay una rama que sea "la" del trabajo:
 * estan todas, y todas van a main. Devolver una sola obligaria a elegir, y
 * elegir aca es perder el trabajo del otro.
 *
 * Solo las `lista`: una tarea que fallo no dejo nada que mergear y una
 * pendiente ni empezo. Nombrar su slot es volver a mandar a una rama vacia.
 *
 * El orden es el de `posicion`, o sea el orden en que se trabajo. Importa
 * porque `publicar()` mergea en ese orden: el primero entra limpio y el
 * segundo, si toco los mismos archivos, puede conflictuar — y que conflictue
 * el ultimo es lo que reproduce la secuencia real.
 */
export function agentesQueTrabajaron(
  tareas: ReadonlyArray<{ agente: string; estado: string; posicion: number }>,
): string[] {
  const listas = [...tareas]
    .filter((t) => t.estado === 'lista')
    .sort((a, b) => a.posicion - b.posicion);
  return [...new Set(listas.map((t) => t.agente))];
}

/**
 * A quien le toca la proxima tarea de una corrida.
 *
 * ## Por que no alcanza con el relevo
 *
 * `proximoSlot` corre cuando una cuenta YA se agoto: es reactivo, y con seis
 * cuentas eso significa quemar la primera hasta el limite antes de tocar la
 * segunda. Esto reparte ANTES, por rotacion, para que ninguna cargue la noche
 * entera. El relevo sigue existiendo y hace lo suyo si el elegido igual falla.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-09-reparto-por-capacidad-design.md`.
 *
 * ## Por que circular y por orden
 *
 * Se sigue por el ORDEN y no por la posicion del anterior en la lista, y eso
 * importa porque el anterior puede no estar: se apago, lo tomo otra persona, o
 * se agoto justo despues de trabajar. Buscar su posicion obligaria a decidir que
 * hacer cuando no aparece, y la respuesta natural —volver al primero— haria que
 * el reparto se caiga siempre en el mismo slot.
 *
 * `undefined` significa "no hay a quien darsela", y NO se inventa un slot: quien
 * llama cae al agente con que se encolo la tarea, que es el comportamiento de
 * hoy.
 */
export function slotParaLaTarea(
  candidatos: Candidato[],
  agotados: readonly string[],
  ultimo: string | undefined,
): string | undefined {
  // Mismo filtro que el relevo, mas los agotados: mandarle trabajo a una cuenta
  // sin tokens gasta un intento y no produce nada — el turno vuelve con
  // `usage_limit` y recien ahi actua el relevo.
  const elegibles = candidatos
    .filter((c) => c.cuenta && !c.ocupado && !agotados.includes(c.id))
    // Numerico, para que `c10` no se cuele entre `c1` y `c2`.
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((c) => c.id);

  if (elegibles.length === 0) return undefined;
  if (ultimo === undefined) return elegibles[0];

  // El primero que viene DESPUES del anterior en el orden; si no hay ninguno,
  // se cerro la vuelta y arranca otra.
  return elegibles.find((id) => id.localeCompare(ultimo, 'en', { numeric: true }) > 0)
    ?? elegibles[0];
}
