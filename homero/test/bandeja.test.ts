import { describe, expect, it } from 'vitest';
import { revisarBandejas, type Buzon } from '../src/bandeja.js';
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
