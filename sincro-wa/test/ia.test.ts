import { beforeEach, describe, expect, it } from 'vitest';
import { TEXTO_FACTURA_ILEGIBLE, TEXTO_FACTURA_PDF, TEXTO_NO_ES_FACTURA } from '../src/ia.js';
import { liberarIa } from '../src/tareas.js';
import { armar, CLAVE_ADMIN, entrante, negocioConNumero, pedir, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const CLIENTE = '5491155555555';

async function fotoDeFactura(phoneNumberId: string) {
  b.meta.archivos.set('foto1', { mime: 'image/jpeg', datos: Buffer.from('JPEG...') });
  await webhook(b, entrante(phoneNumberId, CLIENTE, { type: 'image', image: { id: 'foto1', mime_type: 'image/jpeg' } }));
}

const ok = (salida: unknown) => ({ ok: true, salida, modelo: 'sonnet', chars_entrada: 4000, chars_salida: 400 });

describe('facturas', () => {
  it('foto → trabajo para Homero → contesta "Cargada" y le pasa la factura a la app', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    await fotoDeFactura(n.phoneNumberId);

    const pend = await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0');
    expect(pend.json).toHaveLength(1);
    const t = pend.json[0];
    expect(t).toMatchObject({ negocio_id: n.id, tipo: 'factura', entrada: { mime: 'image/jpeg' } });

    const archivo = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/ia/${t.id}/archivo`);
    expect(archivo.res.headers['content-type']).toBe('image/jpeg');
    expect(archivo.res.rawPayload.toString()).toBe('JPEG...');

    // Tomado: no vuelve a salir.
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json).toEqual([]);

    const datos = { proveedor: 'Edesur', cuit: '30-1', numero: 'A-1', fecha: '2026-10-01', vencimiento: '2026-10-18', total: 48230, moneda: 'ARS', impuestos: [{ nombre: 'IVA', monto: 8370 }] };
    const r = await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t.id}/resultado`, ok({ es_factura: true, datos, falta: [] }));
    expect(r.json).toEqual({ ok: true });
    expect(b.meta.enviados.at(-1)).toMatchObject({ a: CLIENTE, texto: 'Cargada: Edesur, $48.230, vence el 18/10' });

    const ev = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(ev).toEqual([expect.objectContaining({ tipo: 'factura', datos: { contacto: CLIENTE, media_id: t.entrada.media_id, datos } })]);
    // Y la app puede bajar la foto.
    expect((await pedir(b, n.clave, 'GET', `/media/${t.entrada.media_id}`)).status).toBe(200);

    // Uso de IA registrado: 1000 tokens de entrada y 100 de salida.
    expect(b.store.usoIaT[0]).toMatchObject({ negocioId: n.id, capacidad: 'facturas', tokensEntrada: 1000, tokensSalida: 100 });
    expect(b.store.usoIaT[0]!.costoUsd).toBeCloseTo(0.003 + 0.0015);
    // Ya resuelto: no se puede mandar de nuevo.
    expect((await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t.id}/resultado`, ok({ es_factura: false }))).status).toBe(409);
  });

  it('incompleta pregunta lo que falta y no carga; no-factura lo dice', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    await fotoDeFactura(n.phoneNumberId);
    let [t] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t.id}/resultado`, ok({ es_factura: true, datos: { proveedor: 'X' }, falta: ['vencimiento'] }));
    expect(b.meta.enviados.at(-1)!.texto).toBe('No llego a leer el vencimiento. ¿Me mandás otra foto donde se vea bien?');

    b.meta.archivos.set('foto2', { mime: 'image/png', datos: Buffer.from('PNG') });
    await webhook(b, entrante(n.phoneNumberId, CLIENTE, { type: 'image', image: { id: 'foto2', mime_type: 'image/png' } }));
    [t] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t.id}/resultado`, ok({ es_factura: false }));
    expect(b.meta.enviados.at(-1)!.texto).toBe(TEXTO_NO_ES_FACTURA);
    expect(b.store.eventosT.filter((e) => e.tipo === 'factura')).toEqual([]);
  });

  it('un PDF recibe el pedido de foto; si la IA falla, "no la pude leer"', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    b.meta.archivos.set('pdf1', { mime: 'application/pdf', datos: Buffer.from('%PDF') });
    await webhook(b, entrante(n.phoneNumberId, CLIENTE, { type: 'document', document: { id: 'pdf1', mime_type: 'application/pdf' } }));
    expect(b.meta.enviados.at(-1)!.texto).toBe(TEXTO_FACTURA_PDF);
    expect(b.store.trabajosT).toEqual([]);

    await fotoDeFactura(n.phoneNumberId);
    const [t] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t.id}/resultado`, { ok: false, error: 'timeout' });
    expect(b.meta.enviados.at(-1)!.texto).toBe(TEXTO_FACTURA_ILEGIBLE);
  });

  it('un trabajo tomado sin resultado vuelve a pendientes a los 10 min', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    await fotoDeFactura(n.phoneNumberId);
    const [t] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    b.reloj.avanzar(9 * 60_000);
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json).toEqual([]);
    b.reloj.avanzar(2 * 60_000);
    await liberarIa(b.ctx);
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json.map((x: any) => x.id)).toEqual([t.id]);
  });
});

