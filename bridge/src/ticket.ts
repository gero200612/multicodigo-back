/**
 * `/ticket` desde Telegram: arma el MISMO pedido que el formulario Ticket del
 * panel, para que el agente lo trate igual y la cola de tickets de Actividad lo
 * muestre al lado de los del panel (los reconoce por el `[TICKET · …]` del
 * principio).
 *
 * El texto de los permisos y del análisis funcional es copia del que arma el
 * front (`multicodigo-front/src/app/punchi/preferencias.ts` y `tickets.ts`):
 * si cambia allá, cambia acá.
 */

const TIPOS: Record<string, string> = {
  bug: 'Bug',
  error: 'Bug',
  mejora: 'Mejora',
  cambio: 'Cambio',
  nuevo: 'Funcionalidad nueva',
  funcionalidad: 'Funcionalidad nueva',
};

export const USO_DE_TICKET =
  '/ticket <título>\n<descripción en las líneas de abajo>\n\n' +
  'Opcional: empezá el título con bug:, mejora:, cambio: o nuevo: para el tipo.\n' +
  'Con nuevo: (una funcionalidad grande) va como pliego: se parte en tareas y se reparte.';

/** Lo que se le pide para el análisis funcional (igual que el panel). */
export const PEDIDO_DE_ANALISIS = [
  'ANÁLISIS FUNCIONAL (prendido): al terminar el cambio,',
  '1. Sacá capturas con `mirar` (guardar_para_analisis=true) de las pantallas que cambiaste. Las capturas son OBLIGATORIAS: si mirar falla, leé el error y arreglalo (instalá dependencias con la tarea install, probá otra ruta, entrá con el usuario de prueba del proyecto) y volvé a intentar. Si las pantallas salen sin datos y en ellas el cambio no se ve, decilo en tu mensaje final y pedí que carguen una cuenta de demo con datos en Repositorios → el proyecto.',
  '2. Con las capturas, llamá a `analisis_funcional` con un título, un resumen y una sección por pantalla, nombrando las capturas que te devolvió mirar.',
  'Si después de intentarlo no hay forma de sacar capturas, NO armes el análisis sin ellas: decímelo en tu mensaje final, con el error exacto de mirar.',
  'Escribilo para el cliente: qué cambió, dónde se ve y cómo probarlo, sin jerga de código.',
].join('\n');

const PERMISOS = [
  'PERMISOS:',
  '- Hacelo directamente, de punta a punta: NO me muestres el plan ni me pidas OK del enfoque.',
  '- Preguntame SOLO si tenés una duda real que no podés resolver mirando el código, y en ese caso una sola pregunta concreta. Lo que sea una decisión razonable, tomala vos y contá en tu respuesta qué decidiste.',
  '- Antes de desplegar en las apps vinculadas, mostrame qué vas a publicar y dónde, y esperá mi OK.',
  '- Al terminar: commiteá y pusheá tu rama (no a main).',
  '- Cerrá SIEMPRE con un mensaje escrito para mí: qué hiciste, en qué rama quedó y cómo probarlo. Nunca termines sin escribir nada.',
].join('\n');

/**
 * El prompt del ticket, o `undefined` si no vino título.
 *
 * Primera línea = título (con un `tipo:` opcional adelante); el resto, la
 * descripción. Sin descripción, el título hace de las dos: un ticket de una
 * línea ("bug: el login no anda en Safari") es lo más común por chat.
 */
/** El tipo de ticket que va como PLIEGO (corrida) y no como un turno. */
export const TIPO_GRANDE = 'Funcionalidad nueva';

/** Título, tipo y descripción de lo que vino atrás de `/ticket`. */
export function partirTicket(texto: string): { tipo: string; titulo: string; descripcion: string } | undefined {
  const lineas = texto.split('\n');
  let titulo = (lineas[0] ?? '').trim();
  if (!titulo) return undefined;
  let tipo = 'Mejora';
  const m = /^([a-záéíóú]+)\s*:\s*(.+)$/i.exec(titulo);
  const clave = m?.[1]?.toLowerCase();
  if (m && clave && TIPOS[clave]) {
    tipo = TIPOS[clave]!;
    titulo = m[2]!.trim();
  }
  return { tipo, titulo, descripcion: lineas.slice(1).join('\n').trim() || titulo };
}

/**
 * El pliego de una funcionalidad nueva: va por `/corrida`, que la parte en
 * tareas chicas y las reparte. Un turno solo con algo grande termina a medias.
 */
export function pliegoDeTicket(titulo: string, descripcion: string): string {
  return [
    `# ${titulo}`,
    '',
    descripcion,
    '',
    '## Cómo trabajar',
    '- Es una funcionalidad nueva sobre el proyecto existente: respetá su estructura, estilos y convenciones.',
    '- Al terminar, análisis funcional con capturas de las pantallas nuevas.',
  ].join('\n');
}

export function armarTicket(texto: string, proyecto: string): string | undefined {
  const t = partirTicket(texto);
  if (!t) return undefined;
  const { tipo, titulo, descripcion } = t;
  return [
    `[TICKET · ${tipo} · prioridad Media] ${titulo}`,
    `Proyecto: ${proyecto}`,
    'Pedido desde Telegram. Ubicá vos en qué repo del proyecto va el cambio.',
    '',
    'DESCRIPCIÓN:',
    descripcion,
    '',
    PERMISOS,
    '',
    PEDIDO_DE_ANALISIS,
  ].join('\n');
}
