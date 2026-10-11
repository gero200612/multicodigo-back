import { beforeEach, describe, expect, it } from 'vitest';
import { TEXTO_DE_BAJA } from '../src/reglas.js';
import {
  armar,
  cambioDeMensajes,
  CLAVE_ADMIN,
  entrante,
  estado,
  negocioConNumero,
  pedir,
  plantillaAprobada,
  texto,
  VERIFY,
  webhook,
  type Banco,
} from './armar.js';

let b: Banco;
beforeEach(() => {
  b = armar();
});

describe('firma', () => {
  it('valida pasa, invalida o ausente da 401', async () => {
    const n = await negocioConNumero(b, ['leads']);
    const cuerpo = texto(n.phoneNumberId, '5491100000001', 'hola');
    expect((await webhook(b, cuerpo)).statusCode).toBe(200);
    expect((await webhook(b, cuerpo, 'sha256=' + '0'.repeat(64))).statusCode).toBe(401);
    expect((await webhook(b, cuerpo, null)).statusCode).toBe(401);
    // Sin content-type tambien es 401, no 415.
    const sinTipo = await b.publico.inject({ method: 'POST', url: '/webhook', payload: 'x' });
    expect(sinTipo.statusCode).toBe(401);
    expect(b.store.mensajesT.filter((m) => m.direccion === 'entra')).toHaveLength(1);
  });

  it('GET de verificacion', async () => {
    const ok = await b.publico.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const mal = await b.publico.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1' });
    expect(mal.statusCode).toBe(403);
  });
});

describe('ruteo', () => {
  it('un phone_number_id desconocido se descarta y se registra', async () => {
    await negocioConNumero(b, ['leads']);
    const r = await webhook(b, texto('999999', '5491100000001', 'hola'));
    expect(r.statusCode).toBe(200);
    expect(b.store.mensajesT).toEqual([]);
    expect(b.logs.some((l) => l.includes('desconocido') && l.includes('999999'))).toBe(true);
  });

  it('leads recibe el mensaje con nombre y referral; un webhook repetido no duplica', async () => {
    const n = await negocioConNumero(b, ['leads']);
    const referral = { source_type: 'ad', source_id: '120', headline: 'Automatizá' };
    const cuerpo = entrante(n.phoneNumberId, '5491100000001', { text: { body: 'vi el anuncio' }, referral });
    await webhook(b, cuerpo);
    await webhook(b, cuerpo);
    const eventos = b.store.eventosT.filter((e) => e.negocioId === n.id);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      tipo: 'mensaje',
      datos: { contacto: '5491100000001', nombre: 'Juan', tipo: 'text', texto: 'vi el anuncio', media_id: null, referral },
    });
    const charla = await pedir(b, n.clave, 'GET', '/charlas/5491100000001');
    expect(charla.json).toMatchObject({ ventana_abierta: true, baja: false, derivada: false });
    expect(charla.json.mensajes).toHaveLength(1);
  });
});