describe('atender', () => {
  it('contesta con el contexto y la charla; al derivar deja de contestar hasta que la app libera', async () => {
    const n = await negocioConNumero(b, ['atender']);
    expect((await pedir(b, n.clave, 'PUT', '/atender/contexto', { texto: 'Abrimos de 9 a 18.' })).json).toEqual({ ok: true });

    await webhook(b, texto(n.phoneNumberId, CLIENTE, 'hola'));
    await webhook(b, texto(n.phoneNumberId, CLIENTE, '¿a qué hora abren?'));
    // Dos mensajes seguidos: un solo trabajo con la charla entera.
    const pend = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    expect(pend).toHaveLength(1);
    expect(pend[0].entrada).toEqual({
      contexto: 'Abrimos de 9 a 18.',
      charla: [
        { direccion: 'entra', texto: 'hola' },
        { direccion: 'entra', texto: '¿a qué hora abren?' },
      ],
      negocio: 'Negocio atender',
    });
    // La app no recibe mensajes de una charla que atiende la IA.
    expect(b.store.eventosT.filter((e) => e.tipo === 'mensaje')).toEqual([]);

    await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${pend[0].id}/resultado`, ok({ respuesta: 'De 9 a 18.', derivar: false }));
    expect(b.meta.enviados.at(-1)).toMatchObject({ a: CLIENTE, texto: 'De 9 a 18.' });

    await webhook(b, texto(n.phoneNumberId, CLIENTE, 'quiero hablar con una persona'));
    const [t2] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json;
    await pedir(b, CLAVE_ADMIN, 'POST', `/admin/ia/${t2.id}/resultado`, ok({ respuesta: 'Te paso con alguien.', derivar: true, motivo: 'pidió una persona' }));
    const derivar = b.store.eventosT.find((e) => e.tipo === 'derivar')!;
    expect(derivar.datos).toEqual({ contacto: CLIENTE, motivo: 'pidió una persona' });
    expect((await pedir(b, n.clave, 'GET', `/charlas/${CLIENTE}`)).json.derivada).toBe(true);

    // Derivada: el mensaje va a la app y no a la IA.
    await webhook(b, texto(n.phoneNumberId, CLIENTE, 'hola?'));
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json).toEqual([]);
    expect(b.store.eventosT.filter((e) => e.tipo === 'mensaje').map((e) => e.datos.texto)).toEqual(['hola?']);
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: CLIENTE, texto: 'Hola, soy Ana' })).status).toBe(200);

    expect((await pedir(b, n.clave, 'POST', `/charlas/${CLIENTE}/liberar`)).json).toEqual({ ok: true });
    await webhook(b, texto(n.phoneNumberId, CLIENTE, 'gracias'));
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/ia/pendientes?esperar=0')).json).toHaveLength(1);
  });
});
