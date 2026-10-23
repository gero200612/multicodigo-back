import { beforeEach, describe, expect, it } from 'vitest';
import { HORA_MS } from '../src/horas.js';
import { revisarCalidad } from '../src/tareas.js';
import { armar, CLAVE_ADMIN, negocioConNumero, pedir, texto, webhook, type Banco } from './armar.js';

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
  expect(r.json.numero.canal).toBe(canal);
  return r.json.numero.id as number;
}

const mensaje = (objeto: 'instagram' | 'page', cuentaId: string, de: string, textoDelMensaje: string, extra: Record<string, unknown> = {}) => ({
  object: objeto,
  entry: [{ id: cuentaId, time: 1760108400, messaging: [{ sender: { id: de }, recipient: { id: cuentaId }, timestamp: 1760108400000, message: { mid: `mid.entra.${mid++}`, text: textoDelMensaje, ...extra } }] }],
});

const comentarioIg = (cuentaId: string, id: string, de: string, textoDelComentario: string) => ({
  object: 'instagram',
  entry: [{ id: cuentaId, time: 1, changes: [{ field: 'comments', value: { id, text: textoDelComentario, from: { id: de, username: 'juan' }, media: { id: 'media-1' } } }] }],
});

const comentarioPagina = (paginaId: string, id: string, de: string, textoDelComentario: string) => ({
  object: 'page',
  entry: [{ id: paginaId, time: 1, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: 'post-1', message: textoDelComentario, from: { id: de, name: 'Juana' } } }] }],
});

