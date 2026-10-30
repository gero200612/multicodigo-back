import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cifrar, descifrar } from './cifrado.js';
import type { Contexto } from './contexto.js';
import { Rechazo } from './envio.js';
import { ErrorDeMeta, type Sincronizacion } from './meta.js';
import { negocioDe } from './privado.js';
import type { Numero } from './store.js';
import { refrescarNumero } from './tareas.js';
import { textoDeError } from './tapar.js';

/**
 * La empresa conecta su propio numero desde su app (Embedded Signup de Meta,
 * capacidad `conectar`). La app manda el codigo que le dio Meta y los ids que
 * le llegaron por `postMessage`; el canje se hace aca porque el secreto de la
 * app de Meta lo tiene solo el bot.
 *
 * Los ids vienen del navegador, asi que no se les cree: el token que sale del
 * codigo tiene que ser de nuestra app y llegar a esa WABA, y el numero tiene
 * que ser de esa WABA. Un numero que ya es de otro negocio no se toca.
 */

const Id = z.string().regex(/^\d{5,30}$/);
const Conectar = z.object({
  codigo: z.string().min(10).max(2000),
  phone_number_id: Id,
  waba_id: Id,
  // El numero sigue en la app WhatsApp Business del celu: no se registra con PIN y se piden contactos e historial.
  coexistencia: z.boolean().default(false),
});

const ConectarPagina = z.object({
  codigo: z.string().min(10).max(2000),
  // Si el token llega a mas de una pagina, la app pregunta cual y la manda aca.
  pagina_id: Id.optional(),
});

const ConectarAnuncios = z.object({
  codigo: z.string().min(10).max(2000),
  // Si el token llega a mas de una cuenta publicitaria, la app pregunta cual y la manda aca.
  cuenta_id: z.string().regex(/^act_\d{5,30}$/).optional(),
});

/** Un error con `mensaje` en castellano (lo que la app le muestra a la persona) ademas del `code`. */
const falla = (status: number, code: string, mensaje: string) => new Rechazo(status, code, mensaje, { mensaje });

/** La pagina y el Instagram conectados: el nombre de la pagina y el usuario de Instagram. Nunca el token. */
function vistaDePagina(n: Numero | undefined) {
  return n ? { id: n.phoneNumberId, nombre: n.nombreVerificado } : null;
}
function vistaDeInstagram(n: Numero | undefined) {
  return n ? { id: n.phoneNumberId, usuario: n.nombreVerificado } : null;
}

export function vistaDeConexion(n: Numero) {
  return {
    phone_number_id: n.phoneNumberId,
    waba_id: n.wabaId,
    telefono: n.telefono,
    nombre: n.nombreVerificado,
    calidad: n.calidad,
    estado: n.estado,
    tope_meta: n.topeMeta,
    token_caido: n.tokenCaido,
    coexistencia: n.coexistencia,
  };
}

/** Lo que falla en Meta vuelve a la app como 502 con el detalle (ya tapado) y, si se dice, el paso en que falló. */
async function conMeta<T>(f: () => Promise<T>, paso?: string): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErrorDeMeta) throw new Rechazo(502, 'meta', paso ? `${paso}: ${e.message}` : e.message);
    throw e;
  }
}

