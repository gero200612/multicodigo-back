import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { telefonoDeWhatsapp, TopePorIp } from '../src/formulario.js';
import { crearPublico } from '../src/publico.js';
import { armar, negocioConNumero, pedir, SECRETO_APP, VERIFY, type Banco } from './armar.js';

const WEB = 'https://sincro.apps.punchi.dev';

let b: Banco;
let publico: FastifyInstance;
let n: Awaited<ReturnType<typeof negocioConNumero>>;

beforeEach(async () => {
  b = armar();
  n = await negocioConNumero(b, ['leads']);
  publico = crearPublico(b.ctx, { appSecret: SECRETO_APP, verifyToken: VERIFY, formulario: { negocioId: n.id, origenes: [WEB] } });
});

const enviar = (cuerpo: unknown, extra: { origen?: string | null; ip?: string } = {}) =>
  publico.inject({
    method: 'POST',
    url: '/formulario',
    headers: {
      'content-type': 'application/json',
      ...(extra.origen === null ? {} : { origin: extra.origen ?? WEB }),
      'x-forwarded-for': extra.ip ?? '200.1.1.1',
    },
    payload: JSON.stringify(cuerpo),
  });

const eventos = async () => (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json as { tipo: string; datos: any }[];

const LAURA = { nombre: 'Laura', negocio: 'Panadería', whatsapp: '11 2345-6789', mail: 'Laura@Pan.com', tema: 'Stock que avisa', mensaje: 'Hola', acepta_whatsapp: true };

describe('el formulario de la web', () => {
  it('le llega a la app del negocio como evento formulario, con el teléfono listo para WhatsApp', async () => {
    const r = await enviar(LAURA);
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(WEB);
    const [e] = await eventos();
    expect(e).toMatchObject({
      tipo: 'formulario',
      datos: { nombre: 'Laura', negocio: 'Panadería', whatsapp: '5491123456789', mail: 'laura@pan.com', tema: 'Stock que avisa', acepta_whatsapp: true },
    });
  });

  it('sin número válido no queda aceptado WhatsApp, aunque haya tildado', async () => {
    await enviar({ nombre: 'Ana', mail: 'ana@x.com', whatsapp: '123', acepta_whatsapp: true });
    const [e] = await eventos();
    expect(e!.datos).toMatchObject({ whatsapp: null, acepta_whatsapp: false, mail: 'ana@x.com' });
  });

  it('sin WhatsApp ni mail, o sin nombre, no entra', async () => {
    expect((await enviar({ nombre: 'Ana' })).json().code).toBe('falta_contacto');
    expect((await enviar({ mail: 'a@b.com' })).statusCode).toBe(400);
    expect((await enviar({ nombre: 'x'.repeat(81), mail: 'a@b.com' })).statusCode).toBe(400);
    expect(await eventos()).toEqual([]);
  });

  it('el campo trampa: al bot se le dice que sí y no se emite nada', async () => {
    const r = await enviar({ ...LAURA, sitio: 'http://spam' });
    expect(r.statusCode).toBe(200);
    expect(await eventos()).toEqual([]);
  });

  it('solo desde la web del negocio: otro origen, o sin origen, es 403 y sin CORS', async () => {
    const otro = await enviar(LAURA, { origen: 'https://malo.com' });
    expect(otro.statusCode).toBe(403);
    expect(otro.headers['access-control-allow-origin']).toBeUndefined();
    expect((await enviar(LAURA, { origen: null })).statusCode).toBe(403);
    const pre = await publico.inject({ method: 'OPTIONS', url: '/formulario', headers: { origin: WEB } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
  });

  it('tope por IP: el sexto envío en diez minutos es 429; otra IP sigue pudiendo', async () => {
    for (let i = 0; i < 5; i++) expect((await enviar(LAURA, { ip: '9.9.9.9' })).statusCode).toBe(200);
    expect((await enviar(LAURA, { ip: '9.9.9.9' })).statusCode).toBe(429);
    expect((await enviar(LAURA, { ip: '8.8.8.8' })).statusCode).toBe(200);
    b.reloj.avanzar(10 * 60_000 + 1);
    expect((await enviar(LAURA, { ip: '9.9.9.9' })).statusCode).toBe(200);
  });

  it('un negocio sin leads no recibe el evento (las capacidades mandan)', async () => {
    const soloFacturas = await negocioConNumero(b, ['facturas']);
    const p = crearPublico(b.ctx, { appSecret: SECRETO_APP, verifyToken: VERIFY, formulario: { negocioId: soloFacturas.id, origenes: [WEB] } });
    const r = await p.inject({ method: 'POST', url: '/formulario', headers: { origin: WEB, 'content-type': 'application/json' }, payload: JSON.stringify(LAURA) });
    expect(r.statusCode).toBe(200);
    expect((await pedir(b, soloFacturas.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
  });

  it('sin FORMULARIO_NEGOCIO la ruta no existe', async () => {
    expect((await b.publico.inject({ method: 'POST', url: '/formulario', headers: { origin: WEB }, payload: '{}' })).statusCode).toBe(404);
  });
});

describe('telefonoDeWhatsapp', () => {
  it('arma el número argentino con el 9', () => {
    expect(telefonoDeWhatsapp('11 2345-6789')).toBe('5491123456789');
    expect(telefonoDeWhatsapp('011 15 2345 6789')).toBe('5491123456789');
    expect(telefonoDeWhatsapp('+54 9 11 2345 6789')).toBe('5491123456789');
    expect(telefonoDeWhatsapp('+54 11 2345 6789')).toBe('5491123456789');
    expect(telefonoDeWhatsapp('0351 15 123 4567')).toBe('5493511234567');
    expect(telefonoDeWhatsapp('+598 94 123 456')).toBe('59894123456');
    expect(telefonoDeWhatsapp('1234')).toBeUndefined();
    expect(telefonoDeWhatsapp(undefined)).toBeUndefined();
  });
});

describe('TopePorIp', () => {
  it('cuenta por ventana', () => {
    const t = new TopePorIp(2, 1000);
    expect(t.pasa('a', 0)).toBe(true);
    expect(t.pasa('a', 10)).toBe(true);
    expect(t.pasa('a', 20)).toBe(false);
    expect(t.pasa('a', 1001)).toBe(true);
  });
});
