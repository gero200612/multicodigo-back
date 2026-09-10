/**
 * El codigo de una respuesta, para que Telegram lo muestre como consola.
 *
 * Reemplaza a `sanitizeForTelegram`, que BORRABA los bloques y dejaba
 * «codigo omitido — 3 lineas». Para un console.log o un mensaje de error eso
 * escondia justo lo que se venia a leer.
 *
 * El agente sigue explicando en prosa —eso no cambia, se lo pide el system
 * prompt— pero cuando pega algo corto ahora se ve monoespaciado y con el scroll
 * propio que Telegram le da al `<pre>`.
 *
 * ## Por que aca y no en `@multicodigo/shared`
 *
 * Ese paquete viene de un tag fijo (`#v0.1.5`), asi que tocarlo obliga a
 * publicarlo y actualizarlo en los tres servicios antes de que nada ande. Y
 * ademas esto es especifico de Telegram: el panel muestra el mismo texto en
 * HTML propio y no quiere estas etiquetas.
 */

/**
 * Cuantas lineas de un bloque se muestran.
 *
 * Veinte entran en la pantalla de un telefono sin empujar la explicacion fuera
 * de la vista. Mas que eso deja de ser "mira este fragmento" y pasa a ser un
 * volcado, que es lo que el system prompt le pide al agente que no haga.
 */
const TOPE_DE_LINEAS = 20;

/**
 * Escapa lo que Telegram interpreta como HTML.
 *
 * Los TRES caracteres y en este orden: el `&` primero, porque si fuera despues
 * volveria a escapar los `&` que acaban de introducir `&lt;` y `&gt;`.
 *
 * Sin esto, un `if (a < b)` en el codigo abre una etiqueta que nunca cierra y
 * Telegram rechaza el mensaje ENTERO con "can't parse entities" — la respuesta
 * no llega, no llega a medias.
 *
 * Exportada porque no es solo del codigo: cualquier texto que no escribimos
 * nosotros y termina en un mensaje con `parse_mode: 'HTML'` tiene que pasar por
 * aca. El texto de una tarea de la cola, el de un hueco que redacto el
 * analista, el mensaje de un error — los tres son texto libre, y los tres
 * viajan en mensajes con formato.
 */
export function escaparHtml(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Un bloque ya escapado, recortado si era largo. */
function bloque(lineas: string[]): string {
  if (lineas.length === 0) return '';
  const visibles = lineas.slice(0, TOPE_DE_LINEAS);
  const sobran = lineas.length - visibles.length;
  const cuerpo = escaparHtml(visibles.join('\n'));
  // El corte se DICE: un bloque que termina sin aviso parece la respuesta
  // completa, y quien la lee no sabe que le falta la mitad.
  const cola = sobran > 0 ? `\n… (${sobran} ${sobran === 1 ? 'linea' : 'lineas'} mas)` : '';
  return `<pre>${cuerpo}${cola}</pre>`;
}

/**
 * El Markdown de una linea, al HTML que Telegram entiende.
 *
 * El agente escribe Markdown —se lo pide el system prompt y es lo que sale
 * naturalmente de un modelo— y hasta ahora lo unico que se traducia eran los
 * backticks. Todo lo demas se ESCAPABA, asi que una lista llegaba al telefono
 * con los guiones a la vista y un titulo con los numerales adelante:
 *
 *     **6 bugs pendientes**        en vez de   6 bugs pendientes (en negrita)
 *     - Login: la sesion expira    en vez de   • Login: la sesion expira
 *     ## Debug                     en vez de   Debug (en negrita)
 *
 * Telegram no tiene Markdown y HTML a la vez: o se manda `parse_mode: HTML` o
 * `MarkdownV2`, y HTML ya es el que se usa —lo eligio el escapado, que es lo
 * que evita que un `<` suelto tire el mensaje entero—. Asi que la traduccion
 * se hace aca.
 *
 * Corre sobre texto YA ESCAPADO, y ese orden importa: despues del escapado no
 * queda ningun `<` del agente, asi que las etiquetas que se agregan aca son
 * las unicas del mensaje.
 *
 * Lo que NO se traduce, y a proposito:
 *
 * - El `_cursiva_` con guion bajo. `mi_variable_larga` es texto normal en este
 *   producto y se volveria cursiva por la mitad. El `*cursiva*` con asterisco
 *   si, que es inequivoco.
 * - Las tablas. Telegram no tiene, y fingirlas con espacios se rompe en
 *   cualquier pantalla angosta.
 */

/**
 * El separador de los huecos donde se guarda el codigo inline.
 *
 * Se arma con `fromCharCode` y no se escribe: es un caracter de control, no
 * puede venir del texto del agente, y en el fuente seria invisible.
 */
const HUECO = String.fromCharCode(0);

function conFormato(escapado: string): string {
  // El codigo inline se aparta ANTES de tocar nada: un `**` adentro de un
  // backtick es codigo, no negrita.
  const codigos: string[] = [];
  let t = escapado.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codigos.push(c);
    return `${HUECO}${codigos.length - 1}${HUECO}`;
  });

  // Titulo: en negrita y sin los numerales. Telegram no tiene tamaños de
  // texto, asi que la jerarquia es negrita o nada.
  t = t.replace(/^\s{0,3}#{1,6}\s+(.*)$/, '<b>$1</b>');

  // La vineta, antes que la cursiva: el `*` de una lista esta al principio de
  // la linea y si no se lo toma como apertura de enfasis.
  t = t.replace(/^(\s*)[-*+]\s+/, '$1• ');

  t = t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '<i>$1</i>');

  // `\\d` y no `\d`: adentro de un template literal, `\d` se colapsa a `d` y el
  // regex dejaria de buscar digitos.
  const hueco = new RegExp(`${HUECO}(\\d+)${HUECO}`, 'g');
  return t.replace(hueco, (_, i: string) => `<code>${codigos[Number(i)]}</code>`);
}

