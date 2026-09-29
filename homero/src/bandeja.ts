import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
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

export const buzonGmail: Buzon = {
  async conNoLeidos(casilla, procesar) {
    const cliente = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: casilla.email, pass: casilla.clave },
      logger: false,
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

// Rebotes y avisos del servidor: no gastan IA. El manejo de rebotes (pausar
// la casilla si rebotan muchos) es de la fase 4.
const DE_SISTEMA = /mailer-daemon|postmaster|no-?reply/i;

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
}): Promise<number> {
  const propias = new Set(deps.casillas.map((c) => c.email));
  let nuevos = 0;
  for (const casilla of deps.casillas) {
    try {
      await deps.buzon.conNoLeidos(casilla, async (mails) => {
        for (const r of mails) {
          if (!(await deps.store.guardarRecibido(r))) continue;
          const de = direccion(r.de);
          if (propias.has(de) || DE_SISTEMA.test(de)) continue;
          const encolado = await deps.store.encolar({
            tipo: 'resumir_respuesta',
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
