import { beforeEach, describe, expect, it } from 'vitest';
import { HORA_MS } from '../src/horas.js';
import { armar, CLAVE_ADMIN, negocioConNumero, pedir, plantillaAprobada, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

const CONTACTO = '5491141879467';

describe('ventana de 24 h', () => {
  it('texto libre a las 25 h se rechaza; plantilla a las 25 h pasa', async () => {
    const n = await negocioConNumero(b, ['leads', 'avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));

    const dentro = await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'Hola, ¿en qué te ayudo?' });
    expect(dentro.status).toBe(200);
    expect(dentro.json.wamid).toMatch(/^wamid\./);
    expect(b.meta.enviados.at(-1)).toMatchObject({ tipo: 'texto', desde: n.phoneNumberId, a: CONTACTO, token: 'EAAtokenDelSystemUser123' });
    // Utilidad dentro de la ventana: gratis.
    const avisoDentro = await pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR' });
    expect(avisoDentro.json.costo_estimado_ars).toBe(0);

    b.reloj.avanzar(25 * HORA_MS);
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'hola' })).toMatchObject({
      status: 409,
      json: { code: 'fuera_de_ventana' },
    });
    const aviso = await pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR', variables: ['mañana', '10:00'] });
    expect(aviso.status).toBe(200);
    expect(aviso.json.costo_estimado_ars).toBeCloseTo(37.6798);
    expect(b.meta.enviados.at(-1)).toMatchObject({ tipo: 'plantilla', plantilla: 'turno', variables: ['mañana', '10:00'] });
    expect((await pedir(b, n.clave, 'GET', `/charlas/${CONTACTO}`)).json.ventana_abierta).toBe(false);
  });

  it('valida el destinatario', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: '+54 11', texto: 'x' })).json.code).toBe('invalido');
  });
});

describe('mensajes con botones', () => {
  it('botones de respuesta o un link: salen como interactivo y quedan con sus renglones', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));

    const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'Elegí uno', botones: ['Mar 14/10 15:00', 'Mié 15/10 16:00'] });
    expect(r.status).toBe(200);
    expect(b.meta.enviados.at(-1)).toMatchObject({ tipo: 'interactivo', texto: 'Elegí uno', interactivo: { botones: ['Mar 14/10 15:00', 'Mié 15/10 16:00'] } });
    const conLink = await pedir(b, n.clave, 'POST', '/mensajes', {
      a: CONTACTO,
      texto: 'La web',
      link: { texto: 'Ver la web', url: 'https://sincro.apps.punchi.dev' },
    });
    expect(conLink.status).toBe(200);

    const charla = (await pedir(b, n.clave, 'GET', `/charlas/${CONTACTO}`)).json;
    const textos = charla.mensajes.map((m: { texto: string }) => m.texto);
    expect(textos).toContain('Elegí uno\n[Mar 14/10 15:00]\n[Mié 15/10 16:00]');
    expect(textos).toContain('La web\n[Ver la web → https://sincro.apps.punchi.dev]');
  });

  it('valida: hasta 3 botones de 20, sin repetir, sin link a la vez, y respeta la ventana', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    const mal = [
      { botones: ['a', 'b', 'c', 'd'] },
      { botones: ['x'.repeat(21)] },
      { botones: ['a', 'a'] },
      { botones: ['a'], link: { texto: 'web', url: 'https://x.com' } },
      { link: { texto: 'web', url: 'http://x.com' } },
      { botones: ['a'], texto: 'x'.repeat(1025) },
    ];
    for (const extra of mal) {
      const r = await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'hola', ...extra });
      expect(r.json.code).toBe('invalido');
    }
    b.reloj.avanzar(25 * HORA_MS);
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: CONTACTO, texto: 'hola', botones: ['a'] })).json.code).toBe('fuera_de_ventana');
  });
});

describe('escribiendo', () => {
  it('marca leído el último mensaje que entró y muestra escribiendo; sin mensaje o fuera de ventana no sale', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, n.clave, 'POST', '/escribiendo', { a: CONTACTO })).json).toEqual({ ok: false });

    await webhook(b, texto(n.phoneNumberId, CONTACTO, 'hola'));
    await webhook(b, texto(n.phoneNumberId, CONTACTO, '¿cuánto sale?'));
    const r = await pedir(b, n.clave, 'POST', '/escribiendo', { a: CONTACTO });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    const ultimo = (await pedir(b, n.clave, 'GET', `/charlas/${CONTACTO}`)).json.mensajes.at(-1);
    expect(ultimo.texto).toBe('¿cuánto sale?');
    expect(b.meta.escribiendos).toHaveLength(1);
    expect(b.meta.escribiendos[0]!.desde).toBe(n.phoneNumberId);

    b.meta.fallar = '400 meta caida';
    expect((await pedir(b, n.clave, 'POST', '/escribiendo', { a: CONTACTO })).json).toEqual({ ok: false });
    b.meta.fallar = null;
    b.reloj.avanzar(25 * HORA_MS);
    expect((await pedir(b, n.clave, 'POST', '/escribiendo', { a: CONTACTO })).json).toEqual({ ok: false });
    expect(b.meta.escribiendos).toHaveLength(1);
  });

  it('una app sin leads ni atender no la ve', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    expect((await pedir(b, n.clave, 'POST', '/escribiendo', { a: CONTACTO })).status).toBe(404);
  });
});

