import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { reintentarPushes } from '../src/eventos.js';
import { HORA_MS } from '../src/horas.js';
import { armar, CLAVE_ADMIN, negocioConNumero, pedir, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('long-poll', () => {
  it('devuelve apenas llega un evento', async () => {
    const n = await negocioConNumero(b, ['leads']);
    const inicio = Date.now();
    const esperando = pedir(b, n.clave, 'GET', '/eventos?esperar=5');
    await tick();
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'hola'));
    const r = await esperando;
    expect(Date.now() - inicio).toBeLessThan(3000);
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(1);
    expect(r.json[0]).toMatchObject({ tipo: 'mensaje', datos: { contacto: '5491100000001', texto: 'hola' } });
    expect(typeof r.json[0].fecha).toBe('string');
  });

  it('sin eventos devuelve [] al cumplirse la espera', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=31')).json.code).toBe('invalido');
  });

  it('ack marca solo los del propio negocio', async () => {
    const a = await negocioConNumero(b, ['leads']);
    const otro = await negocioConNumero(b, ['leads']);
    await webhook(b, texto(a.phoneNumberId, '5491100000001', 'para A'));
    await webhook(b, texto(otro.phoneNumberId, '5491100000002', 'para B'));
    const deA = (await pedir(b, a.clave, 'GET', '/eventos?esperar=0')).json;
    const deB = (await pedir(b, otro.clave, 'GET', '/eventos?esperar=0')).json;
    expect(deA.map((e: any) => e.datos.texto)).toEqual(['para A']);
    expect(deB.map((e: any) => e.datos.texto)).toEqual(['para B']);

    // A intenta marcar el de B: no lo toca.
    const ack = await pedir(b, a.clave, 'POST', '/eventos/ack', { ids: [deA[0].id, deB[0].id] });
    expect(ack.json).toEqual({ ok: true, marcados: 1 });
    expect((await pedir(b, a.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
    expect((await pedir(b, otro.clave, 'GET', '/eventos?esperar=0')).json).toHaveLength(1);
  });

  it('los eventos de admin son aparte y solo con la clave de admin', async () => {
    const n = await negocioConNumero(b, ['avisos'], { tope: 1 });
    // Una alerta cualquiera: rechazar una plantilla.
    await b.store.crearAlerta({ clave: null, negocioId: n.id, tipo: 'x', texto: 'y', fecha: b.reloj.ahora });
    const { alertar } = await import('../src/alertas.js');
    await alertar(b.ctx, { negocioId: n.id, tipo: 'calidad', texto: 'bajó a amarilla' });
    const r = await pedir(b, CLAVE_ADMIN, 'GET', '/admin/eventos?esperar=0');
    expect(r.json).toEqual([
      expect.objectContaining({ tipo: 'alerta', datos: { tipo: 'calidad', negocio_id: n.id, texto: 'bajó a amarilla' } }),
    ]);
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
    await pedir(b, CLAVE_ADMIN, 'POST', '/admin/eventos/ack', { ids: [r.json[0].id] });
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/eventos?esperar=0')).json).toEqual([]);
  });
});

describe('push', () => {
  it('firma el cuerpo con el secreto de eventos y un 2xx cuenta como ack', async () => {
    const n = await negocioConNumero(b, ['leads'], { urlBase: 'http://app.interna:8080/' });
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'hola'));
    await tick();
    expect(b.pushes).toHaveLength(1);
    const p = b.pushes[0]!;
    expect(p.url).toBe('http://app.interna:8080/bot/mensaje');
    expect(p.firma).toBe(`sha256=${createHmac('sha256', n.secreto).update(p.cuerpo).digest('hex')}`);
    expect(JSON.parse(p.cuerpo)).toMatchObject({ tipo: 'mensaje', datos: { texto: 'hola' } });
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
  });

  it('reintenta con espera creciente y a la hora alerta app_caida; el evento queda para GET /eventos', async () => {
    const n = await negocioConNumero(b, ['leads'], { urlBase: 'http://app.interna' });
    b.pushOk.valor = false;
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'hola'));
    await tick();
    expect(b.pushes).toHaveLength(1);

    // Antes de los 30 s no reintenta.
    b.reloj.avanzar(20_000);
    await reintentarPushes(b.ctx);
    expect(b.pushes).toHaveLength(1);
    b.reloj.avanzar(15_000);
    await reintentarPushes(b.ctx);
    expect(b.pushes).toHaveLength(2);
    const ev = b.store.eventosT.find((e) => e.negocioId === n.id)!;
    expect(ev.intentos).toBe(2);
    // Despues del segundo fallo espera 1 min.
    expect(ev.proximoIntento!.getTime() - b.reloj.ahora.getTime()).toBe(60_000);

    b.reloj.avanzar(HORA_MS);
    await reintentarPushes(b.ctx);
    expect(b.store.alertasT.map((a) => a.tipo)).toEqual(['app_caida']);
    const pushesAlAlertar = b.pushes.length;
    b.reloj.avanzar(HORA_MS);
    await reintentarPushes(b.ctx);
    expect(b.pushes.length).toBe(pushesAlAlertar);
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toHaveLength(1);
  });
});
