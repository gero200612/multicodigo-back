import { EventEmitter } from 'node:events';
import { huellaDe, type ReporteDeError } from '@multicodigo/shared';
import { describe, expect, it } from 'vitest';
import { crearBuzonGmail, revisarBandejas, type Buzon, type ClienteImap } from '../src/bandeja.js';
import type { Recibido } from '../src/store.js';
import { esDuenio, partir } from '../src/telegram.js';
import { MemoriaStore } from './memoria.js';

const casillas = [
  { email: 'sincro.ventas@gmail.com', clave: 'x' },
  { email: 'sincro.automatiza@gmail.com', clave: 'y' },
];

const mail = (de: string, id: string): Recibido => ({
  cuenta: casillas[0]!.email,
  messageId: id,
  de,
  asunto: 'Re: hola',
  cuerpo: 'hola',
  recibidoEn: new Date(),
});

describe('revisarBandejas', () => {
  it('encola un resumen por mail nuevo y no repite los que ya vio', async () => {
    const store = new MemoriaStore();
    const buzon: Buzon = {
      async conNoLeidos(c, procesar) {
        if (c.email === casillas[0]!.email) await procesar([mail('Ana <ana@x.com>', '<1>')]);
      },
    };
    expect(await revisarBandejas({ store, buzon, casillas })).toBe(1);
    expect(await revisarBandejas({ store, buzon, casillas })).toBe(0);
    expect(store.tareas).toHaveLength(1);
  });

  it('ignora rebotes y mails entre las propias casillas', async () => {
    const store = new MemoriaStore();
    const buzon: Buzon = {
      async conNoLeidos(_c, procesar) {
        await procesar([
          mail('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', '<2>'),
          mail('Gero <sincro.automatiza@gmail.com>', '<3>'),
        ]);
      },
    };
    await revisarBandejas({ store, buzon, casillas });
    expect(store.tareas).toHaveLength(0);
  });

  it('una casilla caida no frena a las otras', async () => {
    const store = new MemoriaStore();
    const buzon: Buzon = {
      async conNoLeidos(c, procesar) {
        if (c.email === casillas[0]!.email) throw new Error('login fallido');
        await procesar([{ ...mail('Ana <ana@x.com>', '<4>'), cuenta: c.email }]);
      },
    };
    expect(await revisarBandejas({ store, buzon, casillas })).toBe(1);
  });
});

describe('telegram', () => {
  it('solo el chat configurado es dueño; sin configurar, nadie', () => {
    expect(esDuenio(123, 123)).toBe(true);
    expect(esDuenio(123, 456)).toBe(false);
    expect(esDuenio(undefined, 123)).toBe(false);
  });

  it('parte los mensajes largos por renglones', () => {
    const texto = Array.from({ length: 10 }, (_, i) => `renglon ${i} ${'x'.repeat(500)}`).join('\n');
    const partes = partir(texto, 2000);
    expect(partes.every((p) => p.length <= 2000)).toBe(true);
    expect(partes.join('\n')).toBe(texto);
  });
});

describe('crearBuzonGmail', () => {
  /**
   * Un ImapFlow falso: se cuelga en getMailboxLock y al rato emite 'error',
   * como el timeout de Gmail que tiro abajo a Homero. Sin listener de 'error'
   * el emit tira fuera de toda promesa y vitest lo marca como excepcion suelta.
   */
  class ImapQueSeCae extends EventEmitter {
    cerrado = false;
    private rechazar?: (e: Error) => void;
    async connect() {}
    getMailboxLock() {
      return new Promise<never>((_ok, rechazar) => {
        this.rechazar = rechazar;
        setImmediate(() => this.emit('error', new Error('Socket timeout')));
      });
    }
    close() {
      this.cerrado = true;
      this.rechazar?.(new Error('Connection not available'));
    }
    async logout() {}
  }

  it('un IMAP que emite error no tira el proceso: cierra ese cliente, reporta y el proximo barrido reconecta', async () => {
    const store = new MemoriaStore();
    const clientes: ImapQueSeCae[] = [];
    const reportes: ReporteDeError[] = [];
    const logs: string[] = [];
    const buzon = crearBuzonGmail({
      log: (m) => logs.push(m),
      reportar: async (r) => {
        reportes.push(r);
      },
      crearCliente: () => {
        const c = new ImapQueSeCae();
        clientes.push(c);
        return c as unknown as ClienteImap;
      },
    });

    // Una casilla caida no frena a la otra, y el ciclo no tira.
    expect(await revisarBandejas({ store, buzon, casillas, log: (m) => logs.push(m) })).toBe(0);
    expect(clientes).toHaveLength(2);
    expect(clientes.every((c) => c.cerrado)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(reportes.map((r) => [r.servicio, r.codigo, r.huella])).toEqual([
      ['homero', 'imap', huellaDe('homero', 'imap', casillas[0]!.email)],
      ['homero', 'imap', huellaDe('homero', 'imap', casillas[1]!.email)],
    ]);
    expect(logs.some((l) => l.includes('Socket timeout'))).toBe(true);

    // El proximo barrido arma clientes nuevos: eso es reconectar.
    await revisarBandejas({ store, buzon, casillas });
    expect(clientes).toHaveLength(4);
  });

  it('un reportar que tira no rompe el barrido', async () => {
    const buzon = crearBuzonGmail({
      reportar: async () => {
        throw new Error('el bridge no esta');
      },
      crearCliente: () => new ImapQueSeCae() as unknown as ClienteImap,
    });
    expect(await revisarBandejas({ store: new MemoriaStore(), buzon, casillas })).toBe(0);
    await new Promise((r) => setImmediate(r));
  });
});