describe('mensajes de Instagram y Messenger', () => {
  it('un mensaje de Instagram le llega a puente con su canal y se contesta por la cuenta de Instagram', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    expect((await webhook(b, mensaje('instagram', IG, PERSONA, 'Hola, ¿cuánto sale?'))).statusCode).toBe(200);

    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ tipo: 'mensaje', datos: { contacto: PERSONA, texto: 'Hola, ¿cuánto sale?', canal: 'instagram' } });

    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'Hola, soy el asistente.', canal: 'instagram' });
    expect(r.status).toBe(200);
    expect(r.json.wamid).toMatch(/^mid\.sale/);
    // Sale por la cuenta de Instagram, no por el numero de WhatsApp.
    expect(b.meta.mensajeria).toEqual([{ token: 'EAAtokenDelSystemUser123', cuentaId: IG, a: PERSONA, texto: 'Hola, soy el asistente.' }]);
    expect(b.meta.enviados).toEqual([]);
    expect((await pedir(b, n.clave, 'GET', `/charlas/${PERSONA}?canal=instagram`)).json.ventana_abierta).toBe(true);
  });

  it('un mensaje de Messenger entra por el object page', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'messenger', PAGINA);
    await webhook(b, mensaje('page', PAGINA, OTRA, 'Hola desde Facebook'));
    const evento = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json[0];
    expect(evento.datos).toMatchObject({ contacto: OTRA, canal: 'messenger', texto: 'Hola desde Facebook' });
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: OTRA, texto: 'Hola', canal: 'messenger' })).status).toBe(200);
    expect(b.meta.mensajeria[0]!.cuentaId).toBe(PAGINA);
  });

  it('a las 25 h no sale nada en Instagram, y una plantilla de WhatsApp a las 25 h sí pasa', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'Hola'));
    b.reloj.avanzar(25 * HORA_MS);

    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: '¿Seguís ahí?', canal: 'instagram' });
    expect(r).toMatchObject({ status: 409, json: { code: 'fuera_de_ventana' } });
    expect(b.meta.mensajeria).toEqual([]);
    expect((await pedir(b, n.clave, 'GET', `/charlas/${PERSONA}?canal=instagram`)).json.ventana_abierta).toBe(false);
    // No hay «agente humano» ni plantillas en Instagram: un aviso no tiene cuenta de WhatsApp de donde salir.
    const aviso = await pedir(b, n.clave, 'POST', '/avisos', { a: PERSONA, plantilla: 'x', idioma: 'es_AR' });
    expect(aviso.status).toBeGreaterThanOrEqual(400);
    expect(b.meta.enviados).toEqual([]);
  });

  it('la ventana de cada canal es de su canal: escribir por WhatsApp no abre la de Instagram', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, texto(n.phoneNumberId, '5491141879467', 'hola'));
    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491141879467', texto: 'x', canal: 'instagram' });
    expect(r).toMatchObject({ status: 409, json: { code: 'fuera_de_ventana' } });
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491141879467', texto: 'x' })).status).toBe(200);
  });

  it('baja y alta por texto valen en Instagram, se confirman por Instagram y le llegan a puente', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'hola'));
    await webhook(b, mensaje('instagram', IG, PERSONA, 'baja'));

    expect(b.meta.mensajeria.at(-1)!.texto).toContain('no te vamos a escribir más');
    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos.find((e: { tipo: string }) => e.tipo === 'baja').datos).toMatchObject({ contacto: PERSONA, canal: 'instagram' });
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' })).toMatchObject({ status: 409, json: { code: 'baja' } });

    await webhook(b, mensaje('instagram', IG, PERSONA, 'alta'));
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' })).status).toBe(200);
  });

  it('el eco de lo que manda la cuenta, un mid repetido y una cuenta desconocida se descartan', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'eco', { is_echo: true }));
    const repetido = mensaje('instagram', IG, PERSONA, 'hola');
    await webhook(b, repetido);
    await webhook(b, repetido);
    await webhook(b, mensaje('instagram', '999999999999', PERSONA, 'de otra cuenta'));
    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos).toHaveLength(1);
    expect(eventos[0].datos.texto).toBe('hola');
  });

  it('una app solo con leads no puede mandar por Instagram sin cuenta (sin_numero)', async () => {
    const n = await negocioConNumero(b, ['puente']);
    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' });
    expect(r).toMatchObject({ status: 409, json: { code: 'sin_numero' } });
  });

  it('una adjunto sin texto llega como mensaje de otro tipo', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, {
      object: 'instagram',
      entry: [{ id: IG, messaging: [{ sender: { id: PERSONA }, recipient: { id: IG }, message: { mid: 'mid.foto', attachments: [{ type: 'image' }] } }] }],
    });
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json[0].datos).toMatchObject({ tipo: 'image', texto: null, canal: 'instagram' });
  });

  it('la prueba de cada 30 min también mira las cuentas de Instagram: un 190 frena los envíos', async () => {
    const n = await negocioConNumero(b, ['puente']);
    const id = await cuenta(n.id, 'instagram', IG);
    await webhook(b, mensaje('instagram', IG, PERSONA, 'hola'));
    b.meta.fallar = '401 190 Error validating access token';
    await revisarCalidad(b.ctx);
    expect((await b.store.numero(id))!.tokenCaido).toBe(true);
    b.meta.fallar = null;
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' })).toMatchObject({ status: 409, json: { code: 'token_caido' } });
    await revisarCalidad(b.ctx);
    expect(b.meta.probadas).toContain(IG);
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' })).status).toBe(200);
  });
});

