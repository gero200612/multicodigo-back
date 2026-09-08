import Fastify, { type FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { AgentId, ApprovalDecision, RepoDelPedido, isTokenValid } from '@multicodigo/shared';
import { decidir, type DecidirDeps } from './decisiones.js';
import { ejecutarTurnoConRelevo, type PipelineDeps } from './pipeline.js';
import { z } from 'zod';
import type { Store } from './store.js';
import { FORMATOS_GENERABLES } from './documentos.js';
import { registrarDrive, type DriveApiDeps } from './drive-api.js';
import { registrarSupabase, type SupabaseApiDeps } from './supabase-api.js';

/** Tope duro. Sin esto, un `?limit=` de la URL deja pedir la tabla entera. */
const MAX_JOBS = 50;
const JOBS_POR_DEFECTO = 20;

/**
 * La API de lectura que consume el panel.
 *
 * Es opcional: sin esto el bridge sigue siendo solo el webhook de Telegram, que
 * es como arranco. Los tests que no la ejercitan no la pasan.
 */
export interface ApiDeps {
  store: Pick<
    Store,
    | 'recentJobs'
    | 'canjearCodigo'
    | 'usuarioDeChat'
    | 'deleteSessions'
    | 'desvincularChat'
    | 'consumoPorAgente'
    | 'contextoDeJob'
    | 'googleCuenta'
    | 'guardarGoogleCuenta'
    | 'borrarGoogleCuenta'
    | 'crearPedidoDeDrive'
    | 'canjearPedidoDeDrive'
    | 'archivoAutorizadoReciente'
    | 'corridaDeJob'
    | 'marcarHuecos'
    | 'anotarPendiente'
    | 'encolar'
    | 'getActiveAgent'
  >;
  /**
   * Como guardar un documento que ESCRIBIO el agente.
   *
   * Se inyecta —y no se llama a `guardarDocumentoGenerado` directo— por lo
   * mismo que el resto de este archivo: asi el endpoint se testea sin un disco,
   * sin una base y sin el conversor.
   *
   * Opcional: sin esto el endpoint contesta 503 y el agente lo dice. Es mejor
   * que un 404, que le haria creer que la herramienta no existe.
   */
  /** El token de administracion de Supabase y su org. Ver `supabase-api.ts`. */
  supabase?: Omit<SupabaseApiDeps, 'apiToken'>;
  guardarGenerado?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    nombre: string;
    contenido: string;
    formato: string;
  }) => Promise<{ nombre: string; tipo: string; bytes: number }>;
  /**
   * Como decidir una aprobacion desde afuera de Telegram.
   *
   * Es el MISMO camino que usan los botones del chat: el panel no escribe la
   * tabla por su cuenta, porque decidir tambien significa avisarle al gateway y
   * editar el mensaje del chat.
   */
  decisiones?: DecidirDeps;
  /**
   * Con que ejecutar un turno pedido desde el panel.
   *
   * Es el MISMO camino que el de Telegram: mismo job, mismo poller de
   * aprobaciones, misma sesion. Es lo que hace que los dos frentes compartan
   * hilo en vez de tener cada uno el suyo.
   */
  pipeline?: PipelineDeps;
  /**
   * Con que hablarle a Drive.
   *
   * Opcional: sin `GOOGLE_CLIENT_SECRET` no hay refresh token que canjear, asi
   * que las herramientas de Drive no se registran y el agente recibe el error
   * de "esa herramienta no esta habilitada" — que es la verdad. Registrarlas
   * igual y fallar adentro le haria creer al modelo que la cuenta esta mal
   * conectada cuando lo que falta es una variable del servidor.
   */
  drive?: Omit<DriveApiDeps, 'store' | 'apiToken'>;
  /**
   * Credencial propia, distinta del secret del webhook.
   *
   * Son dos cosas con dueños distintos: el secret lo tiene Telegram, este token
   * lo tiene el panel. Compartirlos significaria que quien puede leer tus
   * conversaciones puede tambien inyectar updates de Telegram.
   */
  apiToken: string;
}