describe('avisos', () => {
  it('plantilla inexistente o sin aprobar: 409 plantilla_no_aprobada', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    const p = await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await b.store.cambiarPlantilla(p!.id, { estado: 'PENDING' });
    for (const plantilla of ['turno', 'otra']) {
      expect(await pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla, idioma: 'es_AR' })).toMatchObject({
        status: 409,
        json: { code: 'plantilla_no_aprobada' },
      });
    }
  });

  it('una plantilla de otro negocio no existe para esta app', async () => {
    const a = await negocioConNumero(b, ['avisos']);
    const otro = await negocioConNumero(b, ['avisos']);
    await plantillaAprobada(b, otro.id, otro.wabaId, 'turno', 'UTILITY');
    expect((await pedir(b, a.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR' })).json.code).toBe(
      'plantilla_no_aprobada',
    );
  });

  it('tope de Meta: contactos distintos con plantilla en 24 h; 80 % alerta y 100 % da 429', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    await b.store.cambiarNumero(n.numeroId, { topeMeta: 5 });
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    const mandar = (a: string) => pedir(b, n.clave, 'POST', '/avisos', { a, plantilla: 'turno', idioma: 'es_AR' });
    for (let i = 0; i < 5; i++) expect((await mandar(`54911000000${i}0`)).status).toBe(200);
    expect(b.store.alertasT.filter((a) => a.tipo === 'tope_meta')).toHaveLength(1);
    expect(await mandar('5491100000099')).toMatchObject({ status: 429, json: { code: 'tope_meta' } });
    // A uno que ya recibio no suma: sale.
    expect((await mandar('5491100000000')).status).toBe(200);
    // A las 24 h se libera.
    b.reloj.avanzar(24 * HORA_MS + 1);
    expect((await mandar('5491100000099')).status).toBe(200);
  });

  it('Meta rechaza: 502 con el detalle tapado y el intento registrado', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    b.meta.fallar = '400 190 Malformed access token EAAxxxxxxxxxxxxxxxxxxx';
    const r = await pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR' });
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ code: 'meta', detalle: '400 190 Malformed access token EAA…' });
    const fallido = b.store.mensajesT.at(-1)!;
    expect(fallido).toMatchObject({ estado: 'failed', wamid: null, costoEstimado: 0 });
  });
});

describe('tope de gasto', () => {
  it('al 80 % salen los avisos con alerta; al 100 % lo pago da 402 y lo gratis sigue', async () => {
    // Utilidad fuera de ventana: 37,68 cada una. Tope 90: dos = 83,7 %, tres > 100 %.
    const n = await negocioConNumero(b, ['leads', 'avisos'], { tope: 90 });
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    const aviso = (a: string) => pedir(b, n.clave, 'POST', '/avisos', { a, plantilla: 'turno', idioma: 'es_AR' });

    expect((await aviso('5491100000001')).status).toBe(200);
    expect(b.store.alertasT).toEqual([]);
    expect((await aviso('5491100000002')).status).toBe(200);
    expect(b.store.alertasT.map((a) => a.tipo)).toEqual(['tope_80']);
    // Todavia no llego al 100 %: sale, y recien ahi cruza.
    expect((await aviso('5491100000003')).status).toBe(200);
    expect(b.store.alertasT.map((a) => a.tipo)).toEqual(['tope_80', 'tope_100']);

    expect(await aviso('5491100000004')).toMatchObject({ status: 402, json: { code: 'tope_alcanzado' } });

    // Lo gratis sigue: texto dentro de la ventana y utilidad dentro de la ventana.
    await webhook(b, texto(n.phoneNumberId, '5491100000005', 'hola'));
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000005', texto: 'hola!' })).status).toBe(200);
    expect((await aviso('5491100000005')).status).toBe(200);

    // Las alertas son una vez por umbral y mes.
    expect(await aviso('5491100000006')).toMatchObject({ status: 402 });
    expect(b.store.alertasT).toHaveLength(2);
    const alertasAdmin = b.store.eventosT.filter((e) => e.negocioId === null && e.tipo === 'alerta');
    expect(alertasAdmin.map((e) => e.datos.tipo)).toEqual(['tope_80', 'tope_100']);
    expect(alertasAdmin[0]!.datos).toEqual({
      tipo: 'tope_80',
      negocio_id: n.id,
      texto: 'Negocio leads+avisos llegó al 80 % del tope de gasto del mes ($75,36 de $90)',
    });

    // Gero sube el tope y vuelve a salir.
    await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { tope_mensual_ars: 1000, quien: 'gero' });
    expect((await aviso('5491100000006')).status).toBe(200);
    const cambios = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/cambios?negocio=${n.id}`);
    expect(cambios.json[0]).toMatchObject({ campo: 'tope_mensual_ars', antes: '90', despues: '1000', quien: 'gero' });
  });

  it('al mes siguiente vuelve a habilitar', async () => {
    const n = await negocioConNumero(b, ['avisos'], { tope: 30 });
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    const aviso = () => pedir(b, n.clave, 'POST', '/avisos', { a: CONTACTO, plantilla: 'turno', idioma: 'es_AR' });
    expect((await aviso()).status).toBe(200);
    expect((await aviso()).status).toBe(402);
    b.reloj.ahora = new Date('2026-11-01T03:00:01Z');
    expect((await aviso()).status).toBe(200);
  });
});