const pinNuevo = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function registrarRutasDeConexion(app: FastifyInstance, ctx: Contexto): void {
  const { store } = ctx;

  app.get('/conexion', async (req) => {
    const negocio = negocioDe(req);
    const todos = await store.numerosDe(negocio.id);
    const numeros = todos.filter((n) => n.canal === 'whatsapp');
    return {
      numeros: numeros.map(vistaDeConexion),
      pagina: vistaDePagina(todos.find((n) => n.canal === 'messenger')),
      instagram: vistaDeInstagram(todos.find((n) => n.canal === 'instagram')),
    };
  });

  /**
   * Facebook Login for Business: la empresa elige su pagina (y el Instagram
   * vinculado) y la app manda el codigo. Mismo cuidado que `/conectar`: el
   * token tiene que ser de nuestra app y las paginas salen de Meta, no del
   * navegador. Una pagina o un Instagram que ya es de otro negocio no se toca.
   */
  app.post('/conectar-pagina', async (req) => {
    const negocio = negocioDe(req);
    const appMeta = ctx.appMeta;
    if (!appMeta) throw falla(503, 'sin_configurar', 'Falta configurar la app de Meta en el servidor.');
    const b = ConectarPagina.parse(req.body);

    const token = await conMeta(() => ctx.meta.canjearCodigo(appMeta, b.codigo));
    const revision = await conMeta(() => ctx.meta.revisarToken(appMeta, token));
    if (!revision.valido || revision.appId !== appMeta.id) throw falla(409, 'token_invalido', 'El permiso que dio Facebook no es de esta aplicación. Probá conectar de nuevo.');

    const paginas = await conMeta(() => ctx.meta.paginasDelToken(token));
    if (!paginas.length) throw falla(409, 'sin_paginas', 'Facebook no nos dio acceso a ninguna página. Volvé a conectar y elegí una página.');
    let pagina = b.pagina_id ? paginas.find((p) => p.id === b.pagina_id) : undefined;
    if (b.pagina_id && !pagina) throw falla(409, 'pagina_ajena', 'Esa página no está entre las que autorizaste.');
    if (!pagina) {
      if (paginas.length > 1) {
        throw new Rechazo(409, 'elegir_pagina', 'Autorizaste más de una página: elegí cuál conectar.', {
          mensaje: 'Autorizaste más de una página: elegí cuál conectar.',
          paginas: paginas.map((p) => ({ id: p.id, nombre: p.nombre })),
        });
      }
      pagina = paginas[0]!;
    }

    // Antes de tocar nada en Meta ni en la base: ninguna de las dos cuentas puede ser de otro negocio (ni de otro canal).
    const antesPagina = await store.numeroPorPhoneId(pagina.id);
    const antesInstagram = pagina.instagram ? await store.numeroPorPhoneId(pagina.instagram.id) : undefined;
    for (const [antes, canal] of [[antesPagina, 'messenger'], [antesInstagram, 'instagram']] as const) {
      if (antes && (antes.negocioId !== negocio.id || antes.canal !== canal)) {
        throw falla(409, 'de_otro_negocio', `${canal === 'messenger' ? 'Esa página' : 'Ese Instagram'} ya está conectado a otra empresa.`);
      }
    }

    await conMeta(() => ctx.meta.suscribirPagina(pagina.token, pagina.id));

    const tokenCifrado = cifrar(ctx.claveCifrado, pagina.token);
    const guardar = async (antes: Numero | undefined, canal: 'messenger' | 'instagram', id: string, nombre: string | null) => {
      if (antes) {
        // El token nuevo destraba los envios si estaban frenados.
        await store.cambiarNumero(antes.id, { tokenCifrado, wabaId: pagina.id, tokenCaido: false, nombreVerificado: nombre });
        return;
      }
      const nuevo = await store.crearNumero({ negocioId: negocio.id, phoneNumberId: id, wabaId: pagina.id, tokenCifrado, canal });
      // Otro pedido lo dio de alta en el medio.
      if (!nuevo) throw falla(409, 'ya_existe', 'Esa cuenta se acaba de conectar desde otro pedido. Probá de nuevo.');
      await store.cambiarNumero(nuevo.id, { nombreVerificado: nombre });
    };
    await guardar(antesPagina, 'messenger', pagina.id, pagina.nombre || null);
    if (pagina.instagram) await guardar(antesInstagram, 'instagram', pagina.instagram.id, pagina.instagram.usuario);

    await store.registrarCambios([
      {
        negocioId: negocio.id,
        campo: antesPagina ? 'reconexion' : 'pagina',
        antes: null,
        despues: `${pagina.id}${pagina.instagram ? ` + instagram ${pagina.instagram.id}` : ''}`,
        quien: `app:${negocio.app}`,
        fecha: ctx.ahora(),
      },
    ]);

    return {
      pagina: { id: pagina.id, nombre: pagina.nombre },
      // El token de la pagina, en claro, solo en esta respuesta a la app autenticada del negocio: nunca en logs ni en /conexion.
      token_pagina: pagina.token,
      instagram: pagina.instagram ? { id: pagina.instagram.id, usuario: pagina.instagram.usuario } : null,
    };
  });

  /**
   * Anuncios (configuracion «Anuncios» de Facebook Login for Business). El
   * token vuelve a la app del negocio, que publica y maneja anuncios con el;
   * aca solo queda quien conecto que cuenta, para auditoria.
   */
  app.post('/conectar-anuncios', async (req) => {
    const negocio = negocioDe(req);
    const appMeta = ctx.appMeta;
    if (!appMeta) throw falla(503, 'sin_configurar', 'Falta configurar la app de Meta en el servidor.');
    const b = ConectarAnuncios.parse(req.body);

    const token = await conMeta(() => ctx.meta.canjearCodigo(appMeta, b.codigo), 'canje del código');
    const revision = await conMeta(() => ctx.meta.revisarToken(appMeta, token), 'revisión del token');
    if (!revision.valido || revision.appId !== appMeta.id) throw falla(409, 'token_invalido', 'El permiso que dio Facebook no es de esta aplicación. Probá conectar de nuevo.');

    const cuentas = await conMeta(() => ctx.meta.cuentasPublicitarias(token, revision.negocios), 'cuentas publicitarias');
    if (!cuentas.length) throw falla(409, 'sin_cuentas', 'Facebook no nos dio acceso a ninguna cuenta publicitaria. Volvé a conectar y elegí una cuenta.');
    const vista = (c: { id: string; nombre: string; moneda: string | null }) => ({ id: c.id, nombre: c.nombre, moneda: c.moneda });
    let cuenta = b.cuenta_id ? cuentas.find((c) => c.id === b.cuenta_id) : undefined;
    if (b.cuenta_id && !cuenta) throw falla(409, 'cuenta_ajena', 'Esa cuenta publicitaria no está entre las que autorizaste.');
    if (!cuenta) {
      if (cuentas.length > 1) {
        throw new Rechazo(409, 'elegir_cuenta', 'Autorizaste más de una cuenta publicitaria: elegí cuál conectar.', {
          mensaje: 'Autorizaste más de una cuenta publicitaria: elegí cuál conectar.',
          cuentas: cuentas.map(vista),
        });
      }
      cuenta = cuentas[0]!;
    }
    const cuentaElegida = cuenta;
    // El píxel es opcional: si la cuenta no tiene o no lo dieron, se conecta igual sin píxel.
    const pixeles = await ctx.meta.pixeles(token, cuentaElegida.id).catch((e) => {
      if (!(e instanceof ErrorDeMeta)) throw e;
      ctx.log(`/conectar-anuncios: sin píxeles de ${cuentaElegida.id} (${e.message})`);
      return [];
    });

    await store.registrarCambios([
      { negocioId: negocio.id, campo: 'anuncios', antes: null, despues: cuentaElegida.id, quien: `app:${negocio.app}`, fecha: ctx.ahora() },
    ]);

    return { token, cuenta: vista(cuentaElegida), pixel: pixeles[0] ? { id: pixeles[0].id, nombre: pixeles[0].nombre } : null };
  });

  app.post('/conectar', async (req) => {
    const negocio = negocioDe(req);
    const appMeta = ctx.appMeta;
    if (!appMeta) throw new Rechazo(503, 'sin_configurar', 'falta META_APP_ID en sincro-wa');
    const b = Conectar.parse(req.body);

    const antes = await store.numeroPorPhoneId(b.phone_number_id);
    if (antes && antes.negocioId !== negocio.id) throw new Rechazo(409, 'de_otro_negocio');

    const token = await conMeta(() => ctx.meta.canjearCodigo(appMeta, b.codigo));
    const revision = await conMeta(() => ctx.meta.revisarToken(appMeta, token));
    if (!revision.valido || revision.appId !== appMeta.id) throw new Rechazo(409, 'token_invalido');
    if (!revision.wabas.includes(b.waba_id)) throw new Rechazo(409, 'waba_ajena', 'el token no llega a esa cuenta de WhatsApp Business');
    if (!(await conMeta(() => ctx.meta.numerosDeLaWaba(token, b.waba_id))).includes(b.phone_number_id)) {
      throw new Rechazo(409, 'numero_ajeno', 'ese número no es de esa cuenta de WhatsApp Business');
    }

    await conMeta(() => ctx.meta.suscribirApp(token, b.waba_id));
    let pinCifrado = antes?.pinCifrado ?? null;
    if (!b.coexistencia) {
      // Al reconectar se usa el mismo PIN: uno distinto lo rechaza Meta si el numero ya tenia dos pasos.
      const pin = pinCifrado ? descifrar(ctx.claveCifrado, pinCifrado) : pinNuevo();
      await conMeta(() => ctx.meta.registrarNumero(token, b.phone_number_id, pin));
      pinCifrado = cifrar(ctx.claveCifrado, pin);
    }

    const tokenCifrado = cifrar(ctx.claveCifrado, token);
    let numero: Numero | undefined;
    if (antes) {
      await store.cambiarNumero(antes.id, { tokenCifrado, wabaId: b.waba_id, coexistencia: b.coexistencia, pinCifrado });
      numero = await store.numero(antes.id);
    } else {
      numero = await store.crearNumero({
        negocioId: negocio.id,
        phoneNumberId: b.phone_number_id,
        wabaId: b.waba_id,
        tokenCifrado,
        coexistencia: b.coexistencia,
        pinCifrado,
      });
      // Otro pedido lo dio de alta en el medio.
      if (!numero) throw new Rechazo(409, 'ya_existe');
    }
    await store.registrarCambios([
      {
        negocioId: negocio.id,
        campo: antes ? 'reconexion' : 'numero',
        antes: null,
        despues: `${b.phone_number_id}${b.coexistencia ? ' (coexistencia)' : ''}`,
        quien: `app:${negocio.app}`,
        fecha: ctx.ahora(),
      },
    ]);

    // Calidad, tope y numero visible ya. Con el token nuevo, si estaba caido vuelve a andar (y Puente se entera).
    try {
      await refrescarNumero(ctx, numero!);
    } catch (e) {
      ctx.log(`datos del número ${b.phone_number_id}: ${textoDeError(e)}`);
    }
    if (b.coexistencia) {
      // Meta las acepta una vez y dentro de las 24 h: si fallan, el numero queda conectado igual.
      for (const tipo of ['smb_app_state_sync', 'history'] satisfies Sincronizacion[]) {
        await ctx.meta.sincronizar(token, b.phone_number_id, tipo).catch((e) => ctx.log(`${tipo} de ${b.phone_number_id}: ${textoDeError(e)}`));
      }
    }
    return { numero: vistaDeConexion((await store.numero(numero!.id))!) };
  });
}
