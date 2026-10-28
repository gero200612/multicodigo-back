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

/** Lo que falla en Meta vuelve a la app como 502 con el detalle (ya tapado). */
async function conMeta<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErrorDeMeta) throw new Rechazo(502, 'meta', e.message);
    throw e;
  }
}

const pinNuevo = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function registrarRutasDeConexion(app: FastifyInstance, ctx: Contexto): void {
  const { store } = ctx;

  app.get('/conexion', async (req) => {
    const negocio = negocioDe(req);
    const numeros = (await store.numerosDe(negocio.id)).filter((n) => n.canal === 'whatsapp');
    return { numeros: numeros.map(vistaDeConexion) };
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
