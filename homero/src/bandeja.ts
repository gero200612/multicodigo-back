import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { huellaDe, type ReporteDeError } from '@multicodigo/shared';
import { direccion } from './cola.js';
import type { Casilla } from './config.js';
import type { Recibido, Store } from './store.js';

/**
 * Lee los no leidos de una casilla. `procesar` se llama con todos juntos y,
 * recien si termina bien, se marcan como leidos: si guardar falla, el proximo
 * barrido los vuelve a ver en vez de perderlos.
 */
export interface Buzon {
  conNoLeidos(casilla: Casilla, procesar: (mails: Recibido[]) => Promise<void>): Promise<void>;
}

/** Tope por barrido: una casilla con mil mails viejos no puede trabar todo. */
const POR_BARRIDO = 50;

/** Lo que el buzon usa de ImapFlow: con esto un test le pasa un cliente falso. */
export type ClienteImap = Pick<
  ImapFlow,
  'connect' | 'getMailboxLock' | 'search' | 'fetch' | 'messageFlagsAdd' | 'logout' | 'close' | 'on'
>;

const clienteGmail = (casilla: Casilla): ClienteImap =>
  new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: casilla.email, pass: casilla.clave },
    logger: false,
  });

export interface OpcionesDelBuzon {
  log?: (m: string) => void;
  /** Al registro de errores del bridge. Nunca deberia tirar, pero igual se ataja. */
  reportar?: (r: ReporteDeError) => Promise<unknown>;
  crearCliente?: (casilla: Casilla) => ClienteImap;
}

export function crearBuzonGmail(o: OpcionesDelBuzon = {}): Buzon {
  const crearCliente = o.crearCliente ?? clienteGmail;
  return {
    async conNoLeidos(casilla, procesar) {
      const cliente = crearCliente(casilla);
      // ImapFlow emite 'error' cuando el socket se cae o vence un timeout. Un
      // EventEmitter sin listener de 'error' TIRA la excepcion fuera de toda
      // promesa: el 2026-10-08 eso tiro abajo a Homero entero por un timeout
      // de Gmail. Con el listener, el error queda en esta casilla: se cierra
      // este cliente (lo que estaba esperando rechaza y `revisarBandejas` lo
      // loguea) y el proximo barrido arma uno nuevo, o sea, reconecta solo.
      cliente.on('error', (err: unknown) => {
        const mensaje = err instanceof Error ? err.message : String(err);
        o.log?.(`[bandeja] ${casilla.email}: el IMAP se cayo (${mensaje}); reconecto en el proximo barrido`);
        try {
          cliente.close();
        } catch {
          // Ya estaba cerrado: no hay nada mas que hacer.
        }
        // Sin await: estamos en un handler de evento, no hay a quien esperar.
        void Promise.resolve()
          .then(() =>
            o.reportar?.({
              servicio: 'homero',
              codigo: 'imap',
              mensaje: `IMAP de ${casilla.email}: ${mensaje}`.slice(0, 500),
              // Por casilla y no por mensaje: el texto del timeout cambia y lo
              // que importa es que casilla esta fallando.
              huella: huellaDe('homero', 'imap', casilla.email),
              detalle: { casilla: casilla.email, error: mensaje },
            }),
          )
          .catch(() => undefined);
      });
      await cliente.connect();
      try {
        const lock = await cliente.getMailboxLock('INBOX');
        try {
          const uids = await cliente.search({ seen: false }, { uid: true });
          if (!uids || uids.length === 0) return;
          const tanda = uids.slice(0, POR_BARRIDO);
          const mails: Recibido[] = [];
          for await (const m of cliente.fetch(tanda, { source: true, uid: true }, { uid: true })) {
            if (!m.source) continue;
            const p = await simpleParser(m.source);
            mails.push({
              cuenta: casilla.email,
              // Sin Message-ID (raro, pero pasa) se usa el uid: igual deduplica
              // dentro de la casilla.
              messageId: p.messageId ?? `uid-${m.uid}`,
              de: p.from?.text ?? 'desconocido',
              asunto: p.subject ?? '(sin asunto)',
              cuerpo: p.text ?? '',
              recibidoEn: p.date ?? new Date(),
              enRespuestaA: p.inReplyTo,
            });
          }
          await procesar(mails);
          await cliente.messageFlagsAdd(tanda, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
      } finally {
        await cliente.logout().catch(() => undefined);
      }
    },
  };
}

/** El de produccion sin reportes; `main` usa `crearBuzonGmail` con el bridge. */
export const buzonGmail: Buzon = crearBuzonGmail();

// Avisos del servidor: no gastan IA. Los rebotes van a `alRebote`, que marca
// al lead y frena la casilla si rebotan muchos.
const DE_SISTEMA = /mailer-daemon|postmaster|no-?reply/i;
const REBOTE = /mailer-daemon|postmaster/i;

/**
 * Barre las casillas y encola el resumen de cada mail nuevo.
 *
 * Solo encola: el resumen usa la IA, y si Claude esta en pausa tiene que
 * esperar en la cola sin frenar la lectura de las bandejas.
 */
export async function revisarBandejas(deps: {
  store: Store;
  buzon: Buzon;
  casillas: Casilla[];
  log?: (m: string) => void;
  alRebote?: (r: Recibido) => Promise<void>;
}): Promise<number> {
  const propias = new Set(deps.casillas.map((c) => c.email));
  let nuevos = 0;
  for (const casilla of deps.casillas) {
    try {
      await deps.buzon.conNoLeidos(casilla, async (mails) => {
        for (const r of mails) {
          if (!(await deps.store.guardarRecibido(r))) continue;
          const de = direccion(r.de);
          if (REBOTE.test(de)) await deps.alRebote?.(r);
          if (propias.has(de) || DE_SISTEMA.test(de)) continue;
          const encolado = await deps.store.encolar({
            tipo: 'agente_atender',
            payload: r,
            requiereIa: true,
            clave: `resumir:${r.cuenta}:${r.messageId}`,
          });
          if (encolado) nuevos++;
        }
      });
    } catch (err) {
      // Una casilla caida no frena a las otras.
      deps.log?.(`[bandeja] ${casilla.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return nuevos;
}
