import nodemailer from 'nodemailer';
import type { Casilla } from './config.js';
import { inicioDelDia, proximaVentanaDeEnvio } from './horas.js';
import type { Store } from './store.js';

export interface MailSaliente {
  para: string;
  asunto: string;
  texto: string;
  /** Message-ID del mail al que se contesta, para que quede en el mismo hilo. */
  enRespuestaA?: string;
}

/** El transporte, aparte para poder testear sin Gmail. */
export interface Correo {
  enviar(casilla: Casilla, remitente: string, m: MailSaliente): Promise<{ messageId?: string }>;
}

export const correoGmail: Correo = {
  async enviar(casilla, remitente, m) {
    const t = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: casilla.email, pass: casilla.clave },
    });
    const info = await t.sendMail({
      from: { name: remitente, address: casilla.email },
      to: m.para,
      subject: m.asunto,
      text: m.texto,
      inReplyTo: m.enRespuestaA,
      references: m.enRespuestaA,
      // Gmail y Yahoo lo piden a quien manda en cantidad. Una respuesta con
      // "baja" la toma la bandeja y el remitente entra en homero.bajas.
      list: { unsubscribe: { url: `mailto:${casilla.email}?subject=baja`, comment: 'baja' } },
    });
    return { messageId: info.messageId };
  },
};

const TOPE_DIARIO = 25;
const DIA = 24 * 60 * 60 * 1000;

/**
 * Cuantos mails puede mandar hoy una casilla.
 *
 * Calentamiento: 5 por dia al principio, +3 cada dos dias, hasta 25. Una
 * casilla nueva que manda 25 el primer dia es exactamente lo que Gmail marca
 * como spam.
 */
export function cupoDelDia(primerEnvio: Date | undefined, ahora: Date): number {
  if (!primerEnvio) return 5;
  const dias = Math.max(
    0,
    Math.round((inicioDelDia(ahora).getTime() - inicioDelDia(primerEnvio).getTime()) / DIA),
  );
  return Math.min(TOPE_DIARIO, 5 + 3 * Math.floor(dias / 2));
}

export type ResultadoDeEnvio =
  | { tipo: 'enviado'; messageId?: string }
  | { tipo: 'baja' }
  | { tipo: 'esperar'; hasta: Date; motivo: 'fuera_de_horario' | 'sin_cupo' };

export interface DepsDeEnvio {
  store: Store;
  correo: Correo;
  remitente: string;
  ahora: () => Date;
}

/**
 * Manda un mail respetando las reglas que NO se le dejan al modelo: la lista
 * de bajas, el horario y el cupo diario de la casilla.
 *
 * `prueba` saltea el horario (para /probar_mail un domingo), no el cupo.
 */
export async function enviarMail(
  deps: DepsDeEnvio,
  casilla: Casilla,
  m: MailSaliente,
  opciones: { prueba?: boolean } = {},
): Promise<ResultadoDeEnvio> {
  const ahora = deps.ahora();
  if (await deps.store.esBaja(m.para)) return { tipo: 'baja' };

  if (!opciones.prueba) {
    const ventana = proximaVentanaDeEnvio(ahora);
    if (ventana.getTime() > ahora.getTime()) {
      return { tipo: 'esperar', hasta: ventana, motivo: 'fuera_de_horario' };
    }
  }

  const cupo = cupoDelDia(await deps.store.primerEnvio(casilla.email), ahora);
  const hechos = await deps.store.enviosDesde(casilla.email, inicioDelDia(ahora));
  if (hechos >= cupo) {
    const manana = new Date(inicioDelDia(ahora).getTime() + DIA);
    return { tipo: 'esperar', hasta: proximaVentanaDeEnvio(manana), motivo: 'sin_cupo' };
  }

  const { messageId } = await deps.correo.enviar(casilla, deps.remitente, m);
  await deps.store.registrarEnvio({ cuenta: casilla.email, para: m.para, asunto: m.asunto, messageId });
  return { tipo: 'enviado', messageId };
}
