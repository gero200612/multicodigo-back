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
 */
function escapar(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Un bloque ya escapado, recortado si era largo. */
function bloque(lineas: string[]): string {
  if (lineas.length === 0) return '';
  const visibles = lineas.slice(0, TOPE_DE_LINEAS);
  const sobran = lineas.length - visibles.length;
  const cuerpo = escapar(visibles.join('\n'));
  // El corte se DICE: un bloque que termina sin aviso parece la respuesta
  // completa, y quien la lee no sabe que le falta la mitad.
  const cola = sobran > 0 ? `\n… (${sobran} ${sobran === 1 ? 'linea' : 'lineas'} mas)` : '';
  return `<pre>${cuerpo}${cola}</pre>`;
}

/**
 * El codigo inline de un backtick, a `<code>`.
 *
 * Se aplica sobre texto YA escapado, asi que el contenido no puede traer
 * etiquetas. Un backtick sin cerrar queda como esta: no es un delimitador, es
 * una comilla.
 */
function inline(texto: string): string {
  return texto.replace(/`([^`\n]+)`/g, '<code>$1</code>');
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
    else salida.push(inline(escapar(linea)));
  }

  // Un bloque sin cerrar se muestra igual: pasa cuando el agente se queda sin
  // tokens a mitad de la respuesta, y ahi lo que escribio es justo lo que hay
  // que poder leer.
  if (dentro) salida.push(bloque(acumulado));

  // Los vacios se filtran para que un bloque sin contenido no deje una linea en
  // blanco donde antes habia algo.
  return salida.filter((l, i) => l !== '' || i === 0 || salida[i - 1] !== '').join('\n');
}
