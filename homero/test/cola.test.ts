import { describe, expect, it } from 'vitest';
import { correrSiguiente, PAUSA_IA, PAUSA_MANUAL, type DepsDeCola } from '../src/cola.js';
import type { Correo } from '../src/envio.js';
import { ErrorDeLimite } from '../src/ia.js';
import type { Recibido } from '../src/store.js';
import { MemoriaStore } from './memoria.js';

const casilla = { email: 'sincro.ventas@gmail.com', clave: 'x' };

function armar(opciones: { pedirIa?: (p: string) => Promise<string>; ahora?: Date } = {}) {
  let ahora = opciones.ahora ?? new Date('2026-09-29T17:00:00Z'); // martes 14hs AR
  const store = new MemoriaStore(() => ahora);
  const avisos: string[] = [];
  const enviados: string[] = [];
  const correo: Correo = {
    async enviar(_c, _r, m) {
      enviados.push(m.para);
      return { messageId: `<${enviados.length}@x>` };
    },
  };
  const deps: DepsDeCola = {
    store,
    correo,
    remitente: 'Gero · Sincro',
    casillas: [casilla],
    ahora: () => ahora,
    avisar: async (t) => {
      avisos.push(t);
    },
    pedirIa: opciones.pedirIa,
  };
  return { store, deps, avisos, enviados, mover: (d: Date) => (ahora = d) };
}

const mail: Recibido = {
  cuenta: casilla.email,
  messageId: '<a@b>',
  de: 'Ana <ana@distribuidora.com>',
  asunto: 'Re: facturas',
  cuerpo: 'Me interesa, ¿cómo sería?',
  recibidoEn: new Date('2026-09-29T16:00:00Z'),
};

const resumenOk = JSON.stringify({
  tipo: 'interesado',
  empresa: 'Distribuidora',
  resumen: 'Quiere saber más',
  sugerencia: 'Ofrecer reunión',
});

const envio = (para: string) => ({
  tipo: 'enviar_mail' as const,
  requiereIa: false,
  payload: { casilla: casilla.email, para, asunto: 'Hola', texto: 'Hola' },
});

describe('la cola frente al limite de Claude', () => {
  it('no corta: pausa la IA hasta el reset, reprograma sin gastar intento y avisa una vez', async () => {
    const { store, deps, avisos } = armar({
      pedirIa: async () => {
        throw new ErrorDeLimite('10:50pm (UTC)');
      },
    });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await store.encolar({ tipo: 'resumir_respuesta', payload: { ...mail, messageId: '<c@d>' }, requiereIa: true });

    await correrSiguiente(deps);

    const t = store.tareas[0]!;
    expect(t.estado).toBe('pendiente');
    expect(t.intentos).toBe(0);
    expect(t.disponibleDesde.toISOString()).toBe('2026-09-29T22:51:00.000Z');
    expect(await store.leerEstado(PAUSA_IA)).toMatchObject({ motivo: 'limite' });
    expect(avisos.filter((a) => a.includes('Me quedé sin uso'))).toHaveLength(1);

    // Con la IA en pausa, la segunda tarea ni se toma.
    expect(await correrSiguiente(deps)).toBe(false);
    expect(store.tareas[1]!.estado).toBe('pendiente');
  });

  it('mientras la IA esta en pausa sigue mandando los mails ya escritos', async () => {
    const { store, deps, enviados } = armar();
    await store.guardarEstado(PAUSA_IA, { hasta: '2026-09-29T22:51:00.000Z', motivo: 'limite' });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await store.encolar(envio('cliente@x.com'));

    await correrSiguiente(deps);

    expect(enviados).toEqual(['cliente@x.com']);
    expect(store.tareas[0]!.estado).toBe('pendiente');
  });

  it('cuando pasa el reset levanta la pausa, avisa y retoma la tarea', async () => {
    const { store, deps, avisos, mover } = armar({ pedirIa: async () => resumenOk });
    await store.guardarEstado(PAUSA_IA, { hasta: '2026-09-29T22:51:00.000Z', motivo: 'limite' });
    await store.encolar({
      tipo: 'resumir_respuesta',
      payload: mail,
      requiereIa: true,
      disponibleDesde: new Date('2026-09-29T22:51:00.000Z'),
    });

    mover(new Date('2026-09-29T22:52:00Z'));
    await correrSiguiente(deps);

    expect(await store.leerEstado(PAUSA_IA)).toBeUndefined();
    expect(store.tareas[0]!.estado).toBe('lista');
    expect(avisos.some((a) => a.includes('Vuelvo a usar Claude'))).toBe(true);
    expect(avisos.some((a) => a.includes('RESPONDIÓ') && a.includes('Distribuidora'))).toBe(true);
  });
});

describe('resumir respuestas', () => {
  it('una baja entra en la lista y nunca mas se le escribe', async () => {
    const { store, deps, enviados } = armar({
      pedirIa: async () => JSON.stringify({ tipo: 'baja', empresa: 'X', resumen: 'No escriban', sugerencia: '-' }),
    });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(await store.esBaja('ana@distribuidora.com')).toBe(true);

    await store.encolar(envio('ana@distribuidora.com'));
    await correrSiguiente(deps);
    expect(enviados).toEqual([]);
  });

  it('las respuestas automaticas no molestan a Gero', async () => {
    const { store, deps, avisos } = armar({
      pedirIa: async () =>
        JSON.stringify({ tipo: 'automatico', empresa: 'X', resumen: 'Fuera de oficina', sugerencia: '-' }),
    });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(avisos).toEqual([]);
  });

  it('si el modelo no devuelve JSON, el mail llega igual como "otro"', async () => {
    const { store, deps, avisos } = armar({ pedirIa: async () => 'no se' });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(avisos[0]).toContain('RESPONDIÓ (otro)');
  });
});

describe('otros errores y pausa manual', () => {
  it('un error comun reintenta con espera y gasta un intento', async () => {
    const { store, deps } = armar({
      pedirIa: async () => {
        throw new Error('se cayo algo');
      },
    });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(store.tareas[0]).toMatchObject({ estado: 'pendiente', intentos: 1 });
  });

  it('con /pausa no corre nada', async () => {
    const { store, deps } = armar({ pedirIa: async () => resumenOk });
    await store.guardarEstado(PAUSA_MANUAL, { desde: 'x' });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    expect(await correrSiguiente(deps)).toBe(false);
    expect(store.tareas[0]!.estado).toBe('pendiente');
  });

  it('fuera de horario el mail espera a la proxima ventana sin gastar intento', async () => {
    const { store, deps, enviados } = armar({ ahora: new Date('2026-10-03T13:00:00Z') }); // sabado
    await store.encolar(envio('cliente@x.com'));
    await correrSiguiente(deps);
    expect(enviados).toEqual([]);
    expect(store.tareas[0]).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(store.tareas[0]!.disponibleDesde.toISOString()).toBe('2026-10-05T12:00:00.000Z');
  });
});
