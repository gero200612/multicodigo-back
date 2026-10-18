import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { crearApi } from '../src/api.js';
import {
  aprobarRevision,
  arrancarExperimento,
  clienteDelAnfitrion,
  estadoDelHost,
  idDeLeadDeWhatsapp,
  metaSinAnuncios,
  motivoPendiente,
  pedirMotivo,
  recibirAprobacion,
  rechazarRevision,
  reenviarLead,
  type ClienteDelAnfitrion,
  type DepsDelAnfitrion,
} from '../src/anfitrion.js';
import { leerLeadsDeMeta } from '../src/anuncios.js';
import { leerConfig } from '../src/config.js';
import { recibirLeads, type ClienteWa, type EventoWa } from '../src/whatsapp.js';
import { armar } from './armar.js';
import { metaFalsa } from './meta-falsa.js';
import { MemoriaStore } from './memoria.js';

const TOKEN = 'token-del-host-de-prueba-1234567890';
const URL_HOST = 'http://sincro-host:8080';
const REVISION = '3b2c4f0e-1111-4222-8333-444455556666';

/** Un host de mentira: anota lo que Homero le pide. */
function hostFalso(o: { falla?: string } = {}) {
  const llamadas: { metodo: string; ruta: string; cuerpo?: unknown; autorizacion?: string }[] = [];
  const pedir = (async (url: string, init?: RequestInit) => {
    const ruta = url.replace(URL_HOST, '');
    llamadas.push({
      metodo: init?.method ?? 'GET',
      ruta,
      cuerpo: init?.body ? JSON.parse(String(init.body)) : undefined,
      autorizacion: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (o.falla) return new Response(JSON.stringify({ error: o.falla }), { status: 409 });
    if (ruta === '/homero/experimento') return new Response(JSON.stringify({ texto: 'Día 4 de 10' }));
    if (ruta === '/homero/arrancar') return new Response(JSON.stringify({ ok: true, texto: 'El experimento arrancó el 20/10' }));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  return { llamadas, cliente: clienteDelAnfitrion({ url: URL_HOST, token: TOKEN }, pedir) };
}

async function conAnfitrion(o: { falla?: string; descarga?: Response | (() => never) } = {}) {
  const host = hostFalso(o);
  const medios = await mkdtemp(join(tmpdir(), 'homero-anfitrion-'));
  const store = new MemoriaStore(() => new Date('2026-10-20T15:00:00Z'));
  const videos: { archivo: string; pie: string }[] = [];
  const tarjetas: { texto: string; botones: string[] }[] = [];
  const descargas: string[] = [];
  const deps: DepsDelAnfitrion = {
    store,
    anfitrion: host.cliente,
    medios,
    mandarVideo: async (archivo, pie) => {
      videos.push({ archivo, pie });
    },
    proponer: async (texto, botones) => {
      tarjetas.push({ texto, botones: botones.map((b) => b.datos) });
      return 7;
    },
    avisar: async () => undefined,
    pedir: (async (url: string) => {
      descargas.push(url);
      if (typeof o.descarga === 'function') return o.descarga();
      return o.descarga ?? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as unknown as typeof fetch,
  };
  return { ...host, deps, store, videos, tarjetas, descargas, medios };
}

const APROBACION = {
  revision: REVISION,
  pieza: '9a9a9a9a-1111-4222-8333-444455556666',
  tema: 'Facturas que se cargan solas',
  texto: 'Dejá de tipear facturas.',
  porQue: 'Es el dolor que más piden.',
  puntaje: 4.2,
  duracion: 22.4,
  videoUrl: `${URL_HOST}/files/5c1a/abcdef.mp4`,
};

describe('el cliente del host', () => {
  it('lleva el token en el header y los datos de cada pedido', async () => {
    const { cliente, llamadas } = hostFalso();
    await cliente.aprobar(REVISION);
    await cliente.rechazar(REVISION, 'muy largo');
    await cliente.lead({ id: 'meta-1', fuente: 'meta_form', creado: new Date('2026-10-20T15:00:00Z'), anuncio: '999', estado: 'nuevo' });
    expect(llamadas.map((l) => `${l.metodo} ${l.ruta}`)).toEqual([
      `POST /homero/calibracion/${REVISION}/aprobar`,
      `POST /homero/calibracion/${REVISION}/rechazar`,
      'POST /homero/leads',
    ]);
    expect(llamadas.every((l) => l.autorizacion === `Bearer ${TOKEN}`)).toBe(true);
    expect(llamadas[1]!.cuerpo).toEqual({ motivo: 'muy largo' });
    expect(llamadas[2]!.cuerpo).toEqual({ id: 'meta-1', fuente: 'meta_form', creado: '2026-10-20T15:00:00.000Z', anuncio: '999', estado: 'nuevo' });
  });

  it('un error del host se cuenta sin el token', async () => {
    const { cliente } = hostFalso({ falla: `No se arrancó con ${TOKEN}` });
    await expect(cliente.arrancar(150000)).rejects.toThrow('No se arrancó con [token]');
  });

  it('un host caido es un error claro y sin el token', async () => {
    const cliente = clienteDelAnfitrion(
      { url: URL_HOST, token: TOKEN },
      (async () => {
        throw new Error(`connect ECONNREFUSED ${TOKEN}`);
      }) as unknown as typeof fetch,
    );
    const err = await cliente.experimento().catch((e: Error) => e);
    expect((err as Error).message).toContain('no pude hablar con el host');
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('los leads hacia el host', () => {
  it('el id de WhatsApp es un hash: estable y sin el telefono', () => {
    const id = idDeLeadDeWhatsapp('5491122334455');
    expect(id).toBe(idDeLeadDeWhatsapp('+54 9 11 2233-4455'));
    expect(id).toMatch(/^wa-[0-9a-f]{20}$/);
    expect(id).not.toContain('5491122334455');
  });

  it('si el host no contesta se reintenta una vez y se sigue sin tirar', async () => {
    const lead = vi.fn().mockRejectedValue(new Error('caído'));
    const log = vi.fn();
    const ok = await reenviarLead({ lead } as unknown as ClienteDelAnfitrion, { id: 'x', fuente: 'web', creado: new Date() }, log);
    expect(ok).toBe(false);
    expect(lead).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(await reenviarLead(undefined, { id: 'x', fuente: 'web', creado: new Date() })).toBe(false);
  });

  it('un lead de un formulario de Meta se reenvia con su id y su anuncio, sin nombre ni mail ni telefono', async () => {
    const f = metaFalsa();
    const h = armar({ meta: f.meta });
    const reenviados: unknown[] = [];
    const id = await h.store.crearAnuncio({
      rubro: 'taller', titulo: 'T', texto: 'x'.repeat(40), plantilla: 'panel', contenido: { titulo: 'x' } as never, frase: 'f', preguntas: [], diario: 2000, porQue: 'p', imagen: Buffer.from('png'),
    } as never);
    await h.store.actualizarAnuncio(id, { estado: 'activo', metaIds: { imagen: 'h1', formulario: 'form1', conjunto: 'set1', creativo: 'cre1', anuncio: 'ad1' } });
    f.datos.leads.set('form1', [
      { id: 'L1', creado: new Date(), formulario: 'form1', anuncio: 'ad1', campos: { full_name: 'Ana Gómez', email: 'ana@taller.com', phone_number: '+5491122334455' } },
    ]);
    const deps = { ...h.deps, alLeadNuevo: (l: unknown) => void reenviados.push(l) };

    await leerLeadsDeMeta(deps);
    await leerLeadsDeMeta(deps);

    expect(reenviados).toHaveLength(1);
    expect(reenviados[0]).toMatchObject({ id: 'L1', fuente: 'meta_form', anuncio: 'ad1' });
    expect(JSON.stringify(reenviados)).not.toMatch(/ana|gómez|taller\.com|5491122334455/i);
  });

  it('el bot avisa de cada formulario y de cada charla con un evento, sin pasar el telefono', async () => {
    const h = armar();
    const eventos: EventoWa[] = [
      { id: 11, tipo: 'mensaje', fecha: '2026-10-20T15:00:00Z', datos: { contacto: '5491122334455', texto: 'hola' } },
      { id: 12, tipo: 'formulario', fecha: '2026-10-20T15:01:00Z', datos: { nombre: 'Ana' } },
      { id: 13, tipo: 'otro', fecha: '2026-10-20T15:01:00Z', datos: {} },
    ];
    const acks: number[][] = [];
    const wa = { eventos: async () => eventos, ack: async (ids: number[]) => void acks.push(ids) } as unknown as ClienteWa;
    const vistos: unknown[] = [];

    await recibirLeads(wa, h.store, h.deps.ahora, (l) => void vistos.push(l));

    expect(vistos).toEqual([
      { fuente: 'whatsapp', contacto: '5491122334455', evento: 11 },
      { fuente: 'web', evento: 12 },
    ]);
    expect(acks).toEqual([[11, 12, 13]]);
  });
});

describe('las tarjetas de calibracion', () => {
  it('baja el video del host, lo manda con su tarjeta y los botones Aprobar y Rechazar', async () => {
    const h = await conAnfitrion();

    const r = await recibirAprobacion(APROBACION, h.deps);

    expect(r).toEqual({ ok: true, n: 1 });
    expect(h.descargas).toEqual([APROBACION.videoUrl]);
    expect(await readFile(h.videos[0]!.archivo)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(h.videos[0]!.pie).toContain('Facturas que se cargan solas');
    expect(h.tarjetas[0]!.botones).toEqual(['ha:1', 'hn:1']);
    expect(h.tarjetas[0]!.texto).toContain('Dejá de tipear facturas.');
    expect(h.tarjetas[0]!.texto).toContain('Puntaje del crítico: 4.2 de 5');
    expect(h.tarjetas[0]!.texto).toContain('no gasta nada hasta que vos arranques');
  });

  it('el mismo pedido dos veces no manda la tarjeta de nuevo', async () => {
    const h = await conAnfitrion();
    await recibirAprobacion(APROBACION, h.deps);

    const otra = await recibirAprobacion(APROBACION, h.deps);

    expect(otra).toEqual({ ok: true, n: 1, repetido: true });
    expect(h.tarjetas).toHaveLength(1);
    expect(h.descargas).toHaveLength(1);
  });

  it('no baja un video que no es del host', async () => {
    const h = await conAnfitrion();

    const r = await recibirAprobacion({ ...APROBACION, videoUrl: 'http://169.254.169.254/latest/meta-data' }, h.deps);

    expect(r).toEqual({ ok: false, motivo: 'el video no es del host' });
    expect(h.descargas).toHaveLength(0);
  });

  it('un pedido inválido o sin host configurado no hace nada', async () => {
    const h = await conAnfitrion();
    expect(await recibirAprobacion({ revision: 'no-es-un-uuid' }, h.deps)).toEqual({ ok: false, motivo: 'pedido inválido' });
    expect(await recibirAprobacion(APROBACION, { ...h.deps, anfitrion: undefined })).toMatchObject({ ok: false });
  });

  it('si Telegram falla no queda la tarjeta anotada: el reintento del host sigue con el mismo numero', async () => {
    const h = await conAnfitrion();
    let falla = true;
    const deps: DepsDelAnfitrion = {
      ...h.deps,
      proponer: async (t, b) => {
        if (falla) throw new Error('Telegram caído');
        return h.deps.proponer(t, b);
      },
    };

    const primero = await recibirAprobacion(APROBACION, deps);
    expect(primero.ok).toBe(false);
    falla = false;
    const segundo = await recibirAprobacion(APROBACION, deps);

    expect(segundo).toEqual({ ok: true, n: 1 });
    expect(h.tarjetas).toHaveLength(1);
  });

  it('un video de 0 bytes o una descarga rota no se manda', async () => {
    const vacio = await conAnfitrion({ descarga: new Response(new Uint8Array(0), { status: 200 }) });
    expect((await recibirAprobacion(APROBACION, vacio.deps)).ok).toBe(false);
    const roto = await conAnfitrion({ descarga: new Response('x', { status: 404 }) });
    expect(await recibirAprobacion(APROBACION, roto.deps)).toEqual({ ok: false, motivo: 'el host contestó 404 al bajar el video' });
    expect(roto.tarjetas).toHaveLength(0);
  });

  it('aprobar le avisa al host, borra el video y no se puede aprobar dos veces', async () => {
    const h = await conAnfitrion();
    await recibirAprobacion(APROBACION, h.deps);

    const texto = await aprobarRevision(1, h.deps);

    expect(texto).toContain('Aprobado');
    expect(h.llamadas.at(-1)).toMatchObject({ metodo: 'POST', ruta: `/homero/calibracion/${REVISION}/aprobar` });
    await expect(stat(h.videos[0]!.archivo)).rejects.toThrow();
    expect(await aprobarRevision(1, h.deps)).toBe('Ese reel ya estaba decidido.');
    expect(h.llamadas.filter((l) => l.ruta.endsWith('/aprobar'))).toHaveLength(1);
  });

  it('si el host rechaza la aprobacion la tarjeta sigue pendiente', async () => {
    const h = await conAnfitrion({ falla: 'Esa revisión ya está rechazada.' });
    await recibirAprobacion(APROBACION, { ...h.deps, anfitrion: hostFalso().cliente });
    // Mismo estado, pero ahora el host contesta 409.
    const texto = await aprobarRevision(1, { ...h.deps, store: h.store });
    expect(texto).toContain('No pude aprobarlo: Esa revisión ya está rechazada.');
  });

  it('rechazar pide primero el motivo y con el motivo se lo manda al host', async () => {
    const h = await conAnfitrion();
    await recibirAprobacion(APROBACION, h.deps);

    expect(await pedirMotivo(1, h.deps)).toContain('Escribime por qué rechazás el reel 1');
    expect(await motivoPendiente(h.deps)).toBe(1);
    // Se espera una sola vez: el mensaje siguiente ya es otra cosa.
    expect(await motivoPendiente(h.deps)).toBeUndefined();

    const texto = await rechazarRevision(1, '  Muy largo, el gancho llega tarde  ', h.deps);

    expect(texto).toContain('Rechazado');
    expect(h.llamadas.at(-1)).toMatchObject({ ruta: `/homero/calibracion/${REVISION}/rechazar`, cuerpo: { motivo: 'Muy largo, el gancho llega tarde' } });
    expect(await rechazarRevision(1, 'otra vez', h.deps)).toBe('Ese reel ya estaba decidido.');
  });

  it('un rechazo sin motivo no sale, y si el host falla se vuelve a esperar el motivo', async () => {
    const h = await conAnfitrion();
    await recibirAprobacion(APROBACION, h.deps);
    expect(await rechazarRevision(1, '   ', h.deps)).toBe('Necesito el motivo para rechazarlo.');

    const conFalla = await conAnfitrion({ falla: 'el host no puede' });
    await recibirAprobacion(APROBACION, { ...conFalla.deps, anfitrion: h.deps.anfitrion });
    const texto = await rechazarRevision(1, 'no me gusta', conFalla.deps);
    expect(texto).toContain('No pude rechazarlo: el host no puede');
    expect(await motivoPendiente(conFalla.deps)).toBe(1);
  });
});

describe('arrancar el experimento', () => {
  it('Homero solo pasa el limite que dio Gero y cuenta lo que contesta el host', async () => {
    const h = await conAnfitrion();

    expect(await arrancarExperimento(150000, h.deps)).toBe('El experimento arrancó el 20/10');
    expect(h.llamadas.at(-1)).toMatchObject({ metodo: 'POST', ruta: '/homero/arrancar', cuerpo: { tope: 150000 } });
    expect(await estadoDelHost(h.deps)).toBe('Día 4 de 10');
  });

  it('si el host rechaza el arranque (por ejemplo, el limite no deja margen) lo dice tal cual', async () => {
    const h = await conAnfitrion({ falla: 'El límite de gasto tiene que ser mayor a lo ya gastado' });

    expect(await arrancarExperimento(1000, h.deps)).toBe('No arranqué: El límite de gasto tiene que ser mayor a lo ya gastado');
  });

  it('sin host configurado no hace nada', async () => {
    expect(await arrancarExperimento(1000, {})).toContain('no tiene configurado el host');
    expect(await estadoDelHost({})).toContain('no tiene configurado el host');
  });
});

describe('los anuncios propios en pausa', () => {
  it('lee y publica lo organico pero no crea ni cambia anuncios, formularios, estados ni presupuestos', async () => {
    const f = metaFalsa();
    const meta = metaSinAnuncios(f.meta);

    await meta.cuenta();
    await meta.insights('2026-10-01', '2026-10-20');
    await meta.leads('form1', new Date());
    for (const peligro of [
      () => meta.crearCampana('x'),
      () => meta.crearFormulario({ nombre: 'f', preguntas: [], privacidad: 'p', web: 'w', gracias: 'g' }),
      () => meta.crearConjunto({ campana: 'c', nombre: 'n', diario: 1000, intereses: [] }),
      () => meta.crearAnuncio({ nombre: 'a', conjunto: 'c', creativo: 'k' }),
      () => meta.cambiarEstado('ad1', 'ACTIVE'),
      () => meta.cambiarDiario('set1', 99999),
      () => meta.crearCreativoDeReel({ nombre: 'n', media: 'm', formulario: 'f', web: 'w' }),
    ])
      await expect(peligro()).rejects.toThrow('anuncios propios de Homero están en pausa');

    expect(f.llamadas.map((l) => l.metodo)).toEqual(['cuenta', 'insights', 'leads']);
  });

  it('un metodo nuevo de Meta queda bloqueado hasta que alguien lo permita (falla cerrado)', async () => {
    const f = metaFalsa();
    (f.meta as unknown as Record<string, unknown>).gastarTodo = async () => 'gasté';
    const meta = metaSinAnuncios(f.meta) as unknown as { gastarTodo: () => Promise<string> };

    await expect(meta.gastarTodo()).rejects.toThrow('en pausa');
  });
});

describe('la configuracion', () => {
  const base = { TELEGRAM_BOT_TOKEN: 't', DATABASE_URL: 'postgres://x' };

  it('el host va con URL y token juntos; sin los dos Homero anda como antes', () => {
    expect(leerConfig({ ...base }).anfitrion).toBeUndefined();
    expect(leerConfig({ ...base, SINCRO_HOST_URL: URL_HOST }).anfitrion).toBeUndefined();
    expect(leerConfig({ ...base, SINCRO_HOST_URL: URL_HOST, SINCRO_HOST_TOKEN: TOKEN }).anfitrion).toEqual({ url: URL_HOST, token: TOKEN });
  });

  it('los anuncios propios estan prendidos salvo que se apaguen', () => {
    expect(leerConfig({ ...base }).anunciosPropios).toBe(true);
    expect(leerConfig({ ...base, HOMERO_ANUNCIOS_PROPIOS: '' }).anunciosPropios).toBe(true);
    expect(leerConfig({ ...base, HOMERO_ANUNCIOS_PROPIOS: 'no' }).anunciosPropios).toBe(false);
    expect(leerConfig({ ...base, HOMERO_ANUNCIOS_PROPIOS: '0' }).anunciosPropios).toBe(false);
  });
});

describe('las rutas que usa el host', () => {
  const montar = async (anfitrion?: Parameters<typeof crearApi>[0]['anfitrion']) => {
    const h = armar();
    const api = crearApi({
      token: 'tok-de-la-api-de-homero-123456',
      store: h.store,
      acciones: {} as never,
      cambiarBotones: async () => undefined,
      ahora: h.deps.ahora,
      anfitrion,
    });
    return api;
  };
  const cabecera = { authorization: 'Bearer tok-de-la-api-de-homero-123456' };

  it('piden el token de la API', async () => {
    const api = await montar();
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aviso', payload: { texto: 'hola' } })).statusCode).toBe(401);
  });

  it('sin host configurado contestan 503', async () => {
    const api = await montar();
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aviso', headers: cabecera, payload: { texto: 'hola' } })).statusCode).toBe(503);
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aprobacion', headers: cabecera, payload: APROBACION })).statusCode).toBe(503);
  });

  it('el aviso llega a Telegram y la aprobacion a su tarjeta; un pedido roto es 400 y un rechazo del host, 409', async () => {
    const avisos: string[] = [];
    const aprobacion = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, n: 3 })
      .mockResolvedValueOnce({ ok: false, motivo: 'el video no es del host' });
    const api = await montar({ aviso: async (t) => void avisos.push(t), aprobacion });

    const aviso = await api.inject({ method: 'POST', url: '/anfitrion/aviso', headers: cabecera, payload: { texto: 'Listo para arrancar' } });
    expect(aviso.statusCode).toBe(200);
    expect(avisos).toEqual(['Listo para arrancar']);
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aviso', headers: cabecera, payload: { texto: '' } })).statusCode).toBe(400);

    const ok = await api.inject({ method: 'POST', url: '/anfitrion/aprobacion', headers: cabecera, payload: APROBACION });
    expect(ok.json()).toEqual({ ok: true, n: 3, repetido: false });
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aprobacion', headers: cabecera, payload: { revision: 'x' } })).statusCode).toBe(400);
    expect((await api.inject({ method: 'POST', url: '/anfitrion/aprobacion', headers: cabecera, payload: APROBACION })).statusCode).toBe(409);
  });
});
