/**
 * La hora que dice Anthropic, pasada a hora de Argentina.
 *
 * El cartel de "sin tokens" trae algo como `1:30am (UTC)` y se mostraba tal
 * cual. Quien lo lee esta en Argentina, asi que "vuelve a la 1:30am" significaba
 * tres horas mas tarde de lo que parecia — y esa hora es justo la que decide si
 * conviene esperar o cambiar de agente.
 *
 * ## Por que una resta y no `Intl`
 *
 * Lo que llega es una hora suelta, sin fecha: no hay un instante que convertir.
 * `Intl.DateTimeFormat` necesita un `Date`, y fabricarlo pide inventar un dia
 * —el de hoy en que zona?— para despues descartarlo. La resta trabaja con lo
 * que hay.
 *
 * Argentina es UTC-3 todo el año: no tiene horario de verano desde 2009, asi
 * que no hay una fecha que cambie el resultado. El dia que vuelva, esto es lo
 * que hay que revisar.
 */

/** Cuanto se le resta a UTC para llegar a Argentina. */
const HORAS_DE_DIFERENCIA = 3;

/**
 * `1:30am (UTC)` o `1:30am UTC`, con o sin mayusculas.
 *
 * La marca de zona es OBLIGATORIA en el patron: sin ella no se convierte nada.
 * Una hora sin zona puede ser uno que Anthropic ya dio en otra, y restarle tres
 * seria empeorarla.
 */
const HORA_UTC = /^(\d{1,2}):(\d{2})\s*(am|pm)\s*\(?utc\)?$/i;

/**
 * Devuelve la hora en Argentina, o el texto original si no la entiende.
 *
 * Nunca lanza y nunca inventa: un formato que Anthropic cambie manaña vuelve
 * tal cual, que es exactamente como se comportaba antes de esta funcion.
 * Mostrar la hora original es peor que mostrarla convertida, pero mucho mejor
 * que mostrar una convertida mal.
 */
export function aHoraArgentina(texto: string): string {
  const m = HORA_UTC.exec(texto.trim());
  if (!m) return texto;

  const hora12 = Number(m[1]);
  const minutos = Number(m[2]);
  const esPm = m[3]!.toLowerCase() === 'pm';
  if (hora12 < 1 || hora12 > 12 || minutos > 59) return texto;

  // A 24 horas antes de restar: sobre el numero visible, "12am menos 3" da 9am
  // en vez de 9pm. Las 12 son el unico caso donde el reloj de 12 no es lineal.
  let h24 = hora12 % 12;
  if (esPm) h24 += 12;

  // `+ 24` antes del modulo: sin eso, restarle 3 a la 1am da -2.
  const argentina = (h24 - HORAS_DE_DIFERENCIA + 24) % 24;

  const sufijo = argentina < 12 ? 'am' : 'pm';
  const mostrada = argentina % 12 === 0 ? 12 : argentina % 12;
  return `${mostrada}:${String(minutos).padStart(2, '0')}${sufijo}`;
}
