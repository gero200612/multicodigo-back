/**
 * Quien es el bot.
 *
 * Existe porque el bot no tenia nombre: `/menu` te tiraba derecho al selector
 * de "que Claude queres" y todo lo que decia sonaba como si lo dijera el agente
 * conectado. Son dos cosas distintas y hay que separarlas — Punchi es quien te
 * atiende, y C1 es a quien le pasa el trabajo.
 *
 * En un modulo propio y no como una constante en `telegram.ts` para que el
 * nombre este en UN lugar: repartido por veinte plantillas, renombrarlo deja la
 * mitad de los mensajes hablando del anterior.
 */
export const NOMBRE = 'Punchi';

/**
 * El saludo de la primera vez, y el de `/start`.
 *
 * Dice tres cosas y en este orden: quien es, que hace y que hacer ahora. El
 * anterior no decia ninguna: era la lista de agentes, que a alguien que abre el
 * bot por primera vez no le dice nada.
 */
export function saludo(): string {
  return [
    `Soy <b>${NOMBRE}</b>.`,
    '',
    'Le paso tu trabajo a los agentes que tengas cargados, te traigo lo que ' +
      'contestan, y te pregunto antes de que toquen algo.',
    '',
    'Elegi que queres hacer:',
  ].join('\n');
}

/**
 * El encabezado del menu para quien ya lo conoce.
 *
 * Sin el saludo: repetir la presentacion cada vez que se abre el menu es leer
 * lo mismo veinte veces. `/start` saluda, `/menu` no.
 */
export function encabezadoDeMenu(): string {
  return `<b>${NOMBRE}</b> — que queres hacer:`;
}
