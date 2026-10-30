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
    expect(taparTokens('token IGAAQWERTYuiop1234567890asdfgh y app 1410095257330902|abcdef0123456789abcdef')).toBe('token IG… y app 1410095257330902|…');
    expect(taparTokens('IGTV y IGNORAR quedan como están')).toBe('IGTV y IGNORAR quedan como están');
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

describe('bajarMedia', () => {
  it('corta un archivo de mas de 20 MB mientras baja, con o sin content-length', async () => {
    const { createServer } = await import('node:http');
    const { clienteMeta, ErrorDeMeta } = await import('../src/meta.js');
    const srv = createServer((req, res) => {
      if (req.url === '/chico') return res.end(Buffer.alloc(1000, 1));
      // Sin content-length (chunked): 25 MB de a 1 MB.
      if (req.url === '/grande-sin-largo') {
        let n = 0;
        const mandar = () => {
          if (n++ >= 25) return res.end();
          if (res.write(Buffer.alloc(1024 * 1024))) setImmediate(mandar);
          else res.once('drain', mandar);
        };
        return mandar();
      }
      res.setHeader('content-length', String(30 * 1024 * 1024));
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const meta = clienteMeta('v23.0');
    try {
      expect((await meta.bajarMedia('t', `${base}/chico`)).length).toBe(1000);
      await expect(meta.bajarMedia('t', `${base}/grande-sin-largo`)).rejects.toBeInstanceOf(ErrorDeMeta);
      await expect(meta.bajarMedia('t', `${base}/grande-con-largo`)).rejects.toThrow('demasiado grande');
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });
});

describe('clienteMeta: cuentas publicitarias', () => {
  it('si Meta rechaza me/adaccounts (usuario del sistema), usa las cuentas asignadas', async () => {
    const { createServer } = await import('node:http');
    const { clienteMeta } = await import('../src/meta.js');
    const pedidas: string[] = [];
    const srv = createServer((req, res) => {
      pedidas.push((req.url ?? '').split('?')[0]!);
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/me/adaccounts')) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: { message: '(#200) Missing Permissions', code: 200 } }));
      }
      if (req.url?.includes('/me/assigned_ad_accounts')) return res.end(JSON.stringify({ data: [{ id: 'act_980', name: 'Homer', currency: 'ARS' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const meta = clienteMeta('v23.0', `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    try {
      expect(await meta.cuentasPublicitarias('t', ['111'])).toEqual([{ id: 'act_980', nombre: 'Homer', moneda: 'ARS' }]);
      expect(pedidas).toEqual(['/v23.0/me/adaccounts', '/v23.0/me/assigned_ad_accounts']);
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });
});
