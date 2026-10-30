import { beforeEach, describe, expect, it } from 'vitest';
import { HORA_MS } from '../src/horas.js';
import { armar, CLAVE_ADMIN, negocioConNumero, pedir, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const IG = '17841400000000001';
const PAGINA = '10000000000001';
const PERSONA = '1784140000000555';
const OTRA = '5161000000000777';
let mid = 1;

/** Una cuenta de Instagram o de Messenger dada de alta como lo haria Homero. */
async function cuenta(negocioId: number, canal: 'instagram' | 'messenger', cuentaId: string) {
  const r = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/numeros', { negocio_id: negocioId, phone_number_id: cuentaId, waba_id: PAGINA, canal, quien: 'gero' });
  expect(r.status).toBe(201);
}

const mensaje = (objeto: 'instagram' | 'page', cuentaId: string, de: string, texto: string) => ({
  object: objeto,
  entry: [{ id: cuentaId, time: 1760108400, messaging: [{ sender: { id: de }, recipient: { id: cuentaId }, timestamp: 1760108400000, message: { mid: `mid.entra.${mid++}`, text: texto } }] }],
});

describe('bandeja de la empresa: lista de charlas y respuesta a mano', () => {
  it('lista las charlas por canal, con el ultimo mensaje y la ventana, y contesta con solo `bandeja`', async () => {
    const n = await negocioConNumero(b, ['bandeja']);
    await cuenta(n.id, 'instagram', IG);
    await cuenta(n.id, 'messenger', PAGINA);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'Hola por Instagram'));
    await webhook(b, mensaje('page', PAGINA, OTRA, 'Hola por Messenger'));

    const todas = await pedir(b, n.clave, 'GET', '/charlas');
    expect(todas.status).toBe(200);
    expect(todas.json.map((c: { contacto: string }) => c.contacto).sort()).toEqual([PERSONA, OTRA].sort());

    const ig = (await pedir(b, n.clave, 'GET', '/charlas?canal=instagram')).json;
    expect(ig).toHaveLength(1);
    expect(ig[0]).toMatchObject({ contacto: PERSONA, canal: 'instagram', ventana_abierta: true, baja: false, mensajes: 1, ultimo: { direccion: 'entra', texto: 'Hola por Instagram' } });

    // Con solo bandeja (sin Puente ni leads) contesta igual, aunque la charla no este derivada.
    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'Hola, te escribe el equipo.', canal: 'instagram' });
    expect(r.status).toBe(200);
    expect(b.meta.mensajeria[0]).toMatchObject({ cuentaId: IG, a: PERSONA });
    const despues = (await pedir(b, n.clave, 'GET', '/charlas?canal=instagram')).json;
    expect(despues[0]).toMatchObject({ mensajes: 2, ultimo: { direccion: 'sale', texto: 'Hola, te escribe el equipo.' } });
  });

  it('pasadas las 24 h la charla figura con la ventana cerrada y no se manda nada', async () => {
    const n = await negocioConNumero(b, ['bandeja']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'Hola'));
    b.reloj.avanzar(25 * HORA_MS);
    expect((await pedir(b, n.clave, 'GET', '/charlas?canal=instagram')).json[0]).toMatchObject({ ventana_abierta: false });
    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'Tarde', canal: 'instagram' });
    expect(r).toMatchObject({ status: 409, json: { code: 'fuera_de_ventana' } });
    expect(b.meta.mensajeria).toEqual([]);
  });

  it('no mezcla negocios y una clave sin la capacidad no ve la lista', async () => {
    const a = await negocioConNumero(b, ['bandeja']);
    const otro = await negocioConNumero(b, ['bandeja']);
    const sin = await negocioConNumero(b, ['facturas']);
    await cuenta(otro.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'Hola'));
    expect((await pedir(b, a.clave, 'GET', '/charlas')).json).toEqual([]);
    expect((await pedir(b, otro.clave, 'GET', '/charlas')).json).toHaveLength(1);
    expect(await pedir(b, sin.clave, 'GET', '/charlas')).toMatchObject({ status: 404, json: { code: 'no_existe' } });
  });
});
