/**
 * Los endpoints internos de Drive: lo que el gateway le pide al bridge.
 *
 * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.
 *
 * Estan en su propio archivo y no adentro de `webhook.ts` porque son siete y
 * comparten casi todo el cuerpo. La parte que comparten —resolver el usuario
 * del turno, sacar un token, traducir la falla a algo que se pueda decir— esta
 * en `conDrive` una sola vez, que es lo que impide que la septima herramienta
 * se olvide de borrar la fila cuando el token esta revocado.
 *
 * ## El usuario NO viaja en el pedido
 *
 * Igual que en `guardar_documento`: el cuerpo trae el `jobId` y de ahi sale de
 * quien es el turno. Si el usuario viajara, quien llame elegiria sobre que
 * cuenta de Google trabajar — y quien llama es, en ultima instancia, un proceso
 * que ejecuta lo que escribe un modelo.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTokenValid } from '@multicodigo/shared';
import type { Store } from './store.js';
import {
  accessToken,
  borrar,
  buscar,
  canjearCodigo,
  crear,
  editarPlanilla,
  escribir,
  leer,
  TokenRevocado,
  ErrorDeDrive,
  type DriveDeps,
} from './drive.js';

/** Cuanto vale un link de "pedir acceso". */
export const MINUTOS_DE_PEDIDO = 30;

/**
 * Cuanto se recuerda un archivo recien autorizado: 15 minutos.
 *
 * Es el puente sobre la ventana de propagacion del indice de Drive, no un
 * catalogo. En el spike la propagacion tardo menos de dos minutos; 15 da margen
 * de sobra para el caso lento sin que esto se convierta en una segunda fuente
 * de verdad sobre que archivos existen. Pasada la ventana, la busqueda en vivo
 * lo encuentra sola.
 */
export const MINUTOS_DE_GRACIA = 15;

export interface DriveApiDeps {
  store: Pick<
    Store,
    | 'contextoDeJob'
    | 'googleCuenta'
    | 'guardarGoogleCuenta'
    | 'borrarGoogleCuenta'
    | 'crearPedidoDeDrive'
    | 'canjearPedidoDeDrive'
    | 'archivoAutorizadoReciente'
  >;
  drive: DriveDeps;
  /**
   * De donde cuelga el link de autorizacion: la URL publica del panel.
   *
   * Hace falta aca porque el link lo arma el bridge —es el que crea el codigo—
   * y el bridge no sabe por que dominio lo ven las personas.
   */
  panelUrl: string;
  apiToken: string;
}

/**
 * El status HTTP de cada falla de Drive.
 *
 * 404 se queda en 400 a proposito: un 404 en esta ruta significaria "este
 * endpoint no existe", y lo que pasa es que el ARCHIVO no esta. El gateway
 * propaga el status tal cual, asi que un 404 le haria creer al agente que la
 * herramienta no esta habilitada.
 */
const STATUS: Record<ErrorDeDrive['code'], number> = {
  no_encontrado: 400,
  sin_permiso: 403,
  esperar: 429,
  google_fallo: 502,
};

interface Contexto {
  usuarioId: string;
  token: string;
}

/**
 * Todo lo que las siete herramientas hacen antes de tocar Google.
 *
 * Devuelve el token listo, o contesta el error ya escrito para una persona.
 * Cada error nombra LA ACCION QUE LO ARREGLA: "conecta tu cuenta en
 * Configuracion" es accionable, "no autorizado" no.
 */
async function conDrive<T>(
  jobId: string,
  deps: DriveApiDeps,
  hacer: (ctx: Contexto) => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; status: number; code: string; message: string }> {
  const contexto = await deps.store.contextoDeJob(jobId);
  if (!contexto?.usuarioId) {
    return {
      ok: false,
      status: 400,
      code: 'sin_contexto',
      message: 'ese turno no tiene un usuario, asi que no se de que cuenta de Google hablar',
    };
  }

  const cuenta = await deps.store.googleCuenta(contexto.usuarioId);
  if (!cuenta) {
    return {
      ok: false,
      status: 400,
      code: 'sin_cuenta',
      message:
        'no tenes una cuenta de Google conectada. Conectala en Configuracion y volve a pedirmelo.',
    };
  }

  let token: string;
  try {
    token = await accessToken(cuenta.refreshToken, deps.drive);
  } catch (e) {
    if (e instanceof TokenRevocado) {
      // Se borra la fila, y esa es la parte importante: sin esto cada turno
      // siguiente reintenta un token muerto, falla igual, y la persona nunca se
      // entera de que lo que tiene que hacer es volver a conectar.
      await deps.store.borrarGoogleCuenta(contexto.usuarioId);
      return {
        ok: false,
        status: 400,
        code: 'cuenta_revocada',
        message:
          'tu cuenta de Google ya no autoriza a este sistema. Volve a conectarla en Configuracion.',
      };
    }
    const err = e as ErrorDeDrive;
    return {
      ok: false,
      status: STATUS[err.code] ?? 502,
      code: err.code ?? 'google_fallo',
      message: err.message,
    };
  }

  try {
    return { ok: true, valor: await hacer({ usuarioId: contexto.usuarioId, token }) };
  } catch (e) {
    if (e instanceof ErrorDeDrive) {
      return { ok: false, status: STATUS[e.code], code: e.code, message: e.message };
    }
    return {
      ok: false,
      status: 502,
      code: 'google_fallo',
      message: e instanceof Error ? e.message : 'no se pudo hablar con Drive',
    };
  }
}

