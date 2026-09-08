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

/**
 * Cuanto se le resta a UTC para llegar a Argentina.
 *
 * Exportada porque el techo de hora de una corrida la necesita: `hasta=07:00`
 * es una hora de reloj de acá, y el servidor corre en UTC. Una segunda copia
 * del numero en `corrida.ts` es una copia que se separa el dia que Argentina
 * vuelva a tener horario de verano.
 */
export const HORAS_DE_DIFERENCIA = 3;

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

/**
 * El INSTANTE en que vuelve una cuenta, a partir del cartel de Anthropic.
 *
 * `aHoraArgentina` traduce el texto para mostrarlo; esto lo convierte en un
 * momento para poder esperarlo. Son dos cosas distintas y por eso son dos
 * funciones: una se lee, la otra se compara con un reloj.
 *
 * ## Por que adivinar el dia SI se puede aca
 *
 * El comentario de `aHoraArgentina` dice que armar un `Date` obliga a adivinar
 * si la hora es hoy o mañana, y que adivinar mal muestra "vuelve ayer". Eso vale
 * para MOSTRAR. Para esperar, la regla es clara y no es una adivinanza: el reset
 * siempre esta en el futuro, asi que si la hora ya paso, es la de mañana. Es la
 * misma cuenta que hace `limiteDeHora` con el techo de una corrida.
 *
 * Devuelve `undefined` cuando no entiende el texto, y quien llama tiene que
 * tratar eso como "no se cuando vuelve" — nunca como "vuelve ya".
 */
export function instanteDeReset(texto: string, ahora: Date): Date | undefined {
  const m = HORA_UTC.exec(texto.trim());
  if (!m) return undefined;

  const hora12 = Number(m[1]);
  const minutos = Number(m[2]);
  const esPm = m[3]!.toLowerCase() === 'pm';
  if (hora12 < 1 || hora12 > 12 || minutos > 59) return undefined;

  let h24 = hora12 % 12;
  if (esPm) h24 += 12;

  const objetivo = Date.UTC(
    ahora.getUTCFullYear(),
    ahora.getUTCMonth(),
    ahora.getUTCDate(),
    h24,
    minutos,
  );
  // Si ya paso, es el de mañana. Un reset "en el pasado" seria un cartel que
  // llego tarde, y esperar cero seria reintentar contra una cuenta agotada.
  const UN_DIA = 24 * 60 * 60 * 1000;
  return new Date(objetivo <= ahora.getTime() ? objetivo + UN_DIA : objetivo);
}

/**
 * Un instante, como hora de reloj de Argentina: `5:30am`.
 *
 * Distinta de `aHoraArgentina`, que traduce el TEXTO del cartel de Anthropic.
 * Esta parte de un `Date` — el que devolvio `instanteDeReset` — y existe porque
 * reconstruir el texto del cartel para volver a traducirlo era dar dos vueltas
 * sobre el mismo dato.
 */
export function horaArgentinaDe(cuando: Date): string {
  const local = new Date(cuando.getTime() - HORAS_DE_DIFERENCIA * 60 * 60 * 1000);
  const h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const sufijo = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}${sufijo}`;
}
