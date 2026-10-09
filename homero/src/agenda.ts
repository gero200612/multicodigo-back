import { randomBytes } from 'node:crypto';
import { HORAS_DE_DIFERENCIA } from './horas.js';

/**
 * La agenda de reuniones de Gero: lunes a viernes de 14 a 20, de 30 minutos
 * (antes de las 14 Gero no toma reuniones).
 *
 * Es propia (tablas homero.reuniones y homero.ocupados) porque Homero es el
 * unico que agenda. La invitacion viaja como .ics por mail, asi le aparece al
 * cliente y a Gero en el calendario que usen, sin conectar ninguno.
 */

const HORA = 60 * 60 * 1000;
const DURACION_MIN = 30;
const PRIMERA = 14 * 60; // 14:00
const ULTIMA = 19 * 60 + 30; // 19:30, la ultima que termina a las 20

/** Instante de un dia de Argentina (fecha en campos UTC) a una hora local. */
function aInstante(diaLocal: Date, minutos: number): Date {
  return new Date(
    Date.UTC(diaLocal.getUTCFullYear(), diaLocal.getUTCMonth(), diaLocal.getUTCDate()) +
      minutos * 60_000 +
      HORAS_DE_DIFERENCIA * HORA,
  );
}

/** `2026-09-30` del dia de Argentina de un instante. */
export function diaArgentino(d: Date): string {
  return new Date(d.getTime() - HORAS_DE_DIFERENCIA * HORA).toISOString().slice(0, 10);
}

/**
 * Tres horarios para ofrecer, en tres dias habiles distintos y a horas
 * distintas (primera hora de la tarde, media tarde, ultima hora): con tres
 * opciones variadas es mas facil que una le sirva a la primera.
 *
 * Arranca mañana: ofrecer "hoy en dos horas" da sensacion de apuro y casi
 * nadie lo agarra.
 */
export function horariosParaOfrecer(
  ahora: Date,
  tomados: Date[],
  ocupados: string[],
  cantidad = 3,
): Date[] {
  const preferidos = [15 * 60, 14 * 60 + 30, 18 * 60];
  const choca = (d: Date) =>
    tomados.some((t) => Math.abs(t.getTime() - d.getTime()) < DURACION_MIN * 60_000);
  const libres: Date[] = [];
  let dia = new Date(ahora.getTime() - HORAS_DE_DIFERENCIA * HORA + 24 * HORA);
  for (let vueltas = 0; libres.length < cantidad && vueltas < 20; vueltas++) {
    const esHabil = dia.getUTCDay() >= 1 && dia.getUTCDay() <= 5;
    if (esHabil && !ocupados.includes(dia.toISOString().slice(0, 10))) {
      const quiero = preferidos[libres.length % preferidos.length]!;
      for (let m = quiero; m <= ULTIMA; m += DURACION_MIN) {
        const cand = aInstante(dia, m);
        if (!choca(cand)) {
          libres.push(cand);
          break;
        }
      }
    }
    dia = new Date(dia.getTime() + 24 * HORA);
  }
  return libres;
}

/**
 * Los horarios libres para que Gero elija cuales ofrecer: tres por dia habil
 * (14:30, 16 y 18, o la siguiente media hora libre), desde mañana.
 */
export function horariosLibres(ahora: Date, tomados: Date[], ocupados: string[], cantidad = 6): Date[] {
  const preferidos = [14 * 60 + 30, 16 * 60, 18 * 60];
  const choca = (d: Date) =>
    tomados.some((t) => Math.abs(t.getTime() - d.getTime()) < DURACION_MIN * 60_000);
  const libres: Date[] = [];
  let dia = new Date(ahora.getTime() - HORAS_DE_DIFERENCIA * HORA + 24 * HORA);
  for (let vueltas = 0; libres.length < cantidad && vueltas < 20; vueltas++) {
    const esHabil = dia.getUTCDay() >= 1 && dia.getUTCDay() <= 5;
    if (esHabil && !ocupados.includes(dia.toISOString().slice(0, 10))) {
      for (const quiero of preferidos) {
        if (libres.length >= cantidad) break;
        for (let m = quiero; m <= ULTIMA; m += DURACION_MIN) {
          const cand = aInstante(dia, m);
          if (!choca(cand) && !libres.some((l) => l.getTime() === cand.getTime())) {
            libres.push(cand);
            break;
          }
        }
      }
    }
    dia = new Date(dia.getTime() + 24 * HORA);
  }
  return libres;
}

/** `true` si el horario sigue dentro de la franja y no choca con nada. */
export function sigueLibre(inicio: Date, tomados: Date[], ocupados: string[]): boolean {
  const local = new Date(inicio.getTime() - HORAS_DE_DIFERENCIA * HORA);
  const minutos = local.getUTCHours() * 60 + local.getUTCMinutes();
  const habil = local.getUTCDay() >= 1 && local.getUTCDay() <= 5;
  return (
    habil &&
    minutos >= PRIMERA &&
    minutos <= ULTIMA &&
    !ocupados.includes(diaArgentino(inicio)) &&
    !tomados.some((t) => Math.abs(t.getTime() - inicio.getTime()) < DURACION_MIN * 60_000)
  );
}

export function finDe(inicio: Date): Date {
  return new Date(inicio.getTime() + DURACION_MIN * 60_000);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** `martes 30/9 a las 15:00` */
export function horarioEnCastellano(d: Date): string {
  const l = new Date(d.getTime() - HORAS_DE_DIFERENCIA * HORA);
  const hh = String(l.getUTCHours()).padStart(2, '0');
  const mm = String(l.getUTCMinutes()).padStart(2, '0');
  return `${DIAS[l.getUTCDay()]} ${l.getUTCDate()}/${l.getUTCMonth() + 1} a las ${hh}:${mm}`;
}

const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** `mié 30/9 15:00`, para los botones. */
export function horarioCorto(d: Date): string {
  const l = new Date(d.getTime() - HORAS_DE_DIFERENCIA * HORA);
  const hh = String(l.getUTCHours()).padStart(2, '0');
  const mm = String(l.getUTCMinutes()).padStart(2, '0');
  return `${DIAS_CORTOS[l.getUTCDay()]} ${l.getUTCDate()}/${l.getUTCMonth() + 1} ${hh}:${mm}`;
}

/** Una sala de Jitsi con nombre imposible de adivinar. Gratis y sin cuenta. */
export function linkDeReunion(): string {
  return `https://meet.jit.si/Sincro-${randomBytes(6).toString('hex')}`;
}

function fechaIcs(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escaparIcs(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** La invitacion de calendario (RFC 5545) que va adjunta al mail. */
export function invitacionIcs(r: {
  uid: string;
  inicio: Date;
  fin: Date;
  titulo: string;
  descripcion: string;
  link: string;
  organizador: string;
  invitados: string[];
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sincro//Homero//ES',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${r.uid}`,
    `DTSTAMP:${fechaIcs(new Date())}`,
    `DTSTART:${fechaIcs(r.inicio)}`,
    `DTEND:${fechaIcs(r.fin)}`,
    `SUMMARY:${escaparIcs(r.titulo)}`,
    `DESCRIPTION:${escaparIcs(`${r.descripcion}\n\nLink: ${r.link}`)}`,
    `LOCATION:${escaparIcs(r.link)}`,
    `ORGANIZER;CN=Sincro:mailto:${r.organizador}`,
    ...r.invitados.map((i) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${i}`),
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reunión con Sincro',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