/**
 * Convierte la respuesta del agente al HTML que Telegram entiende.
 *
 * Devuelve HTML: quien lo mande tiene que usar `parse_mode: 'HTML'`. Todo el
 * texto —prosa incluida— sale escapado, asi que un `<div>` mencionado al pasar
 * tampoco rompe el mensaje.
 */
export function conCodigoParaTelegram(texto: string): string {
  const lineas = texto.split('\n');
  const salida: string[] = [];
  let dentro = false;
  let acumulado: string[] = [];

  for (const linea of lineas) {
    const limpia = linea.trim();
    // La misma regla que usaba `sanitizeForTelegram`: un ``` con mas backticks
    // en la misma linea es codigo inline, no una cerca.
    const esCerca = limpia.startsWith('```') && !limpia.slice(3).includes('```');

    if (esCerca) {
      if (dentro) {
        salida.push(bloque(acumulado));
        acumulado = [];
        dentro = false;
      } else {
        dentro = true;
      }
      continue;
    }

    if (dentro) acumulado.push(linea);
    else salida.push(conFormato(escaparHtml(linea)));
  }

  // Un bloque sin cerrar se muestra igual: pasa cuando el agente se queda sin
  // tokens a mitad de la respuesta, y ahi lo que escribio es justo lo que hay
  // que poder leer.
  if (dentro) salida.push(bloque(acumulado));

  // Los vacios se filtran para que un bloque sin contenido no deje una linea en
  // blanco donde antes habia algo.
  return salida.filter((l, i) => l !== '' || i === 0 || salida[i - 1] !== '').join('\n');
}

/**
 * El tope de un mensaje de Telegram: 4096 caracteres.
 *
 * No es una cifra prudente elegida por nosotros, es el limite de la API:
 * `sendMessage` contesta 400 "message is too long" y no manda nada.
 */
export const TOPE_DE_MENSAJE = 4096;

/**
 * Parte un mensaje largo en varios que Telegram si acepte.
 *
 * ## El bug que lo trajo
 *
 * En la corrida `despacho2` (2026-09-10) el plan salio de 5300 caracteres —ocho
 * tareas, dos de mas de 1100— y Telegram lo rechazo entero. La corrida quedo
 * con sus ocho tareas encoladas esperando un boton que nunca se dibujo, y en
 * silencio: el `.catch` del webhook manda el error a `app.log.error`, y el
 * servidor se crea con `logger: false`.
 *
 * Con las tareas cortas de `mesas` el mensaje entraba, asi que el limite estaba
 * ahi desde el principio y aparecio recien con un pliego rico. Los dos mensajes
 * que mas crecen son justo los que no se pueden perder: el plan —sin el, la
 * corrida no arranca— y el informe de la mañana.
 *
 * ## Por que corta por LINEAS
 *
 * Estos textos van con `parse_mode: 'HTML'` y sus etiquetas —`<b>`, `<code>`,
 * `<pre>`— abren y cierran DENTRO de una linea. Cortar en un salto de linea no
 * puede partir un par de etiquetas al medio; cortar por caracteres si, y
 * Telegram rechaza el pedazo con las etiquetas desbalanceadas — o sea que el
 * arreglo tendria el mismo sintoma que el bug.
 *
 * Una linea sola mas larga que el tope se parte igual, por caracteres, porque
 * la alternativa es no mandarla. No pasa hoy —la tarea mas larga medida son
 * 1251— pero el texto lo escribe un modelo y "no deberia" no alcanza.
 */
export function partirParaTelegram(texto: string, tope = TOPE_DE_MENSAJE): string[] {
  if (texto.length <= tope) return [texto];

  const partes: string[] = [];
  let actual = '';

  const cerrar = () => {
    if (actual !== '') partes.push(actual);
    actual = '';
  };

  for (const linea of texto.split('\n')) {
    // Una linea que ni sola entra: se parte por caracteres. Se cierra lo que
    // venia primero, para no mezclar.
    if (linea.length > tope) {
      cerrar();
      for (let i = 0; i < linea.length; i += tope) partes.push(linea.slice(i, i + tope));
      continue;
    }
    // El `+ 1` es el salto de linea que se agrega al pegarla.
    if (actual === '') actual = linea;
    else if (actual.length + 1 + linea.length <= tope) actual += `\n${linea}`;
    else {
      cerrar();
      actual = linea;
    }
  }
  cerrar();
  // Un texto de solo saltos de linea no deja ninguna parte, y mandar cero
  // mensajes seria el mismo silencio que se esta arreglando.
  return partes.length > 0 ? partes : [texto.slice(0, tope)];
}