export function buildWebhookServer(
  bot: Pick<Bot, 'handleUpdate'>,
  webhookSecret: string,
  api?: ApiDeps,
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/telegram/webhook', async (request, reply) => {
    if (request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // Fire and forget: Telegram reintenta si no contestamos rapido, y el turno
    // de Claude tarda minutos. El error se loguea, no se propaga al request.
    void bot.handleUpdate(request.body as never).catch((err: unknown) => {
      app.log.error({ err }, 'fallo el procesamiento del update');
    });
    return reply.code(200).send({ ok: true });
  });

  if (api) {
    /**
     * Cuanto gasto cada agente en las ultimas 5 horas.
     *
     * No dice cuanto QUEDA: Anthropic no publica la cuota, asi que no hay
     * total contra el cual dividir y un porcentaje seria inventado. Lo que se
     * puede medir es lo gastado, sobre la misma ventana que usa su limite.
     */
    app.get('/consumo', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const consumo = await api.store.consumoPorAgente();
      return reply.code(200).send({ consumo: Object.fromEntries(consumo) });
    });

    app.get<{ Querystring: { limit?: string } }>('/jobs', async (request, reply) => {
      // Este endpoint expone los prompts, o sea todo lo que le hablaste a tus
      // agentes. Sin bearer seria una filtracion de la conversacion entera.
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      // Un limite invalido cae al default en vez de romper: es un parametro de
      // una pagina que se refresca sola, no vale tirarle un 400 al usuario.
      const pedido = Number(request.query.limit);
      const limite = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, MAX_JOBS) : JOBS_POR_DEFECTO;

      return reply.code(200).send({ jobs: await api.store.recentJobs(limite) });
    });

    const CuerpoVinculo = z.object({
      codigo: z.string().min(1).max(32),
      usuarioId: z.string().uuid(),
    });

    const CuerpoDesvinculo = z.object({
      // `chat_id` es un BIGINT y los ids de Telegram entran de sobra en un
      // double, asi que number alcanza. `int()` corta un float mandado a mano.
      chatId: z.coerce.number().int(),
      usuarioId: z.string().uuid(),
    });

    /**
     * Canjea un codigo de vinculacion a nombre de un usuario del panel.
     *
     * Lo llama el panel, no el navegador: el `usuarioId` viene del JWT que el
     * panel ya verifico. Si esto lo pudiera llamar el navegador, cualquiera
     * vincularia un chat a la cuenta de otro.
     */
    app.post('/vinculos', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      const cuerpo = CuerpoVinculo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta codigo o usuarioId' });
      }

      const r = await api.store.canjearCodigo(cuerpo.data.codigo, cuerpo.data.usuarioId);
      if (r === 'ok') return reply.code(200).send({ estado: 'ok' });

      // Los tres se explican distinto en el panel: "pedi uno nuevo" no es lo
      // mismo que "ese ya lo usaste".
      const codigos = {
        vencido: 'codigo_vencido',
        usado: 'codigo_usado',
        desconocido: 'codigo_desconocido',
      } as const;
      return reply.code(400).send({ code: codigos[r], message: 'el codigo no sirve' });
    });

    /**
     * Desata un chat de una cuenta.
     *
     * POST y no DELETE porque el cuerpo lleva el `usuarioId`, y un DELETE con
     * cuerpo es algo que algunos proxies descartan. Quien decide la forma REST
     * es el panel, que expone esto como DELETE hacia el front.
     *
     * El `usuarioId` es obligatorio y viaja al WHERE del borrado: sin eso,
     * cualquiera que llegue a este endpoint podria desatar el chat de otro.
     * Aca no hay JWT que verificar —esta detras del bearer del panel— asi que
     * la unica defensa es que el panel mande el usuario del JWT y este borrado
     * lo exija.
     */
    app.post('/vinculos/borrar', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }

      const cuerpo = CuerpoDesvinculo.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'falta chatId o usuarioId' });
      }

      const fue = await api.store.desvincularChat(cuerpo.data.chatId, cuerpo.data.usuarioId);
      return reply.code(200).send({ desvinculado: fue });
    });

    if (api.decisiones) {
      const decisiones = api.decisiones;

      const CuerpoDecision = z.object({
        // Del contrato compartido: el conjunto de decisiones no lo define este
        // archivo.
        decision: ApprovalDecision,
        usuarioId: z.string().uuid(),
      });

      app.post<{ Params: { id: string } }>('/aprobaciones/:id/decision', async (request, reply) => {
        if (!isTokenValid(request.headers.authorization, api.apiToken)) {
          return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        }

        const cuerpo = CuerpoDecision.safeParse(request.body);
        if (!cuerpo.success) {
          return reply
            .code(400)
            .send({ code: 'cuerpo_invalido', message: 'decision o usuario invalidos' });
        }

        const r = await decidir(decisiones, {
          approvalId: request.params.id,
          decision: cuerpo.data.decision,
          usuarioId: cuerpo.data.usuarioId,
          desde: 'panel',
        });

        if (r === 'ok') return reply.send({ estado: 'ok' });
        if (r === 'ya_decidida') {
          // 409 y no 400: el pedido estaba bien, el estado del mundo cambio.
          return reply
            .code(409)
            .send({ code: 'ya_decidida', message: 'esa aprobacion ya se decidio' });
        }
        return reply.code(404).send({ code: 'desconocida', message: 'no existe esa aprobacion' });
      });
    }

    if (api.pipeline) {
      const pipeline = api.pipeline;

      const CuerpoTurno = z.object({
        proyectoId: z.string().uuid(),
        proyecto: z.string().regex(/^[a-zA-Z0-9._-]+$/),
        // Del contrato compartido: la forma del slot no la define este archivo.
        agente: AgentId,
        usuarioId: z.string().uuid(),
        prompt: z.string().min(1).max(20_000),
        // Del contrato compartido, igual que AgentId: el `nombre` termina siendo
        // un directorio en el disco de la VM y el `github_repo`, parte de una
        // URL de git. El gateway lo valida igual —es el que toca el disco— pero
        // el bridge no tiene por que reenviarle algo que ya sabe que esta mal.
        repos: z.array(RepoDelPedido).max(20).optional(),
        // El token de instalacion que firmo el panel. Se valida la forma —entra
        // en un header del lado del gateway— pero no se mira el contenido: el
        // bridge es un caño para esto.
        githubToken: z.string().regex(/^[A-Za-z0-9._~+/=-]+$/).max(512).optional(),
        // Los documentos del proyecto, con URLs firmadas. El bridge no los mira:
        // los reenvia al gateway, que los baja al worktree.
        //
        // La `url` se valida como URL a secas y no contra un host: es una URL
        // La RUTA en el disco del servidor, no una URL: el panel deja el
        // archivo en un directorio que el gateway tambien monta. El bridge solo
        // la reenvia; quien la lee es el gateway, que sabe cual es la raiz.
        documentos: z
          .array(
            z.object({
              nombre: z.string().regex(/^[A-Za-z0-9._-]+$/).max(200),
              ruta: z.string().min(1).max(500),
              ruta_texto: z.string().min(1).max(500).nullable().optional(),
              // La marca de instructivo. Opcional: un panel sin actualizar no
              // la manda, y ahi el proyecto simplemente no tiene instructivo.
              // El bridge la usa para separarlo (ver `separarInstructivo`); el
              // gateway recibe el instructivo en su propio campo.
              es_instruccion: z.boolean().optional(),
            }),
          )
          .max(50)
          .optional(),
      });

      /**
       * Un turno pedido desde el panel.
       *
       * La membresia YA la valido el panel: este endpoint esta detras del
       * bearer y no lo alcanza el navegador. Chequearla tambien aca obligaria
       * al bridge a conocer proyectos y usuarios, que es justo lo que el spec
       * decidio evitar.
       */
      app.post('/turnos', async (request, reply) => {
        if (!isTokenValid(request.headers.authorization, api.apiToken)) {
          return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
        }

        const cuerpo = CuerpoTurno.safeParse(request.body);
        if (!cuerpo.success) {
          return reply
            .code(400)
            .send({ code: 'cuerpo_invalido', message: 'faltan datos del turno' });
        }

        try {
          const r = await ejecutarTurnoConRelevo(pipeline, { ...cuerpo.data, origen: 'panel' });
          return reply.send({ jobId: r.jobId, texto: r.texto });
        } catch (e) {
          // 502 y no 500: lo que fallo es el agente del otro lado, y el `code`
          // es el suyo. El panel lo traduce a algo que se pueda leer.
          const code = e instanceof Error ? e.message : 'internal';
          return reply.code(502).send({ code, message: 'el turno fallo' });
        }
      });
    }

    /**
     * Un documento que escribio el agente.
     *
     * Vive en el bridge y no en el panel por una razon dura: el panel escribe
     * SIEMPRE con el JWT del usuario, para que RLS sea la unica autoridad, y
     * aca no hay ningun usuario conectado. Fabricarle un JWT tampoco se puede
     * —se verifican contra el JWKS— y darle al panel la service_role es
     * justo lo que el diseño le niega. El bridge ya escribe la tabla sin RLS.
     *
     * El proyecto y el usuario NO llegan en el cuerpo: se resuelven del
     * `jobId`. Es lo que impide que quien llame elija en que proyecto escribir,
     * y de paso ahorra hacerle llevar la identidad del usuario a un agente que
     * no la necesita para nada mas.
     *
     * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md`.
     */
    // El formato se valida con un enum y no con un string: es lo que arma la
    // extension del archivo en disco, y la lista tiene que coincidir con
    // `FORMATOS_GENERABLES`.
    const CuerpoDocumentoGenerado = z.object({
      jobId: z.string().uuid(),
      nombre: z.string().min(1),
      contenido: z.string().min(1),
      formato: z.enum(FORMATOS_GENERABLES),
    });

    app.post('/interno/documentos/generado', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      if (!api.guardarGenerado) {
        return reply
          .code(503)
          .send({ code: 'sin_documentos', message: 'este bridge no puede guardar documentos' });
      }

      const cuerpo = CuerpoDocumentoGenerado.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'faltan datos del documento' });
      }

      const contexto = await api.store.contextoDeJob(cuerpo.data.jobId);
      // Sin proyecto o sin usuario no hay fila posible: las dos columnas son
      // obligatorias. Se dice aca en vez de fallar en el INSERT tres capas
      // abajo con un error de Postgres que nadie puede leer.
      if (!contexto?.proyectoId || !contexto.usuarioId) {
        return reply.code(400).send({
          code: 'sin_contexto',
          message: 'ese turno no tiene proyecto y usuario, asi que no se puede guardar el documento',
        });
      }

      try {
        const doc = await api.guardarGenerado({
          proyectoId: contexto.proyectoId,
          usuarioId: contexto.usuarioId,
          nombre: cuerpo.data.nombre,
          contenido: cuerpo.data.contenido,
          formato: cuerpo.data.formato,
        });
        // `output` con el nombre adentro: esto vuelve al MODELO, que con eso le
        // dice a la persona como quedo el archivo.
        return reply.code(200).send({ output: `guarde ${doc.nombre} (${doc.bytes} bytes)` });
      } catch (e) {
        // 422 y no 500: el mensaje del conversor esta escrito para una persona
        // ("este servidor no puede generar un .pdf") y termina en su pantalla.
        const message = e instanceof Error ? e.message : 'no se pudo guardar el documento';
        return reply.code(422).send({ code: 'no_se_pudo_guardar', message });
      }
    });

    /**
     * Los huecos que encontro el analista de una corrida.
     *
     * Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
     *
     * Entra por una HERRAMIENTA y no parseando la respuesta del turno, y esa es
     * la decision central del ciclo: un analista que escribe "parece que falta
     * el modulo de stock" en prosa se traduciria en cero tareas encoladas y una
     * corrida que cierra diciendo que esta completa. Con una tool, o llamo o no
     * llamo, y eso es verificable — es justo lo que mira `rondaDeAnalisis`.
     *
     * La corrida se resuelve del jobId y NO llega en el cuerpo: el id de la
     * corrida seria un dato que el modelo puede cambiar, y con el podria
     * encolarle trabajo a la corrida de otro chat. El jobId ya lo pone el
     * gateway.
     */
    const CuerpoHuecos = z.object({
      jobId: z.string().uuid(),
      /**
       * La ronda que el analista cree que esta corriendo.
       *
       * Se compara contra la de la base en vez de confiar en ella: un turno que
       * quedo colgado y contesta tarde reportaria contra una ronda que ya paso,
       * y esas tareas entrarian a una ronda a la que no pertenecen.
       */
      ronda: z.number().int().min(1).max(100),
      // Vacia es un valor VALIDO y significativo: es como el analista dice "no
      // falta nada", y es el unico camino a que la corrida cierre como
      // completa. Un `.min(1)` aca haria que la unica forma de terminar bien
      // fuera no llamar la herramienta, o sea lo mismo que fallar.
      huecos: z.array(z.string().min(1).max(2000)).max(50),
    });

    app.post('/interno/corrida/huecos', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoHuecos.safeParse(request.body);
      if (!cuerpo.success) {
        return reply
          .code(400)
          .send({ code: 'cuerpo_invalido', message: 'faltan datos del reporte' });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        // El mensaje lo REPITE el modelo, asi que dice que hacer y no solo que
        // fallo: sin esto el analista reintenta la herramienta en loop.
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no pertenece a ninguna corrida abierta, asi que no hay donde anotar los ' +
            'huecos. No reintentes: contale a la persona lo que encontraste en tu respuesta.',
        });
      }
      if (cuerpo.data.ronda !== corrida.ronda) {
        return reply.code(409).send({
          code: 'otra_ronda',
          message:
            `la corrida ya esta en la ronda ${corrida.ronda} y estas reportando la ` +
            `${cuerpo.data.ronda}. No reintentes: lo que encontraste ya no corresponde a esta ronda.`,
        });
      }

      // Se marca SIEMPRE, incluso con la lista vacia. La marca no dice "hay
      // huecos": dice "el analista llamo la herramienta", que es lo que separa
      // "reviso y no falta nada" de "contesto en prosa y nadie recibio nada".
      await api.store.marcarHuecos(corrida.id, corrida.ronda);

      if (cuerpo.data.huecos.length === 0) {
        return reply.code(200).send({ output: 'anotado: no quedan huecos. Cierro la corrida.' });
      }

      const agente = (await api.store.getActiveAgent(corrida.chatId)) ?? 'c1';
      const n = await api.store.encolar(corrida.chatId, {
        agente,
        proyecto: corrida.proyecto,
        textos: cuerpo.data.huecos,
        corridaId: corrida.id,
        ronda: corrida.ronda,
      });
      return reply.code(200).send({ output: `anote ${n} tarea(s) para la ronda que sigue` });
    });

    /**
     * Un cable suelto que anota el AGENTE.
     *
     * Los otros dos los anota el sistema —crear un repo, crear una base— porque
     * los sabe con certeza. Este existe para lo que solo sabe quien escribio el
     * codigo: que variables de entorno pide, que servicio externo hay que dar de
     * alta, que dominio hay que apuntar.
     *
     * Sin esto, el informe de la mañana lista los dos cables que el sistema
     * conoce y calla los cinco que el agente inventó al construir. Y esos son
     * justo los que nadie mas puede adivinar.
     */
    const CuerpoPendiente = z.object({
      jobId: z.string().uuid(),
      // Corto a proposito: es una linea de un informe que se lee en un
      // telefono, no una explicacion.
      texto: z.string().min(1).max(300),
    });

    app.post('/interno/corrida/pendiente', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      const cuerpo = CuerpoPendiente.safeParse(request.body);
      if (!cuerpo.success) {
        return reply.code(400).send({ code: 'cuerpo_invalido', message: 'falta el texto' });
      }

      const corrida = await api.store.corridaDeJob(cuerpo.data.jobId);
      if (!corrida) {
        // El mensaje lo repite el modelo: dice que hacer en vez de solo fallar.
        return reply.code(400).send({
          code: 'sin_corrida',
          message:
            'este turno no es de una corrida, asi que no hay informe donde anotarlo. ' +
            'No reintentes: decilo en tu respuesta.',
        });
      }
      await api.store.anotarPendiente(corrida.id, cuerpo.data.texto);
      return reply.code(200).send({ output: 'anotado para el informe' });
    });

    /**
     * Drive en vivo.
     *
     * Se registra solo si hay con que: sin el secret de Google no hay forma de
     * canjear un refresh token, y una herramienta que existe pero nunca puede
     * funcionar es peor que una que no esta.
     */
    if (api.drive) {
      registrarDrive(app, { ...api.drive, store: api.store, apiToken: api.apiToken });
    }

    /**
     * Supabase, para que una corrida pueda dejar la base creada y migrada.
     *
     * Se registra SIEMPRE, tenga o no token: los endpoints contestan 503 con un
     * mensaje que el agente puede repetir. Al reves que Drive —que no registra
     * nada sin secret— porque aca la diferencia importa: sin las rutas, el
     * gateway contestaria 404 y el modelo leeria "esa herramienta no existe",
     * que lo manda a inventar otra forma de crear la base.
     */
    registrarSupabase(app, {
      ...(api.supabase ?? {}),
      apiToken: api.apiToken,
      // Del jobId a la corrida: es el mismo salto que hace `reportar_huecos`, y
      // por lo mismo — el id de la corrida en el cuerpo seria un dato que el
      // modelo puede cambiar.
      anotarPendiente: async (jobId: string, texto: string) => {
        const corrida = await api.store.corridaDeJob(jobId);
        if (corrida) await api.store.anotarPendiente(corrida.id, texto);
      },
    });

    /**
     * Invalida las sesiones de un slot.
     *
     * Lo llama el servicio de login de la VM cuando saca o rota la cuenta de un
     * slot: los `session_id` guardados apuntan a transcripts que viven en el
     * HOME de ESA cuenta, y con la cuenta nueva ya no existen. Sin este barrido,
     * el proximo mensaje de cada chat falla en el `--resume` con un error que no
     * le dice nada a nadie.
     */
    app.delete<{ Params: { id: string } }>('/agents/:id/sessions', async (request, reply) => {
      if (!isTokenValid(request.headers.authorization, api.apiToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'bearer invalido' });
      }
      // El id entra en una consulta y sale en la respuesta: se valida contra la
      // forma de slot del contrato antes de tocar nada.
      const agent = AgentId.safeParse(request.params.id);
      if (!agent.success) {
        return reply.code(404).send({ code: 'unknown_agent', message: request.params.id });
      }
      return reply.code(200).send({ borradas: await api.store.deleteSessions(agent.data) });
    });
  }

  return app;
}
