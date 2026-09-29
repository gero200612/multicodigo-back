/**
 * Horas de Argentina, que es donde estan Gero y los clientes.
 *
 * UTC-3 fijo: Argentina no tiene horario de verano. Mismo criterio que
 * `bridge/src/horas.ts`.
 */
export const HORAS_DE_DIFERENCIA = 3;
const HORA = 60 * 60 * 1000;

/** La fecha como la ve alguien en Argentina, en campos UTC. */
function local(d: Date): Date {
  return new Date(d.getTime() - HORAS_DE_DIFERENCIA * HORA);
}

/** Medianoche de Argentina del dia de `d`, como instante. */
export function inicioDelDia(d: Date): Date {
  const l = local(d);
  const medianoche = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  return new Date(medianoche + HORAS_DE_DIFERENCIA * HORA);
}

/** `14:05` en hora de Argentina. */
export function horaArgentina(d: Date): string {
  const l = local(d);
  return `${String(l.getUTCHours()).padStart(2, '0')}:${String(l.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * La ventana en la que se mandan mails: dias habiles, de 9 a 19 de Argentina.
 *
 * Devuelve `ahora` si ya esta adentro, o el proximo instante en que abre. Un
 * mail en frio que llega un domingo a las 3 de la mañana grita "robot".
 */
export function proximaVentanaDeEnvio(ahora: Date): Date {
  const DESDE = 9;
  const HASTA = 19;
  const l = local(ahora);
  const habil = (dia: number) => dia >= 1 && dia <= 5;

  if (habil(l.getUTCDay()) && l.getUTCHours() >= DESDE && l.getUTCHours() < HASTA) return ahora;

  // Arranca desde hoy a las 9 (si todavia no llego) o desde mañana.
  let cursor = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), DESDE);
  if (l.getUTCHours() >= DESDE) cursor += 24 * HORA;
  while (!habil(new Date(cursor).getUTCDay())) cursor += 24 * HORA;
  return new Date(cursor + HORAS_DE_DIFERENCIA * HORA);
}

const HORA_UTC = /^(\d{1,2}):(\d{2})\s*(am|pm)\s*\(?utc\)?$/i;
const HORA_SOLA_UTC = /^(\d{1,2})\s*(am|pm)\s*\(?utc\)?$/i;

/**
 * El instante del reset que anuncia el cartel de Anthropic ("10:50pm (UTC)").
 *
 * Copia de `instanteDeReset` del bridge, mas la forma sin minutos ("11pm
 * (UTC)"). El cartel dice la hora y no el dia: si ya paso, es la de mañana.
 */
export function instanteDeReset(texto: string, ahora: Date): Date | undefined {
  const t = texto.trim();
  const m = HORA_UTC.exec(t) ?? HORA_SOLA_UTC.exec(t);
  if (!m) return undefined;
  const conMinutos = m.length === 4;
  const hora12 = Number(m[1]);
  const minutos = conMinutos ? Number(m[2]) : 0;
  const esPm = (conMinutos ? m[3] : m[2])!.toLowerCase() === 'pm';
  if (hora12 < 1 || hora12 > 12 || minutos > 59) return undefined;

  const h24 = (hora12 % 12) + (esPm ? 12 : 0);
  const objetivo = Date.UTC(
    ahora.getUTCFullYear(),
    ahora.getUTCMonth(),
    ahora.getUTCDate(),
    h24,
    minutos,
  );
  return new Date(objetivo <= ahora.getTime() ? objetivo + 24 * HORA : objetivo);
}

/** Hora, minuto y dia de la semana en Argentina (0 = domingo). */
export function relojArgentino(d: Date): { hora: number; minuto: number; diaSemana: number } {
  const l = local(d);
  return { hora: l.getUTCHours(), minuto: l.getUTCMinutes(), diaSemana: l.getUTCDay() };
}

/** Suma dias habiles (lunes a viernes) manteniendo la hora. */
export function sumarDiasHabiles(d: Date, dias: number): Date {
  let t = d.getTime();
  let faltan = dias;
  while (faltan > 0) {
    t += 24 * HORA;
    const dia = local(new Date(t)).getUTCDay();
    if (dia >= 1 && dia <= 5) faltan--;
  }
  return new Date(t);
}
