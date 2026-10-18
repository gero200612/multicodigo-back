import { beforeEach, describe, expect, it } from 'vitest';
import { DIA_MS, HORA_MS } from '../src/horas.js';
import { limpiar, revisarSilencio } from '../src/tareas.js';
import { armar, CLAVE_ADMIN, estado, negocioConNumero, pedir, plantillaAprobada, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

describe('negocios', () => {
  it('alta: clave y secreto una sola vez, tope obligatorio, cambios registrados', async () => {
    expect((await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', { nombre: 'X', app: 'x', capacidades: [], quien: 'gero' })).status).toBe(400);
    expect(
      (await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', { nombre: 'X', app: 'x', capacidades: [], tope_mensual_ars: 0, quien: 'gero' })).status,
    ).toBe(400);
    expect(
      (await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', { nombre: 'X', app: 'x', capacidades: ['todo'], tope_mensual_ars: 1, quien: 'gero' })).status,
    ).toBe(400);

    const n = await negocioConNumero(b, ['facturas'], { nombre: 'Taller Pepe' });
    const lista = await pedir(b, CLAVE_ADMIN, 'GET', '/admin/negocios');
    expect(lista.json).toHaveLength(1);
    const v = lista.json[0];
    expect(v).toMatchObject({
      nombre: 'Taller Pepe',
      capacidades: ['facturas'],
      tope_mensual_ars: 100_000,
      gasto_mes_ars: 0,
      porcentaje_tope: 0,
      activo: true,
      numeros: [{ phone_number_id: n.phoneNumberId, waba_id: n.wabaId, calidad: 'GREEN', tope_meta: 250, estado: 'CONNECTED' }],
    });
    // Ni la clave ni el secreto ni su hash vuelven a salir.
    const todo = JSON.stringify(lista.json);
    expect(todo).not.toContain(n.clave);
    expect(todo).not.toContain(n.secreto);
    expect(todo).not.toContain('clave_hash');

    await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { capacidades: ['facturas', 'avisos'], quien: 'gero' });
    const cambios = (await pedir(b, CLAVE_ADMIN, 'GET', `/admin/cambios?negocio=${n.id}`)).json;
    expect(cambios.map((c: any) => c.campo)).toEqual(['capacidades', 'numero', 'alta']);
    expect(cambios[0]).toMatchObject({ antes: '["facturas"]', despues: '["facturas","avisos"]', quien: 'gero' });
    // Sin quien no se cambia nada.
    expect((await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { activo: false })).status).toBe(400);
  });

  it('formato exacto de la lista y del detalle; PATCH ignora campos desconocidos y valida capacidades', async () => {
    const n = await negocioConNumero(b, ['avisos'], { nombre: 'Taller X', urlBase: 'http://taller.interno' });
    const [v] = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/negocios')).json;
    expect(Object.keys(v).sort()).toEqual(
      ['activo', 'app', 'capacidades', 'clave_ultimo_uso', 'gasto_mes_ars', 'id', 'nombre', 'numeros', 'porcentaje_tope', 'tope_mensual_ars'].sort(),
    );
    expect(Object.keys(v.numeros[0]).sort()).toEqual(['calidad', 'estado', 'id', 'phone_number_id', 'tope_meta', 'waba_id']);
    const detalle = (await pedir(b, CLAVE_ADMIN, 'GET', `/admin/negocios/${n.id}`)).json;
    expect(detalle).toMatchObject({ id: n.id, nombre: 'Taller X', url_base: 'http://taller.interno', numeros: v.numeros });

    const ok = await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { tope_mensual_ars: 5, inventado: 1, quien: 'gero' });
    expect(ok.status).toBe(200);
    expect(ok.json.tope_mensual_ars).toBe(5);
    expect((await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { capacidades: ['todo'], quien: 'gero' })).status).toBe(400);
  });

  it('un numero con token propio lo guarda cifrado y lo usa para mandar', async () => {
    const alta = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', {
      nombre: 'Cliente',
      app: 'x',
      capacidades: ['leads'],
      tope_mensual_ars: 1000,
      quien: 'punchi',
    });
    const num = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/numeros', {
      negocio_id: alta.json.negocio.id,
      phone_number_id: '55550001',
      waba_id: '66660001',
      token: 'EAAtokenDelClienteXYZ123',
      quien: 'punchi',
    });
    expect(b.store.numerosT[0]!.tokenCifrado).not.toContain('EAAtokenDelCliente');
    await webhook(b, texto('55550001', '5491100000001', 'hola'));
    await pedir(b, alta.json.clave, 'POST', '/mensajes', { a: '5491100000001', texto: 'hola' });
    expect(b.meta.enviados.at(-1)!.token).toBe('EAAtokenDelClienteXYZ123');
    // El mismo numero dos veces: 409.
    const otra = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/numeros', {
      negocio_id: alta.json.negocio.id,
      phone_number_id: '55550001',
      waba_id: '66660001',
      quien: 'punchi',
    });
    expect(otra).toMatchObject({ status: 409, json: { code: 'ya_existe' } });
  });

  it('sacarle promociones bloquea sus plantillas de marketing', async () => {
    const n = await negocioConNumero(b, ['avisos', 'promociones']);
    await plantillaAprobada(b, n.id, n.wabaId, 'promo', 'MARKETING');
    await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { capacidades: ['avisos'], quien: 'gero' });
    expect((await b.store.plantilla(n.id, 'promo', 'es_AR'))!.bloqueada).toBe(true);
    const ap = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/plantillas?negocio=${n.id}`);
    expect(ap.json[0]).toMatchObject({ nombre: 'promo', bloqueada: true, negocio_id: n.id });
  });
});

describe('costos', () => {
  it('resumen del mes: Meta real o estimado + IA al dolar', async () => {
    const n = await negocioConNumero(b, ['leads', 'avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await pedir(b, CLAVE_ADMIN, 'PUT', '/admin/dolar', { ars_por_usd: 1500, quien: 'gero' });
    const a1 = await pedir(b, n.clave, 'POST', '/avisos', { a: '5491100000001', plantilla: 'turno', idioma: 'es_AR' });
    await pedir(b, n.clave, 'POST', '/avisos', { a: '5491100000002', plantilla: 'turno', idioma: 'es_AR' });
    // El primero resulto gratis.
    await webhook(b, estado(n.phoneNumberId, a1.json.wamid, 'sent', { pricing: { billable: false, category: 'utility' } }));
    await webhook(b, texto(n.phoneNumberId, '5491100000003', 'hola'));
    await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000003', texto: 'hola' });
    await b.store.registrarUsoIa({ negocioId: n.id, capacidad: 'atender', modelo: 's', tokensEntrada: 0, tokensSalida: 0, costoUsd: 0.01, fecha: b.reloj.ahora });

    const r = await pedir(b, CLAVE_ADMIN, 'GET', '/admin/resumen?mes=2026-10');
    expect(r.json.mes).toBe('2026-10');
    expect(r.json.dolar_ars).toBe(1500);
    expect(r.json.negocios[0]).toMatchObject({
      id: n.id,
      mensajes: { marketing: 0, utility: 2, authentication: 0, service: 1 },
      meta_ars: 37.68,
      ia_usd: 0.01,
      ia_ars: 15,
      total_ars: 52.68,
      tope_mensual_ars: 100_000,
    });
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/resumen?mes=2026-09')).json.negocios[0].total_ars).toBe(0);

    const m = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/mensajes?negocio=${n.id}&desde=2026-10-10&hasta=2026-10-10`);
    expect(m.json.ventanas_abiertas).toBe(1);
    expect(m.json.filas).toEqual([
      { dia: '2026-10-10', negocio_id: n.id, categoria: 'service', cantidad: 1, costo_ars: 0 },
      { dia: '2026-10-10', negocio_id: n.id, categoria: 'utility', cantidad: 2, costo_ars: 37.6798 },
    ]);
  });

  it('precios editables con registro', async () => {
    await pedir(b, CLAVE_ADMIN, 'PUT', '/admin/precios', { categoria: 'marketing', precio_ars: 100, quien: 'gero' });
    const p = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/precios')).json;
    expect(p.find((x: any) => x.categoria === 'marketing')).toEqual({ categoria: 'marketing', precio_ars: 100, vigente_desde: b.reloj.ahora.toISOString() });
    const c = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/cambios')).json;
    expect(c[0]).toMatchObject({ negocio_id: null, campo: 'precio:marketing', antes: '89.562', despues: '100' });
  });
});