describe('comentarios públicos', () => {
  it('un comentario de Instagram le llega a puente y se contesta en público una sola vez', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, comentarioIg(IG, 'c-1', PERSONA, '¿Cuánto sale?'));
    const evento = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json[0];
    expect(evento).toMatchObject({ tipo: 'comentario', datos: { canal: 'instagram', comentario_id: 'c-1', texto: '¿Cuánto sale?', autor_id: PERSONA, publicacion_id: 'media-1' } });

    expect((await pedir(b, n.clave, 'POST', '/comentarios/c-1/responder', { texto: 'Te escribimos por privado.' })).status).toBe(200);
    expect(b.meta.comentarios).toEqual([{ tipo: 'publico', canal: 'instagram', id: 'c-1', texto: 'Te escribimos por privado.' }]);
    expect(await pedir(b, n.clave, 'POST', '/comentarios/c-1/responder', { texto: 'otra' })).toMatchObject({ status: 409, json: { code: 'ya_respondido' } });
  });

  it('el comentario de la propia cuenta (su respuesta) no se contesta, y uno repetido tampoco', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, comentarioIg(IG, 'c-propio', IG, 'Gracias por escribir'));
    await webhook(b, comentarioIg(IG, 'c-2', PERSONA, 'Hola'));
    await webhook(b, comentarioIg(IG, 'c-2', PERSONA, 'Hola'));
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toHaveLength(1);
  });

  it('un comentario de la página de Facebook (feed) también entra, y se contesta con el canal de Messenger', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'messenger', PAGINA);
    await webhook(b, comentarioPagina(PAGINA, 'fb-1', OTRA, '¿Dónde queda?'));
    const evento = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json[0];
    expect(evento.datos).toMatchObject({ canal: 'messenger', comentario_id: 'fb-1', autor_nombre: 'Juana', publicacion_id: 'post-1' });
    await pedir(b, n.clave, 'POST', '/comentarios/fb-1/responder', { texto: 'Escribinos por privado.' });
    expect(b.meta.comentarios[0]).toMatchObject({ tipo: 'publico', canal: 'messenger', id: 'fb-1' });
    // Otras cosas del feed no son comentarios nuevos.
    await webhook(b, { object: 'page', entry: [{ id: PAGINA, changes: [{ field: 'feed', value: { item: 'reaction', verb: 'add' } }] }] });
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json).toHaveLength(1);
  });

  it('la respuesta privada es una sola, dentro de los 7 días, y nunca a quien pidió la baja', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await cuenta(n.id, 'instagram', IG);
    await webhook(b, comentarioIg(IG, 'c-1', PERSONA, '¿Cuánto sale?'));
    await webhook(b, comentarioIg(IG, 'c-2', PERSONA, 'Hola?'));
    await webhook(b, comentarioIg(IG, 'c-3', OTRA, 'Hola'));

    const r = await pedir(b, n.clave, 'POST', '/comentarios/c-1/privado', { texto: 'Te contamos por acá.' });
    expect(r.status).toBe(200);
    expect(b.meta.comentarios.at(-1)).toMatchObject({ tipo: 'privado', cuentaId: IG, id: 'c-1' });
    expect(await pedir(b, n.clave, 'POST', '/comentarios/c-1/privado', { texto: 'otra' })).toMatchObject({ status: 409, json: { code: 'ya_respondido_en_privado' } });

    // Pasados 7 días ya no se puede.
    b.reloj.avanzar(8 * 24 * HORA_MS);
    expect(await pedir(b, n.clave, 'POST', '/comentarios/c-2/privado', { texto: 'x' })).toMatchObject({ status: 409, json: { code: 'fuera_de_plazo' } });

    // Alguien que pidió la baja: nada.
    b.reloj.avanzar(-8 * 24 * HORA_MS);
    await webhook(b, mensaje('instagram', IG, OTRA, 'baja'));
    expect(await pedir(b, n.clave, 'POST', '/comentarios/c-3/privado', { texto: 'x' })).toMatchObject({ status: 409, json: { code: 'baja' } });
  });

  it('ocultar un comentario, con el token caído se frena, y Meta rechaza como 502', async () => {
    const n = await negocioConNumero(b, ['puente']);
    const id = await cuenta(n.id, 'instagram', IG);
    await webhook(b, comentarioIg(IG, 'c-1', PERSONA, 'Estafa total, entrá a bit.ly/x'));
    expect((await pedir(b, n.clave, 'POST', '/comentarios/c-1/ocultar', {})).status).toBe(200);
    expect(b.meta.comentarios.at(-1)).toMatchObject({ tipo: 'ocultar', canal: 'instagram', id: 'c-1' });

    await webhook(b, comentarioIg(IG, 'c-2', PERSONA, 'Otro'));
    b.meta.fallar = '400 190 Malformed access token EAAxxxxxxxxxxxxxxxxxxx';
    const r = await pedir(b, n.clave, 'POST', '/comentarios/c-2/ocultar', {});
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain('EAAxxxx');
    expect((await b.store.numero(id))!.tokenCaido).toBe(true);
    b.meta.fallar = null;
    expect(await pedir(b, n.clave, 'POST', '/comentarios/c-2/ocultar', {})).toMatchObject({ status: 409, json: { code: 'token_caido' } });
  });

  it('un comentario de otro negocio o que no existe es 404; las rutas son solo de puente', async () => {
    const a = await negocioConNumero(b, ['puente']);
    const otro = await negocioConNumero(b, ['puente']);
    await cuenta(a.id, 'instagram', IG);
    await webhook(b, comentarioIg(IG, 'c-1', PERSONA, 'Hola'));
    expect((await pedir(b, otro.clave, 'POST', '/comentarios/c-1/responder', { texto: 'x' })).status).toBe(404);
    expect((await pedir(b, a.clave, 'POST', '/comentarios/no-existe/responder', { texto: 'x' })).status).toBe(404);
    const leads = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, leads.clave, 'POST', '/comentarios/c-1/responder', { texto: 'x' })).status).toBe(404);
    expect((await pedir(b, leads.clave, 'POST', '/mensajes', { a: PERSONA, texto: 'x', canal: 'instagram' })).status).toBe(409);
  });
});