const ConJob = { jobId: z.string().uuid() };
const PorNombre = z.object({ ...ConJob, nombre: z.string().min(1) });
const PorId = z.object({ ...ConJob, id: z.string().min(1) });
const Escribir = z.object({ ...ConJob, id: z.string().min(1), contenido: z.string() });
const Crear = z.object({ ...ConJob, nombre: z.string().min(1), contenido: z.string() });
const Planilla = z.object({
  ...ConJob,
  id: z.string().min(1),
  rango: z.string().min(1),
  // Una matriz de strings y no `any`: lo que llega arma el cuerpo que va a
  // Google, y un objeto anidado ahi adentro es una forma de pedirle a la API de
  // Sheets algo que nadie reviso.
  valores: z.array(z.array(z.string())).min(1),
});

/**
 * Cuanto texto vuelve de una lectura: 200 KB.
 *
 * Lo que sale de aca entra en el contexto del modelo. Una planilla de veinte mil
 * filas exportada a CSV lo llena entero y empuja afuera la conversacion — el
 * sintoma no es un error, es un agente que de golpe se olvida de lo que estaban
 * hablando. Se corta y se DICE que se corto, para que no conteste sobre la
 * mitad de un archivo creyendo que lo vio todo.
 */
export const TOPE_DE_LECTURA = 200 * 1024;

