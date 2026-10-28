import { beforeEach, describe, expect, it } from 'vitest';
import { HORA_MS } from '../src/horas.js';
import { revisarCalidad } from '../src/tareas.js';
import { armar, negocioConNumero, pedir, plantillaAprobada, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const CONTACTO = '5491141879467';
const TOKEN_CAIDO = '401 190 Error validating access token: Session has been invalidated EAAxxxxxxxxxxxxxxxxxxx';

describe('capacidad puente', () => {
  it('recibe todos los mensajes (no solo los derivados) con el canal, y manda texto dentro de la ventana', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola, ¿cuánto sale?'));
    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ tipo: 'mensaje', datos: { contacto: CONTACTO, texto: 'hola, ¿cuánto sale?', canal: 'whatsapp' } });
    expect(eventos[0].datos.wamid).toMatch(/^wamid\.entra/);

    const rr = await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'Soy el asistente.' }); expect(rr.status).toBe(200);
    expect((await pedir(b, n.clave, 'GET', `/charlas/${CONTACTO}`)).json.ventana_abierta).toBe(true);
  });

  it('no usa la IA del bot ni los endpoints de atender', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    expect(b.store.trabajosT).toEqual([]);
    expect((await pedir(b, n.clave, 'PUT', '/atender/contexto', { texto: 'x' })).status).toBe(404);
    expect((await pedir(b, n.clave, 'POST', `/charlas/${CONTACTO}/liberar`)).status).toBe(404);
  });

  it('plantillas: utilidad sí; marketing solo si además tiene promociones', async () => {
    const solo = await negocioConNumero(b, ['puente']);
    const cuerpo = { nombre: 'seguimiento', idioma: 'es_AR', categoria: 'MARKETING', componentes: [{ type: 'BODY', text: 'Hola' }] };
    expect((await pedir(b, solo.clave, 'POST', '/plantillas', cuerpo)).status).toBe(404);
    expect((await pedir(b, solo.clave, 'POST', '/plantillas', { ...cuerpo, categoria: 'UTILITY' })).status).toBe(200);
    const con = await negocioConNumero(b, ['puente', 'promociones']);
    expect((await pedir(b, con.clave, 'POST', '/plantillas', cuerpo)).status).toBe(200);
  });

  it('los estados de entrega le llegan', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    const enviado = (await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'Hola' })).json;
    const { estado } = await import('./armar.js');
    await webhook(b, estado(n.phoneNumberId, enviado.wamid, 'delivered'));
    const tipos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json.map((e: { tipo: string }) => e.tipo);
    expect(tipos).toContain('estado');
  });
});

describe('alerta de token caído (190)', () => {
  it('un envío con 190 frena los envíos, avisa una sola vez y la app recibe conexion', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    b.meta.fallar = TOKEN_CAIDO;
    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'hola' });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain('EAAxxxx');

    b.meta.fallar = null;
    // Frenado: ni intenta, no llega a Meta.
    const antes = b.meta.enviados.length;
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'otra' })).toMatchObject({ status: 409, json: { code: 'token_caido' } });
    expect(b.meta.enviados.length).toBe(antes);
    expect(b.store.alertasT.filter((a) => a.tipo === 'token_caido')).toHaveLength(1);

    const eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos.filter((e: { tipo: string }) => e.tipo === 'conexion')).toHaveLength(1);
    expect(eventos.find((e: { tipo: string }) => e.tipo === 'conexion').datos.estado).toBe('token_caido');
    // Lo que entra sigue entrando.
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'sigo acá'));
    expect((await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json.some((e: { datos: { texto?: string } }) => e.datos.texto === 'sigo acá')).toBe(true);
  });

  it('la prueba de cada 30 min lo descubre sin que nadie escriba, y al volver reanuda', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    b.meta.fallar = TOKEN_CAIDO;
    await revisarCalidad(b.ctx);
    expect((await b.store.numero(n.numeroId))!.tokenCaido).toBe(true);
    expect(b.store.alertasT.map((a) => a.tipo)).toContain('token_caido');

    b.meta.fallar = null;
    b.reloj.avanzar(HORA_MS / 2);
    await revisarCalidad(b.ctx);
    expect((await b.store.numero(n.numeroId))!.tokenCaido).toBe(false);
    expect(b.store.alertasT.map((a) => a.tipo)).toContain('token_ok');
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'volvimos' })).status).toBe(200);
  });

  it('un error de Meta que no es 190 no frena nada', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    b.meta.fallar = '400 131030 destinatario no permitido';
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'x' })).status).toBe(502);
    expect((await b.store.numero(n.numeroId))!.tokenCaido).toBe(false);
  });

  it('avisos también se frenan', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    b.meta.fallar = TOKEN_CAIDO;
    await revisarCalidad(b.ctx);
    b.meta.fallar = null;
    expect(await pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR' })).toMatchObject({ status: 409, json: { code: 'token_caido' } });
  });
});

describe('bajas para puente', () => {
  it('la baja y el alta por texto le llegan a la app, y la que decide la empresa frena los envíos', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'baja'));
    let eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos.find((e: { tipo: string }) => e.tipo === 'baja').datos).toMatchObject({ contacto: CONTACTO, canal: 'whatsapp' });
    // Lo de la baja no se pasa como mensaje.
    expect(eventos.filter((e: { tipo: string }) => e.tipo === 'mensaje')).toHaveLength(1);

    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'alta'));
    eventos = (await pedir(b, n.clave, 'GET', '/eventos?esperar=0')).json;
    expect(eventos.some((e: { tipo: string }) => e.tipo === 'alta')).toBe(true);
  });

  it('POST /charlas/:contacto/baja marca la baja y después nada sale', async () => {
    const n = await negocioConNumero(b, ['puente']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    expect((await pedir(b, n.clave, 'POST', `/charlas/${CONTACTO}/baja`, {})).json).toEqual({ ok: true });
    expect((await pedir(b, n.clave, 'GET', `/charlas/${CONTACTO}`)).json.baja).toBe(true);
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'x' })).toMatchObject({ status: 409, json: { code: 'baja' } });
  });

  it('una app sin puente no puede marcar bajas (404)', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, n.clave, 'POST', `/charlas/${CONTACTO}/baja`, {})).status).toBe(404);
  });
});
