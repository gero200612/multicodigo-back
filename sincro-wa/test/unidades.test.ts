import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { categoriasPermitidas, rutaPermitida } from '../src/capacidades.js';
import { cifrar, descifrar } from '../src/cifrado.js';
import { generarClave, hashDeClave, mismaClave, negocioDeClave } from '../src/claves.js';
import { mesDe, rangoDelMes } from '../src/horas.js';
import { textoDeFactura } from '../src/ia.js';
import { topeDeTier } from '../src/meta.js';
import { costoDeIa, esAlta, esBaja } from '../src/reglas.js';
import { taparTokens } from '../src/tapar.js';
import { firmaValida } from '../src/webhook.js';
import { firmar } from './armar.js';

describe('taparTokens', () => {
  it('tapa los tokens de Meta y las claves de app', () => {
    const t = taparTokens('Malformed access token EAAGm0PX4ZCpsBAKZCZBabc123_- y clave swa_12_abcDEF-_123');
    expect(t).toBe('Malformed access token EAA… y clave swa_…');
    expect(t).not.toContain('EAAGm0');
  });
  it('deja tranquilo lo que no es token', () => {
    expect(taparTokens('EAA corto y texto normal')).toBe('EAA corto y texto normal');
  });
});

describe('cifrado', () => {
  it('ida y vuelta, y con otra clave no abre', () => {
    const clave = randomBytes(32);
    const c = cifrar(clave, 'EAAsecreto');
    expect(c).not.toContain('EAAsecreto');
    expect(descifrar(clave, c)).toBe('EAAsecreto');
    expect(() => descifrar(randomBytes(32), c)).toThrow();
  });
});

describe('claves', () => {
  it('tienen la forma del contrato y se verifican por hash', () => {
    const clave = generarClave(7);
    expect(clave).toMatch(/^swa_7_[A-Za-z0-9_-]{43}$/);
    expect(negocioDeClave(clave)).toBe(7);
    expect(mismaClave(clave, hashDeClave(clave))).toBe(true);
    expect(mismaClave(generarClave(7), hashDeClave(clave))).toBe(false);
    expect(mismaClave(clave, null)).toBe(false);
    expect(negocioDeClave('swa_7_corta')).toBeUndefined();
  });
});

describe('bajas', () => {
  it.each(['baja', 'BAJA', 'Stop', 'no me escriban más', 'dejá de escribirme', 'quiero desuscribirme', 'no quiero mas mensajes'])(
    '"%s" es baja',
    (t) => expect(esBaja(t)).toBe(true),
  );
  it('un parrafo largo que dice stop no es baja', () => {
    expect(esBaja('Hola, quería consultar por el turno del martes porque el stop del auto hace ruido y no sé si llegan')).toBe(false);
    expect(esBaja('hola')).toBe(false);
  });
  it('alta', () => {
    expect(esAlta('ALTA')).toBe(true);
    expect(esAlta(' alta! ')).toBe(true);
    expect(esAlta('quiero dar de alta un turno')).toBe(false);
  });
});

describe('meta', () => {
  it('tope por tier', () => {
    expect(topeDeTier('TIER_250')).toBe(250);
    expect(topeDeTier('TIER_1K')).toBe(1000);
    expect(topeDeTier('TIER_100K')).toBe(100_000);
    expect(topeDeTier('TIER_UNLIMITED')).toBeNull();
    expect(topeDeTier(undefined)).toBeUndefined();
  });
});

describe('costos', () => {
  it('IA: chars/4 a 3 y 15 USD por millón', () => {
    const c = costoDeIa(4_000_000, 400_000);
    expect(c.tokensEntrada).toBe(1_000_000);
    expect(c.tokensSalida).toBe(100_000);
    expect(c.costoUsd).toBeCloseTo(3 + 1.5);
  });
});

describe('horas', () => {
  it('el mes es el de Argentina', () => {
    expect(mesDe(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10');
    expect(mesDe(new Date('2026-11-01T03:00:00Z'))).toBe('2026-11');
    expect(rangoDelMes('2026-12').hasta.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });
});

describe('capacidades', () => {
  it('facturas solo ve media y lo comun', () => {
    expect(rutaPermitida(['facturas'], 'GET /media/:id')).toBe(true);
    expect(rutaPermitida(['facturas'], 'GET /yo')).toBe(true);
    expect(rutaPermitida(['facturas'], 'POST /mensajes')).toBe(false);
    expect(rutaPermitida(['facturas'], 'POST /avisos')).toBe(false);
  });
  it('categorias de plantilla', () => {
    expect([...categoriasPermitidas(['avisos'])]).toEqual(['UTILITY']);
    expect([...categoriasPermitidas(['promociones'])]).toEqual(['MARKETING']);
    expect(categoriasPermitidas(['facturas', 'leads']).size).toBe(0);
  });
});

describe('texto de factura', () => {
  it('cargada', () => {
    expect(
      textoDeFactura({ es_factura: true, datos: { proveedor: 'Edesur', total: 48230, vencimiento: '2026-10-18' }, falta: [] }),
    ).toBe('Cargada: Edesur, $48.230, vence el 18/10');
  });
  it('incompleta pregunta lo que falta', () => {
    expect(textoDeFactura({ es_factura: true, datos: {}, falta: ['total', 'vencimiento'] })).toBe(
      'No llego a leer el total y el vencimiento. ¿Me mandás otra foto donde se vea bien?',
    );
  });
  it('no es factura', () => {
    expect(textoDeFactura({ es_factura: false })).toBe('Eso no parece una factura. Mandame una foto de la factura y la cargo.');
  });
});

describe('firma del webhook', () => {
  it('sobre el cuerpo crudo', () => {
    const cuerpo = Buffer.from('{"a": 1}');
    expect(firmaValida(cuerpo, firmar('{"a": 1}', 's'), 's')).toBe(true);
    expect(firmaValida(Buffer.from('{"a":1}'), firmar('{"a": 1}', 's'), 's')).toBe(false);
    expect(firmaValida(cuerpo, undefined, 's')).toBe(false);
    expect(firmaValida(cuerpo, 'sha256=zz', 's')).toBe(false);
  });
});