describe('tareas', () => {
  it('sin mensajes: alerta una vez con movimiento y 6 h de silencio, y se rearma cuando vuelve', async () => {
    const n = await negocioConNumero(b, ['leads']);
    for (let i = 0; i < 20; i++) {
      await webhook(b, texto(n.phoneNumberId, '5491100000001', `m${i}`));
      b.reloj.avanzar(HORA_MS);
    }
    await revisarSilencio(b.ctx);
    expect(b.store.alertasT).toEqual([]);
    b.reloj.avanzar(6 * HORA_MS);
    await revisarSilencio(b.ctx);
    await revisarSilencio(b.ctx);
    expect(b.store.alertasT.map((a) => a.tipo)).toEqual(['sin_mensajes']);
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'volví'));
    expect((await b.store.numero(n.numeroId))!.sinMensajesAlertado).toBe(false);
  });

  it('la media se borra a los 30 dias', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await b.store.guardarMedia(n.id, 'image/jpeg', Buffer.from('x'), b.reloj.ahora);
    b.reloj.avanzar(31 * DIA_MS);
    await limpiar(b.ctx);
    expect(b.store.mediaT).toEqual([]);
  });

  it('alertas listadas', async () => {
    const n = await negocioConNumero(b, ['leads']);
    b.meta.datos = { quality_rating: 'RED' };
    const { revisarCalidad } = await import('../src/tareas.js');
    await revisarCalidad(b.ctx);
    const a = (await pedir(b, CLAVE_ADMIN, 'GET', '/admin/alertas?limite=10')).json;
    expect(a).toEqual([expect.objectContaining({ negocio_id: n.id, tipo: 'calidad' })]);
    expect(a[0].texto).toContain('roja');
  });
});