describe('bajas', () => {
  it('"baja" no pasa a la app, se contesta una vez y bloquea los avisos; "alta" revierte', async () => {
    const n = await negocioConNumero(b, ['leads', 'avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await webhook(b, texto(n.phoneNumberId, '5491100000002', 'BAJA'));
    await webhook(b, texto(n.phoneNumberId, '5491100000002', 'baja'));
    expect(b.store.eventosT.filter((e) => e.tipo === 'mensaje')).toEqual([]);
    expect(b.meta.enviados.filter((e) => e.texto === TEXTO_DE_BAJA)).toHaveLength(1);

    const aviso = { a: '5491100000002', plantilla: 'turno', idioma: 'es_AR', variables: ['mañana'] };
    expect(await pedir(b, n.clave, 'POST', '/avisos', aviso)).toMatchObject({ status: 409, json: { code: 'baja' } });
    expect(await pedir(b, n.clave, 'POST', '/mensajes', { a: '5491100000002', texto: 'hola' })).toMatchObject({
      status: 409,
      json: { code: 'baja' },
    });
    const bajas = await pedir(b, CLAVE_ADMIN, 'GET', `/admin/bajas?negocio=${n.id}`);
    expect(bajas.json).toEqual([{ negocio_id: n.id, contacto: '5491100000002', desde: b.reloj.ahora.toISOString() }]);

    await webhook(b, texto(n.phoneNumberId, '5491100000002', 'ALTA'));
    expect((await pedir(b, n.clave, 'POST', '/avisos', aviso)).status).toBe(200);
  });
});

describe('estados', () => {
  async function avisoMandado() {
    const n = await negocioConNumero(b, ['avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    const r = await pedir(b, n.clave, 'POST', '/avisos', { a: '5491100000003', plantilla: 'turno', idioma: 'es_AR', variables: [] });
    expect(r.status).toBe(200);
    expect(r.json.costo_estimado_ars).toBeCloseTo(37.6798);
    return { n, wamid: r.json.wamid as string, id: r.json.id as number };
  }

  it('billable:false deja el costo real en 0 y avisa el estado a la app', async () => {
    const { n, wamid, id } = await avisoMandado();
    await webhook(b, estado(n.phoneNumberId, wamid, 'sent', { pricing: { billable: false, category: 'utility', pricing_model: 'PMP' } }));
    const m = b.store.mensajesT.find((x) => x.id === id)!;
    expect(m.costoReal).toBe(0);
    expect(m.estado).toBe('sent');
    const ev = b.store.eventosT.filter((e) => e.tipo === 'estado');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.datos).toEqual({ mensaje_id: id, wamid, estado: 'sent', error: null });
  });

  it('con pricing cobrable, el real es el precio de la categoria', async () => {
    const { n, wamid, id } = await avisoMandado();
    await webhook(b, estado(n.phoneNumberId, wamid, 'delivered', { pricing: { billable: true, category: 'marketing' } }));
    expect(b.store.mensajesT.find((x) => x.id === id)!.costoReal).toBeCloseTo(89.562);
  });

  it('son idempotentes: repetido o viejo no cambia ni emite', async () => {
    const { n, wamid, id } = await avisoMandado();
    await webhook(b, estado(n.phoneNumberId, wamid, 'read'));
    await webhook(b, estado(n.phoneNumberId, wamid, 'read'));
    await webhook(b, estado(n.phoneNumberId, wamid, 'delivered'));
    expect(b.store.mensajesT.find((x) => x.id === id)!.estado).toBe('read');
    expect(b.store.eventosT.filter((e) => e.tipo === 'estado')).toHaveLength(1);
  });

  it('un failed trae el error tapado', async () => {
    const { n, wamid } = await avisoMandado();
    await webhook(
      b,
      estado(n.phoneNumberId, wamid, 'failed', {
        errors: [{ code: 131026, title: 'Undeliverable', error_data: { details: 'token EAAabcdefghijklmnop invalido' } }],
      }),
    );
    const ev = b.store.eventosT.find((e) => e.tipo === 'estado')!;
    expect(ev.datos.error).toEqual({ codigo: 131026, detalle: 'token EAA… invalido' });
  });
});

describe('plantillas por webhook', () => {
  it('recategorizada a marketing queda bloqueada para una app sin promociones, con alerta', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await webhook(
      b,
      cambioDeMensajes(
        n.phoneNumberId,
        { message_template_id: 'meta-turno', message_template_name: 'turno', message_template_language: 'es_AR', previous_category: 'UTILITY', new_category: 'MARKETING' },
        'template_category_update',
        n.wabaId,
      ),
    );
    const p = (await b.store.plantilla(n.id, 'turno', 'es_AR'))!;
    expect(p).toMatchObject({ categoria: 'MARKETING', bloqueada: true });
    expect(b.store.alertasT.map((a) => a.tipo)).toContain('plantilla_bloqueada');
    const r = await pedir(b, n.clave, 'POST', '/avisos', { a: '5491100000004', plantilla: 'turno', idioma: 'es_AR' });
    expect(r).toMatchObject({ status: 404, json: { code: 'no_existe' } });
    expect(b.store.intentosNegados.at(-1)).toMatchObject({ negocioId: n.id, ruta: '/avisos' });
  });

  it('con promociones no se bloquea', async () => {
    const n = await negocioConNumero(b, ['avisos', 'promociones']);
    await plantillaAprobada(b, n.id, n.wabaId, 'turno', 'UTILITY');
    await webhook(
      b,
      cambioDeMensajes(n.phoneNumberId, { message_template_id: 'meta-turno', new_category: 'MARKETING' }, 'template_category_update', n.wabaId),
    );
    expect((await b.store.plantilla(n.id, 'turno', 'es_AR'))!.bloqueada).toBe(false);
  });

  it('rechazada: estado, motivo y alerta', async () => {
    const n = await negocioConNumero(b, ['avisos']);
    await b.store.crearPlantilla({
      negocioId: n.id,
      wabaId: n.wabaId,
      metaId: '777',
      nombre: 'turno',
      idioma: 'es_AR',
      categoria: 'UTILITY',
      componentes: [],
      estado: 'PENDING',
      motivo: null,
      bloqueada: false,
    });
    await webhook(
      b,
      cambioDeMensajes(n.phoneNumberId, { event: 'REJECTED', message_template_id: 777, reason: 'INVALID_FORMAT' }, 'message_template_status_update', n.wabaId),
    );
    const lista = await pedir(b, n.clave, 'GET', '/plantillas');
    expect(lista.json[0]).toMatchObject({ estado: 'REJECTED', motivo: 'INVALID_FORMAT' });
    expect(b.store.alertasT.find((a) => a.tipo === 'plantilla_rechazada')?.texto).toContain('INVALID_FORMAT');
  });
});

describe('calidad', () => {
  it('phone_number_quality_update refresca y alerta si baja a amarilla', async () => {
    const n = await negocioConNumero(b, ['leads']);
    b.meta.datos = { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_1K' };
    await webhook(b, cambioDeMensajes(n.phoneNumberId, { event: 'FLAGGED', current_limit: 'TIER_1K' }, 'phone_number_quality_update', n.wabaId));
    const num = (await b.store.numero(n.numeroId))!;
    expect(num).toMatchObject({ calidad: 'YELLOW', topeMeta: 1000 });
    expect(b.store.alertasT.find((a) => a.tipo === 'calidad')?.texto).toContain('amarilla');
  });
});