describe('lectura de Instagram (instagram_lectura)', () => {
  it('lista los reels con sus métricas, uno por uno y su archivo, con la misma cuenta', async () => {
    const n = await negocioConNumero(b, ['puente', 'instagram_lectura']);
    await cuenta(n.id, 'instagram', IG);
    b.meta.reelsDeCuenta = [{ id: '17900000000001' }, { id: '17900000000002' }];

    const lista = (await pedir(b, n.clave, 'GET', '/instagram/reels?limite=5')).json;
    expect(lista).toHaveLength(2);
    expect(lista[0]).toMatchObject({ id: '17900000000001', metricas: { alcance: 1200, reproducciones: 3400, interacciones: 150, guardados: 20, compartidos: 7, me_gusta: 10, comentarios: 2 } });
    expect((await pedir(b, n.clave, 'GET', '/instagram/reels/17900000000002')).json.id).toBe('17900000000002');
    expect((await pedir(b, n.clave, 'GET', '/instagram/reels/17900000000999')).status).toBe(404);
  });

  it('sin la capacidad la ruta no existe, y sin cuenta de Instagram es sin_numero', async () => {
    const solo = await negocioConNumero(b, ['puente']);
    expect((await pedir(b, solo.clave, 'GET', '/instagram/reels')).status).toBe(404);
    const lectura = await negocioConNumero(b, ['instagram_lectura']);
    expect(await pedir(b, lectura.clave, 'GET', '/instagram/reels')).toMatchObject({ status: 409, json: { code: 'sin_numero' } });
  });

  it('con el token caído se frena y la lectura de un negocio no ve la cuenta de otro', async () => {
    const a = await negocioConNumero(b, ['instagram_lectura']);
    const otro = await negocioConNumero(b, ['instagram_lectura']);
    const id = await cuenta(a.id, 'instagram', IG);
    b.meta.reelsDeCuenta = [{ id: '17900000000001' }];
    expect(await pedir(b, otro.clave, 'GET', '/instagram/reels')).toMatchObject({ status: 409 });

    b.meta.fallar = '401 190 Error validating access token EAAxxxxxxxxxxxxxxxxxxx';
    const r = await pedir(b, a.clave, 'GET', '/instagram/reels');
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain('EAAxxxx');
    expect((await b.store.numero(id))!.tokenCaido).toBe(true);
    b.meta.fallar = null;
    expect(await pedir(b, a.clave, 'GET', '/instagram/reels')).toMatchObject({ status: 409, json: { code: 'token_caido' } });
  });
});