/**
 * Las charlas, para que Gero vea en punchi.dev que hace el bot (Homero ->
 * WhatsApp -> Charlas). Sin coexistencia el numero no esta en ningun celu:
 * esto es lo unico que muestra lo que escribio la persona y lo que se le
 * contesto. Solo con la clave de admin.
 */
describe('charlas', () => {
  it('lista las charlas de la mas reciente a la mas vieja, con el ultimo mensaje', async () => {
    const n = await negocioConNumero(b, ['leads'], { nombre: 'Sincro' });
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'Hola, quiero info'));
    await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000001', texto: 'Hola Juan, ¿qué necesitás?' });
    b.reloj.avanzar(HORA_MS);
    await webhook(b, texto(n.phoneNumberId, '5491100000002', 'Buenas'));

    const r = await pedir(b, CLAVE_ADMIN, 'GET', '/admin/charlas');
    expect(r.status).toBe(200);
    expect(r.json.map((c: { contacto: string }) => c.contacto)).toEqual(['5491100000002', '5491100000001']);
    expect(r.json[1]).toMatchObject({
      negocio_id: n.id,
      negocio: 'Sincro',
      contacto: '5491100000001',
      nombre: 'Juan',
      mensajes: 2,
      ventana_abierta: true,
      baja: false,
      derivada: false,
      ultimo: { direccion: 'sale', texto: 'Hola Juan, ¿qué necesitás?' },
    });
  });

  it('el detalle trae todos los mensajes en orden, con lo que costo cada uno', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'Hola'));
    await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000001', texto: 'Hola, ¿en qué te ayudo?' });

    const r = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/charlas/${n.id}/5491100000001`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ negocio_id: n.id, contacto: '5491100000001', nombre: 'Juan', ventana_abierta: true });
    expect(r.json.mensajes.map((m: { direccion: string; texto: string }) => [m.direccion, m.texto])).toEqual([
      ['entra', 'Hola'],
      ['sale', 'Hola, ¿en qué te ayudo?'],
    ]);
    expect(r.json.mensajes[1]).toMatchObject({ categoria: 'service', costo_ars: 0 });
    expect(typeof r.json.mensajes[0].fecha).toBe('string');
  });

  it('el detalle muestra los botones, la plantilla armada y el boton que toco la persona', async () => {
    const n = await negocioConNumero(b, ['leads', 'avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'Hola'));
    await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000001', texto: 'Elegí uno', botones: ['Mar 15:00', 'Mié 16:00'] });
    await pedir(b, n.clave, 'POST', '/avisos', { a: '5491100000001', plantilla: 'turno', idioma: 'es_AR', variables: ['Juan'] });
    await webhook(b, {
      object: 'whatsapp_business_account',
      entry: [{ id: n.wabaId, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: n.phoneNumberId },
        contacts: [{ wa_id: '5491100000001', profile: { name: 'Juan' } }],
        messages: [{ from: '5491100000001', id: 'wamid.tocado', timestamp: '1760108400', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Mar 15:00' } } }],
      } }] }],
    });

    const { mensajes } = (await pedir(b, CLAVE_ADMIN, 'GET', `/admin/charlas/${n.id}/5491100000001`)).json;
    expect(mensajes[1]).toMatchObject({ texto: 'Elegí uno', contenido: { cuerpo: 'Elegí uno', botones: ['Mar 15:00', 'Mié 16:00'] } });
    expect(mensajes[2]).toMatchObject({ plantilla: 'turno', texto: 'Hola Juan', contenido: { cuerpo: 'Hola Juan' } });
    expect(mensajes[3]).toMatchObject({ direccion: 'entra', texto: 'Mar 15:00', contenido: { toco: 'Mar 15:00' } });
  });

  it('una plantilla guardada antes del texto armado se arma con la del negocio o con una conocida', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    const vieja = (plantilla: string, texto: string, wamid: string) =>
      b.store.guardarMensaje({ negocioId: n.id, numeroId: n.numeroId, contacto: '5491100000001', direccion: 'sale', tipo: 'template', texto, mediaId: null, referral: null, plantilla, wamid, categoria: 'utility', costoEstimado: 0, costoReal: null, estado: 'read', error: null, fecha: new Date(b.reloj.ahora) });
    await webhook(b, texto(n.phoneNumberId, '5491100000001', 'Hola'));
    await vieja('turno', 'Juan', 'w1');
    await vieja('consulta_web', 'Antonio | stock de repuestos', 'w2');
    await vieja('desconocida', 'x | y', 'w3');
    const { mensajes } = (await pedir(b, CLAVE_ADMIN, 'GET', `/admin/charlas/${n.id}/5491100000001`)).json;
    expect(mensajes[1]).toMatchObject({ texto: 'Hola Juan' });
    expect(mensajes[2].texto).toContain('Hola Antonio! 👋 Somos Sincro.');
    expect(mensajes[2].texto).toContain('consulta sobre stock de repuestos');
    expect(mensajes[2].contenido.botones).toEqual(['Tengo una duda', 'Agendar reunión']);
    expect(mensajes[3]).toMatchObject({ texto: 'x | y', contenido: null });
  });

  it('filtra por negocio', async () => {
    const a = await negocioConNumero(b, ['leads']);
    const otro = await negocioConNumero(b, ['leads']);
    await webhook(b, texto(a.phoneNumberId, '5491100000001', 'a'));
    await webhook(b, texto(otro.phoneNumberId, '5491100000002', 'b'));
    const r = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/charlas?negocio=${otro.id}`);
    expect(r.json.map((c: { contacto: string }) => c.contacto)).toEqual(['5491100000002']);
  });

  it('una app no lee charlas de nadie por aca, ni de su propio negocio', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, n.clave, 'GET', '/admin/charlas')).status).not.toBe(200);
    expect((await pedir(b, n.clave, 'GET', `/admin/charlas/${n.id}/5491100000001`)).status).not.toBe(200);
  });

  it('una charla que no existe es 404', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect((await pedir(b, CLAVE_ADMIN, 'GET', `/admin/charlas/${n.id}/5491199999999`)).status).toBe(404);
  });
});
