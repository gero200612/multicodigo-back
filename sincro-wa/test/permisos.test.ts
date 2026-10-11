import { beforeEach, describe, expect, it } from 'vitest';
import { armar, CLAVE_ADMIN, entrante, negocioConNumero, pedir, texto, webhook, type Banco } from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

describe('servidor publico', () => {
  it('solo tiene webhook y salud: /admin/negocios da 404 aunque tenga la clave', async () => {
    const r = await b.publico.inject({ method: 'GET', url: '/admin/negocios', headers: { authorization: `Bearer ${CLAVE_ADMIN}` } });
    expect(r.statusCode).toBe(404);
    expect((await b.publico.inject({ method: 'POST', url: '/mensajes', payload: {} })).statusCode).toBe(404);
    expect((await b.publico.inject({ method: 'GET', url: '/salud' })).statusCode).toBe(200);
  });

  it('el privado no tiene /webhook', async () => {
    expect((await pedir(b, CLAVE_ADMIN, 'POST', '/webhook', {})).status).toBe(404);
  });
});

describe('autenticacion', () => {
  it('sin clave o clave desconocida: 401 sin_clave', async () => {
    expect(await pedir(b, null, 'GET', '/yo')).toMatchObject({ status: 401, json: { code: 'sin_clave' } });
    expect(await pedir(b, 'cualquiera', 'GET', '/yo')).toMatchObject({ status: 401, json: { code: 'sin_clave' } });
    const n = await negocioConNumero(b, ['leads']);
    // Misma forma, otro secreto.
    const falsa = n.clave.slice(0, -4) + (n.clave.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await pedir(b, falsa, 'GET', '/yo')).status).toBe(401);
  });

  it('admin requerido para /admin: la clave de app recibe 404', async () => {
    const n = await negocioConNumero(b, ['leads']);
    expect(await pedir(b, n.clave, 'GET', '/admin/negocios')).toMatchObject({ status: 404, json: { code: 'no_existe' } });
    expect((await pedir(b, null, 'GET', '/admin/negocios')).status).toBe(401);
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/admin/negocios')).status).toBe(200);
  });

  it('la clave de admin no usa rutas de app', async () => {
    expect((await pedir(b, CLAVE_ADMIN, 'GET', '/yo')).status).toBe(404);
    expect((await pedir(b, CLAVE_ADMIN, 'POST', '/mensajes', { a: '5491100000000', texto: 'x' })).status).toBe(404);
  });

  it('GET /yo no muestra gasto ni tope', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    const r = await pedir(b, n.clave, 'GET', '/yo');
    expect(r.json).toEqual({ negocio: { id: n.id, nombre: 'Negocio facturas', capacidades: ['facturas'] } });
  });

  it('negocio inactivo: 404 en todo', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await pedir(b, CLAVE_ADMIN, 'PATCH', `/admin/negocios/${n.id}`, { activo: false, quien: 'gero' });
    expect((await pedir(b, n.clave, 'GET', '/yo')).status).toBe(404);
  });

  it('rotar la clave invalida la vieja', async () => {
    const n = await negocioConNumero(b, ['leads']);
    const r = await pedir(b, CLAVE_ADMIN, 'POST', `/admin/negocios/${n.id}/rotar-clave`, { quien: 'gero' });
    expect((await pedir(b, n.clave, 'GET', '/yo')).status).toBe(401);
    expect((await pedir(b, r.json.clave, 'GET', '/yo')).status).toBe(200);
  });

  it('anota el ultimo uso de la clave', async () => {
    const n = await negocioConNumero(b, ['leads']);
    await pedir(b, n.clave, 'GET', '/yo');
    expect((await b.store.negocio(n.id))!.claveUltimoUso).toEqual(b.reloj.ahora);
  });
});

