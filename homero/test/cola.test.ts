import { describe, expect, it } from 'vitest';
import { correrSiguiente, PAUSA_IA, PAUSA_MANUAL } from '../src/cola.js';
import { SinLugar } from '../src/gateway.js';
import { ErrorDeLimite } from '../src/ia.js';
import type { Recibido } from '../src/store.js';
import { agenteDe, armar, casilla } from './armar.js';

const mail: Recibido = {
  cuenta: casilla.email,
  messageId: '<a@b>',
  de: 'Ana <ana@distribuidora.com>',
  asunto: 'Re: facturas',
  cuerpo: 'Me interesa, ¿cómo sería?',
  recibidoEn: new Date('2026-09-29T16:00:00Z'),
};

const envio = (para: string) => ({
  tipo: 'enviar_mail' as const,
  requiereIa: false,
  payload: { casilla: casilla.email, para, asunto: 'Hola', texto: 'Hola' },
});

/** El gateway falla siempre igual: lo que se prueba es como lo toma la cola. */
const gatewayQueTira = (err: () => Error) => async () => {
  throw err();
};

describe('la cola frente al limite de Claude', () => {
  it('no corta: pausa la IA hasta el reset, reprograma sin gastar intento y avisa una vez', async () => {
    // Sin uso en todas las cuentas: el gateway lo traduce a ErrorDeLimite con la hora.
    const { store, deps, avisos } = armar({ agente: gatewayQueTira(() => new ErrorDeLimite('10:50pm (UTC)')) });
    await store.encolar({ tipo: 'agente_atender', payload: mail, requiereIa: true });
    await store.encolar({ tipo: 'agente_atender', payload: { ...mail, messageId: '<c@d>' }, requiereIa: true });

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

  it('sin cuenta libre (Punchi las esta usando) reintenta en un rato, sin gastar intento, sin pausar la IA ni avisar', async () => {
    const { store, deps, avisos, enviados } = armar({ agente: gatewayQueTira(() => new SinLugar()) });
    await store.encolar({ tipo: 'agente_atender', payload: mail, requiereIa: true });
    await store.encolar({ tipo: 'agente_vender', payload: { leadId: 1 }, requiereIa: true });
    await store.crearLead({ nombre: 'X', rubro: 'contable', ciudad: 'Y', web: 'https://x.com.ar', fuente: 'agente' });

    await correrSiguiente(deps);

    expect(store.tareas[0]).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(store.tareas[0]!.disponibleDesde.toISOString()).toBe('2026-09-29T17:10:00.000Z');
    expect(await store.leerEstado(PAUSA_IA)).toBeUndefined();
    expect(avisos).toEqual([]);

    // No es un corte de la IA: la cola sigue tomando las demas tareas de IA.
    expect(await correrSiguiente(deps)).toBe(true);
    expect(store.tareas[1]).toMatchObject({ estado: 'pendiente', intentos: 0 });
    expect(avisos).toEqual([]);
    expect(enviados).toEqual([]);
    // Y no deja corridas: no llego a pensar nada.
    expect(store.corridasGuardadas).toEqual([]);
  });

  it('mientras la IA esta en pausa sigue mandando los mails ya escritos', async () => {
    const { store, deps, enviados } = armar();
    await store.guardarEstado(PAUSA_IA, { hasta: '2026-09-29T22:51:00.000Z', motivo: 'limite' });
    await store.encolar({ tipo: 'agente_atender', payload: mail, requiereIa: true });
    await store.encolar(envio('cliente@x.com'));

    await correrSiguiente(deps);

    expect(enviados.map((m) => m.para)).toEqual(['cliente@x.com']);
    expect(store.tareas[0]!.estado).toBe('pendiente');
  });

  it('cuando pasa el reset levanta la pausa, avisa y retoma la tarea', async () => {
    const { store, deps, avisos, mover } = armar({
      agente: agenteDe({
        atencion: async (usar) => {
          await usar('avisar_a_gero', { texto: 'Quiere saber más de la app de facturas.' });
        },
      }),
    });
    await store.guardarEstado(PAUSA_IA, { hasta: '2026-09-29T22:51:00.000Z', motivo: 'limite' });
    await store.encolar({
      tipo: 'agente_atender',
      payload: mail,
      requiereIa: true,
      disponibleDesde: new Date('2026-09-29T22:51:00.000Z'),
    });

    mover(new Date('2026-09-29T22:52:00Z'));
    await correrSiguiente(deps);

    expect(await store.leerEstado(PAUSA_IA)).toBeUndefined();
    expect(store.tareas[0]!.estado).toBe('lista');
    expect(avisos.some((a) => a.includes('Vuelvo a usar Claude'))).toBe(true);
    expect(avisos.some((a) => a.includes('ana@distribuidora.com') && a.includes('app de facturas'))).toBe(true);
  });

  it('una respuesta encolada con el tipo del guion viejo la atiende el agente', async () => {
    const { store, deps, corridas } = armar({
      agente: agenteDe({
        atencion: async (usar) => {
          await usar('cerrar_sin_responder', { motivo: 'fuera de oficina', tipo: 'automatico' });
        },
      }),
    });
    await store.encolar({ tipo: 'resumir_respuesta', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(store.tareas[0]!.estado).toBe('lista');
    expect(corridas[0]!.herramientas).toContain('proponer_respuesta');
  });
});

describe('otros errores y pausa manual', () => {
  it('un error comun reintenta con espera y gasta un intento', async () => {
    const { store, deps } = armar({ agente: gatewayQueTira(() => new Error('se cayo algo')) });
    await store.encolar({ tipo: 'agente_atender', payload: mail, requiereIa: true });
    await correrSiguiente(deps);
    expect(store.tareas[0]).toMatchObject({ estado: 'pendiente', intentos: 1 });
  });

  it('con /pausa no corre nada', async () => {
    const { store, deps } = armar();
    await store.guardarEstado(PAUSA_MANUAL, { desde: 'x' });
    await store.encolar({ tipo: 'agente_atender', payload: mail, requiereIa: true });
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