export function registrarDrive(app: FastifyInstance, deps: DriveApiDeps): void {
  /** El bearer del par gateway↔bridge, el mismo que el resto de `/interno`. */
  const autorizado = (auth: string | undefined) => isTokenValid(auth, deps.apiToken);

  /**
   * Un endpoint de Drive.
   *
   * `hacer` devuelve la PROSA que va a leer el modelo, no un objeto: lo que el
   * agente recibe de vuelta es texto, y armarlo al lado de la llamada es lo que
   * mantiene juntos "que se hizo" y "como se cuenta".
   */
  function endpoint<S extends z.ZodType>(
    ruta: string,
    esquema: S,
    hacer: (datos: z.infer<S>, ctx: Contexto) => Promise<string>,
  ): void {
    app.post(`/interno/drive/${ruta}`, async (request, reply) => {
      if (!autorizado(request.headers.authorization)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = esquema.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos del pedido' });
      }
      const r = await conDrive(
        (cuerpo.data as { jobId: string }).jobId,
        deps,
        (ctx) => hacer(cuerpo.data, ctx),
      );
      if (!r.ok) return reply.code(r.status).send({ code: r.code, message: r.message });
      return reply.code(200).send({ output: r.valor });
    });
  }

  endpoint('buscar', PorNombre, async ({ nombre }, ctx) => {
    const archivos = await buscar(ctx.token, nombre, deps.drive);
    if (archivos.length === 0) {
      // Antes de decir que no esta: ¿lo autorizo recien?
      //
      // El indice de Drive es eventualmente consistente —medido en el spike:
      // 0 resultados, y dos minutos despues 1— y el turno que sigue a un
      // "pedir acceso" llega mucho antes que eso. Sin este puente, el agente
      // contesta "no lo encuentro" justo despues de que la persona hizo lo que
      // le pidieron, que es la peor version posible de esta feature.
      const recien = await deps.store.archivoAutorizadoReciente(
        ctx.usuarioId,
        nombre,
        MINUTOS_DE_GRACIA,
      );
      if (recien) {
        return `${recien.nombre} — id ${recien.id} (recien autorizado)`;
      }
    }
    if (archivos.length === 0) {
      // No se corta con "no lo encuentro": se nombra la accion que lo arregla.
      // Que un limite tecnico —`drive.file` solo ve lo autorizado— llegue a la
      // persona como una tarea suya es justo lo que este sistema viene
      // evitando.
      return (
        `no encontre ningun archivo con "${nombre}" entre los que puedo ver. ` +
        'Si existe pero nunca lo abriste conmigo, usa pedir_acceso_a_drive para que ' +
        'la persona me lo autorice.'
      );
    }
    // Los ids van en la respuesta porque son lo que toman las demas
    // herramientas. El modelo no puede inventar uno: si no salio de aca, Google
    // contesta 404.
    return archivos.map((a) => `${a.nombre} — id ${a.id} (${a.tipo})`).join('\n');
  });

  endpoint('leer', PorId, async ({ id }, ctx) => {
    const texto = await leer(ctx.token, id, deps.drive);
    if (texto.length <= TOPE_DE_LECTURA) return texto;
    return (
      `${texto.slice(0, TOPE_DE_LECTURA)}\n\n` +
      `[corte: el archivo sigue. Se leyeron los primeros ${Math.floor(TOPE_DE_LECTURA / 1024)} KB de ` +
      `${Math.ceil(texto.length / 1024)} KB. Deciselo a la persona si la respuesta depende del resto.]`
    );
  });

  endpoint('escribir', Escribir, async ({ id, contenido }, ctx) => {
    const a = await escribir(ctx.token, id, contenido, deps.drive);
    return `escribi ${a.nombre}`;
  });

  endpoint('crear', Crear, async ({ nombre, contenido }, ctx) => {
    const a = await crear(ctx.token, nombre, contenido, deps.drive);
    // El id vuelve porque el archivo recien creado NO aparece todavia en una
    // busqueda —el indice de Drive tarda— y sin el id el propio agente no
    // podria editar lo que acaba de escribir.
    return `cree ${a.nombre} — id ${a.id}`;
  });

  endpoint('planilla', Planilla, async ({ id, rango, valores }, ctx) => {
    const celdas = await editarPlanilla(ctx.token, id, rango, valores, deps.drive);
    return `escribi ${celdas} celda(s) en ${rango}`;
  });

  endpoint('borrar', PorId, async ({ id }, ctx) => {
    const a = await borrar(ctx.token, id, deps.drive);
    // Se dice "papelera" y no "borre": la diferencia le importa a quien lo lee,
    // porque decide si tiene que hacer algo para recuperarlo.
    return `mande ${a.nombre} a la papelera de Drive. Se puede recuperar desde ahi.`;
  });

  /**
   * El link para autorizar UN archivo.
   *
   * El link se devuelve como texto y no se manda por Telegram desde aca, a
   * proposito: lo que devuelve la herramienta es lo que el modelo le dice a la
   * persona, y eso llega igual al chat de Telegram Y al panel. Mandarlo por el
   * bot funcionaria solo en uno de los dos frentes.
   */
  /**
   * Conecta una cuenta de Google: el segundo paso del flujo con codigo.
   *
   * El canje vive ACA y no en el panel, aunque el panel sea el que recibe el
   * redirect de Google. La razon es la del spec: el refresh token es la
   * credencial permanente de una cuenta personal, y el panel es el unico
   * proceso expuesto a internet. Ademas el panel escribe siempre con el JWT del
   * usuario, y la columna `refresh_token` esta fuera de su GRANT justamente
   * para que no la pueda tocar.
   *
   * El `usuarioId` lo manda el panel desde el JWT que YA verifico. Si esto lo
   * pudiera llamar el navegador, cualquiera conectaria una cuenta de Google a
   * la cuenta de otro — que es el mismo razonamiento de `/vinculos`.
   */
  app.post('/interno/google/conectar', async (request, reply) => {
    if (!autorizado(request.headers.authorization)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    const cuerpo = z
      .object({
        usuarioId: z.string().uuid(),
        code: z.string().min(1),
        redirectUri: z.string().url(),
      })
      .safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos' });
    }

    try {
      const { refreshToken, email } = await canjearCodigo(
        cuerpo.data.code,
        cuerpo.data.redirectUri,
        deps.drive,
      );
      await deps.store.guardarGoogleCuenta(cuerpo.data.usuarioId, email, refreshToken);
      // El token NO vuelve. Es la unica regla dura de este endpoint: lo que
      // sale es con que cuenta quedo conectado, y nada mas.
      return reply.code(200).send({ email });
    } catch (e) {
      const err = e as ErrorDeDrive;
      return reply
        .code(STATUS[err.code] ?? 502)
        .send({ code: err.code ?? 'google_fallo', message: err.message });
    }
  });

  /**
   * Con que cuenta esta conectado alguien, o ninguna.
   *
   * Existe porque Configuracion tiene que poder mostrar el estado, y el panel
   * NO puede leer esa fila entera: el GRANT le da `usuario_id`, `email` y
   * `creado_en` y le niega el token. Podria leerla por PostgREST, pero pasar
   * por aca deja un solo camino hacia esta tabla.
   */
  app.get<{ Querystring: { usuarioId?: string } }>(
    '/interno/google/estado',
    async (request, reply) => {
      if (!autorizado(request.headers.authorization)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const usuarioId = z.string().uuid().safeParse(request.query.usuarioId);
      if (!usuarioId.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId' });
      }
      const cuenta = await deps.store.googleCuenta(usuarioId.data);
      return reply.code(200).send({ conectada: Boolean(cuenta), email: cuenta?.email ?? null });
    },
  );

  /**
   * Desconecta la cuenta.
   *
   * Borra la fila y con ella el refresh token. NO revoca el permiso del lado de
   * Google: eso se hace desde la cuenta de Google, y decir que lo hacemos
   * nosotros cuando no es asi seria peor que no ofrecerlo.
   */
  app.delete<{ Querystring: { usuarioId?: string } }>(
    '/interno/google/conectar',
    async (request, reply) => {
      if (!autorizado(request.headers.authorization)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const usuarioId = z.string().uuid().safeParse(request.query.usuarioId);
      if (!usuarioId.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta usuarioId' });
      }
      return reply
        .code(200)
        .send({ desconectada: await deps.store.borrarGoogleCuenta(usuarioId.data) });
    },
  );

  /**
   * Canjea el link: la persona ya eligio el archivo en el Picker.
   *
   * No pasa por `endpoint` porque no tiene `jobId` ni toca Google: para cuando
   * esto llega, el permiso YA esta dado —lo dio el Picker, sobre el `client_id`
   * de la app— y lo unico que falta es quemar el codigo para que el link no
   * sirva una segunda vez.
   *
   * Que el permiso que da el navegador le sirva al servidor es el supuesto que
   * sostiene toda la feature, y esta verificado: en el spike, un archivo
   * elegido en el navegador lo leyo despues un token sacado del refresh token
   * del servidor. El permiso de `drive.file` es de la APP, no del token.
   *
   * Devuelve el nombre que se habia pedido para que el panel pueda decir
   * "autorizaste X" y no un "listo" pelado.
   */
  app.post('/interno/drive/canjear', async (request, reply) => {
    if (!autorizado(request.headers.authorization)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
    }
    const cuerpo = z
      .object({ codigo: z.string().min(1), id: z.string().min(1) })
      .safeParse(request.body);
    if (!cuerpo.success) {
      return reply.code(400).send({ code: 'cuerpo_invalido', message: 'faltan datos del pedido' });
    }

    const r = await deps.store.canjearPedidoDeDrive(cuerpo.data.codigo, cuerpo.data.id);
    if (r.estado !== 'ok') {
      // Los tres motivos se explican distinto, asi que se propaga cual fue:
      // "ese link ya lo usaste" y "ese link vencio" llevan a acciones
      // distintas, y "no existe" a ninguna.
      const message = {
        usado: 'ese link ya se uso. Pedile al agente uno nuevo.',
        vencido: 'ese link vencio. Pedile al agente uno nuevo.',
        desconocido: 'ese link no existe.',
      }[r.estado];
      return reply.code(400).send({ code: `link_${r.estado}`, message });
    }

    return reply.code(200).send({ nombre: r.nombre, id: cuerpo.data.id });
  });

  endpoint('pedir-acceso', PorNombre, async ({ nombre }, ctx) => {
    const codigo = await deps.store.crearPedidoDeDrive(ctx.usuarioId, nombre, MINUTOS_DE_PEDIDO);
    // El nombre viaja en el link ADEMAS del codigo, y no es un secreto: es el
    // nombre de un archivo de la propia persona, que ademas ya lo va a ver en
    // la pantalla. Va porque es lo que el Picker usa como `setQuery`, o sea lo
    // que hace que el archivo este a un toque en vez de perdido entre todo su
    // Drive. Sacarlo del codigo pediria un endpoint para espiar el pedido sin
    // quemarlo, que es una puerta mas sobre la misma tabla.
    const link =
      `${deps.panelUrl.replace(/\/$/, '')}/drive/autorizar` +
      `?codigo=${encodeURIComponent(codigo)}&nombre=${encodeURIComponent(nombre)}`;
    return (
      `pedile a la persona que abra este link para autorizarme "${nombre}": ${link}\n` +
      `Vence en ${MINUTOS_DE_PEDIDO} minutos y sirve para un solo archivo. ` +
      'Cuando lo elija, decime y sigo.'
    );
  });
}