describe('minimo privilegio', () => {
  it('una clave con solo facturas recibe 404 en avisos, plantillas, mensajes y charlas, y queda registrado', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    const rutas: [any, string, unknown?][] = [
      ['POST', '/avisos', { a: '5491100000000', plantilla: 'x', idioma: 'es_AR' }],
      ['POST', '/plantillas', { nombre: 'x', idioma: 'es_AR', categoria: 'UTILITY', componentes: [{ type: 'BODY', text: 'x' }] }],
      ['GET', '/plantillas'],
      ['POST', '/mensajes', { a: '5491100000000', texto: 'hola' }],
      ['GET', '/charlas/5491100000000'],
      ['PUT', '/atender/contexto', { texto: 'x' }],
    ];
    for (const [metodo, url, cuerpo] of rutas) {
      expect(await pedir(b, n.clave, metodo, url, cuerpo), `${metodo} ${url}`).toMatchObject({ status: 404, json: { code: 'no_existe' } });
    }
    expect(b.store.intentosNegados.map((i) => `${i.metodo} ${i.ruta}`)).toEqual([
      'POST /avisos',
      'POST /plantillas',
      'GET /plantillas',
      'POST /mensajes',
      'GET /charlas/:contacto',
      'PUT /atender/contexto',
    ]);
    // Una ruta que no existe da lo mismo: no se distingue.
    expect(await pedir(b, n.clave, 'GET', '/inventada')).toMatchObject({ status: 404, json: { code: 'no_existe' } });
  });

  it('a una app con solo facturas no le llegan charlas', async () => {
    const n = await negocioConNumero(b, ['facturas']);
    await webhook(b, texto(n.phoneNumberId, '5491111111111', 'hola, quiero un turno'));
    expect(b.store.eventosT.filter((e) => e.negocioId === n.id)).toEqual([]);
    expect(b.store.trabajosT).toEqual([]);
  });

  it('la app A no puede mandar desde el numero de B ni ver su media', async () => {
    const a = await negocioConNumero(b, ['leads']);
    const otro = await negocioConNumero(b, ['leads']);
    b.meta.archivos.set('m1', { mime: 'image/jpeg', datos: Buffer.from('foto de B') });
    await webhook(b, entrante(otro.phoneNumberId, '5491122222222', { type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } }));
    const mediaDeB = b.store.mediaT[0]!;
    expect(mediaDeB.negocioId).toBe(otro.id);

    expect((await pedir(b, a.clave, 'GET', `/media/${mediaDeB.id}`)).status).toBe(404);
    const propia = await pedir(b, otro.clave, 'GET', `/media/${mediaDeB.id}`);
    expect(propia.status).toBe(200);
    expect(propia.res.headers['content-type']).toBe('image/jpeg');
    expect(propia.res.rawPayload.toString()).toBe('foto de B');

    // El contacto le escribio a B: para A esa charla no tiene ventana y sale
    // (si saliera) desde el numero de A, nunca desde el de B.
    const r = await pedir(b, a.clave, 'POST', '/mensajes', { a: '5491122222222', texto: 'hola' });
    expect(r).toMatchObject({ status: 409, json: { code: 'fuera_de_ventana' } });
    expect(b.meta.enviados.filter((e) => e.desde === otro.phoneNumberId && e.texto === 'hola')).toEqual([]);
    // Y la charla de B no se ve desde A.
    const charla = await pedir(b, a.clave, 'GET', '/charlas/5491122222222');
    expect(charla.json.mensajes).toEqual([]);
  });

  it('avisos no puede crear plantillas de marketing (404) y si de utilidad', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    const cuerpo = { nombre: 'promo', idioma: 'es_AR', categoria: 'MARKETING', componentes: [{ type: 'BODY', text: 'Oferta' }] };
    expect(await pedir(b, n.clave, 'POST', '/plantillas', cuerpo)).toMatchObject({ status: 404, json: { code: 'no_existe' } });
    expect(b.meta.creadas).toEqual([]);
    const ok = await pedir(b, n.clave, 'POST', '/plantillas', { ...cuerpo, nombre: 'turno', categoria: 'UTILITY' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ nombre: 'turno', categoria: 'UTILITY', estado: 'PENDING', bloqueada: false });
    expect(b.meta.creadas).toEqual([{ wabaId: n.wabaId, nombre: 'turno', categoria: 'UTILITY' }]);
    expect((await pedir(b, n.clave, 'GET', '/plantillas')).json).toHaveLength(1);
  });

  it('una plantilla que Meta recategoriza al crearla queda bloqueada', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    b.meta.categoriaAlCrear = 'MARKETING';
    const ok = await pedir(b, n.clave, 'POST', '/plantillas', {
      nombre: 'turno',
      idioma: 'es_AR',
      categoria: 'UTILITY',
      componentes: [{ type: 'BODY', text: 'x' }],
    });
    expect(ok.json).toMatchObject({ categoria: 'MARKETING', bloqueada: true });
  });

  it('atender sin leads solo contesta charlas derivadas', async () => {
    const n = await negocioConNumero(b, ['atender']);
    await webhook(b, texto(n.phoneNumberId, '5491133333333', 'hola'));
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491133333333', texto: 'hola' })).toMatchObject({
      status: 409,
      json: { code: 'no_derivada' },
    });
    await b.store.cambiarContacto(n.numeroId, '5491133333333', { derivada: true });
    expect((await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491133333333', texto: 'hola' })).status).toBe(200);
  });
});
