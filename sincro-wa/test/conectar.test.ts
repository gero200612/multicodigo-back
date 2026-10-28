import { beforeEach, describe, expect, it } from 'vitest';
import { descifrar } from '../src/cifrado.js';
import { tokenDe } from '../src/contexto.js';
import { armar, CLAVE_ADMIN, negocioConNumero, pedir, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const WABA = '20000000001';
const PHONE = '30000000001';

/** Un negocio sin numero, como lo da de alta Gero para una empresa que todavia no conecto. */
async function negocioSinNumero(capacidades: string[]) {
  const alta = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', {
    nombre: 'Efaysto',
    app: 'efaysto-crm',
    capacidades,
    tope_mensual_ars: 100_000,
    quien: 'gero',
  });
  return { id: alta.json.negocio.id as number, clave: alta.json.clave as string };
}

const conectar = (clave: string, extra: Record<string, unknown> = {}) =>
  pedir(b, clave, 'POST', '/conectar', { codigo: `codigo-${WABA}`, phone_number_id: PHONE, waba_id: WABA, ...extra });

describe('conectar (Embedded Signup)', () => {
  beforeEach(() => {
    b.meta.numerosPorWaba.set(WABA, [PHONE]);
    b.meta.datos = { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', status: 'CONNECTED', verified_name: 'Efaysto', display_phone_number: '+54 9 11 5555-0000' };
  });

  it('canjea el código, suscribe la app, registra el número con un PIN y lo guarda con su token', async () => {
    const n = await negocioSinNumero(['conectar']);
    const r = await conectar(n.clave);
    expect(r.status).toBe(200);
    expect(r.json.numero).toMatchObject({ phone_number_id: PHONE, waba_id: WABA, telefono: '+54 9 11 5555-0000', nombre: 'Efaysto', calidad: 'GREEN', tope_meta: 1000, coexistencia: false, token_caido: false });
    expect(JSON.stringify(r.json)).not.toMatch(/EAA|pin/i);

    const numero = (await b.store.numeroPorPhoneId(PHONE))!;
    expect(numero.negocioId).toBe(n.id);
    expect(tokenDe(b.ctx, numero)).toBe(`EAAcliente${WABA}xxxxxxxx`);
    const registro = b.meta.conexion.find((c) => c.tipo === 'registrar')!;
    expect(registro.pin).toMatch(/^\d{6}$/);
    expect(descifrar(b.ctx.claveCifrado, numero.pinCifrado!)).toBe(registro.pin);
    expect(b.meta.conexion.map((c) => c.tipo)).toEqual(['canje', 'suscribir', 'registrar']);

    const conexion = await pedir(b, n.clave, 'GET', '/conexion');
    expect(conexion.json.numeros).toHaveLength(1);
    expect((await b.store.cambios(n.id)).map((c) => c.campo)).toContain('numero');
  });

  it('con coexistencia no registra el número y pide contactos e historial', async () => {
    const n = await negocioSinNumero(['conectar']);
    const r = await conectar(n.clave, { coexistencia: true });
    expect(r.status).toBe(200);
    expect(r.json.numero.coexistencia).toBe(true);
    expect(b.meta.conexion.filter((c) => c.tipo === 'registrar')).toEqual([]);
    expect(b.meta.conexion.filter((c) => c.tipo === 'sincronizar').map((c) => c.sync)).toEqual(['smb_app_state_sync', 'history']);
  });

  it('reconectar el mismo número cambia el token, usa el mismo PIN y destraba los envíos', async () => {
    const n = await negocioSinNumero(['conectar', 'puente']);
    await conectar(n.clave);
    const antes = (await b.store.numeroPorPhoneId(PHONE))!;
    await b.store.cambiarNumero(antes.id, { tokenCaido: true });
    const pin = b.meta.conexion.find((c) => c.tipo === 'registrar')!.pin;

    b.meta.conexion = [];
    const r = await conectar(n.clave);
    expect(r.status).toBe(200);
    expect(r.json.numero.token_caido).toBe(false);
    expect(b.meta.conexion.find((c) => c.tipo === 'registrar')!.pin).toBe(pin);
    expect((await b.store.numerosDe(n.id))).toHaveLength(1);
    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos.map((e: { tipo: string; datos: { estado: string } }) => e.datos.estado)).toContain('token_ok');
  });

  it('un número que ya es de otro negocio no se toca', async () => {
    const otro = await negocioConNumero(b, ['leads']);
    b.meta.numerosPorWaba.set(WABA, [otro.phoneNumberId]);
    const n = await negocioSinNumero(['conectar']);
    const r = await conectar(n.clave, { phone_number_id: otro.phoneNumberId });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('de_otro_negocio');
    expect(b.meta.conexion).toEqual([]);
  });

  it('no le cree al navegador: la WABA tiene que ser la del token y el número de esa WABA', async () => {
    const n = await negocioSinNumero(['conectar']);
    const otraWaba = await conectar(n.clave, { waba_id: '20000000999' });
    expect([otraWaba.status, otraWaba.json.code]).toEqual([409, 'waba_ajena']);

    const otroNumero = await conectar(n.clave, { phone_number_id: '30000000999' });
    expect([otroNumero.status, otroNumero.json.code]).toEqual([409, 'numero_ajeno']);

    b.meta.tokenDeOtraApp = true;
    const ajeno = await conectar(n.clave);
    expect([ajeno.status, ajeno.json.code]).toEqual([409, 'token_invalido']);

    expect(b.meta.conexion.filter((c) => c.tipo !== 'canje')).toEqual([]);
    expect(await b.store.numeroPorPhoneId(PHONE)).toBeUndefined();
  });

  it('un código que Meta rechaza vuelve como 502 con el detalle', async () => {
    const n = await negocioSinNumero(['conectar']);
    const r = await conectar(n.clave, { codigo: 'vencido-0000000' });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: 'meta' });
    expect(r.json.detalle).toContain('Invalid verification code');
  });

  it('sin la capacidad la ruta no existe, y sin META_APP_ID contesta sin_configurar', async () => {
    const sin = await negocioSinNumero(['puente']);
    expect((await conectar(sin.clave)).status).toBe(404);
    expect((await pedir(b, sin.clave, 'GET', '/conexion')).status).toBe(404);

    const n = await negocioSinNumero(['conectar']);
    b.ctx.appMeta = undefined;
    const r = await conectar(n.clave);
    expect([r.status, r.json.code]).toEqual([503, 'sin_configurar']);
  });
});

describe('coexistencia: lo que se contesta desde el celu', () => {
  it('queda en la charla como mensaje que sale, sin pasarle nada a la app', async () => {
    const n = await negocioConNumero(b, ['puente']);
    const eco = {
      object: 'whatsapp_business_account',
      entry: [{ id: n.wabaId, changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: n.phoneNumberId }, message_echoes: [{ from: '5491155550000', to: '5491141879467', id: 'wamid.eco.1', timestamp: '1760108400', type: 'text', text: { body: 'Te llamo en un rato' } }] } }] }],
    };
    expect((await webhook(b, eco)).statusCode).toBe(200);
    expect((await webhook(b, eco)).statusCode).toBe(200);
    const charla = await b.store.charla(n.id, '5491141879467', 10);
    expect(charla).toHaveLength(1);
    expect(charla[0]).toMatchObject({ direccion: 'sale', texto: 'Te llamo en un rato', costoEstimado: 0 });
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toEqual([]);
  });
});
