import { Bot, InlineKeyboard } from 'grammy';
import type { AgentId, ApprovalDecision, ApprovalRequest } from '@multicodigo/shared';
import type { PipelineDeps, PipelineOutcome } from './pipeline.js';
import { handleIncoming, armarMenu, armarMenuDeAgentes } from './pipeline.js';
import { parseMenuData } from './menu.js';
import { MAXIMO_BYTES, TIPOS, tipoDe } from './documentos.js';
import type { Boton } from './render.js';
import { startWatching } from './approvals.js';
import { parseApprovalData, renderApproval, type BotonKind } from './render.js';
import { decidir } from './decisiones.js';
import type { Store } from './store.js';

export function renderOutcome(outcome: PipelineOutcome): string {
  switch (outcome.kind) {
    case 'answer':
      // Sin repetir la transcripcion del audio. Estaba como "🎙 te escuche: …"
      // para mostrar que se habia entendido bien, pero en el uso real es
      // ruido: el que acaba de hablar ya sabe lo que dijo, y en la pantalla de
      // un telefono esas lineas empujan la respuesta —lo unico que se vino a
      // leer— fuera de la vista.
      //
      // Si la transcripcion sale mal se nota igual, porque la respuesta va a
      // hablar de otra cosa.
      return `🤖 ${outcome.agent.toUpperCase()}\n\n${outcome.text}`;
    case 'switched':
      return `Listo, ahora hablas con ${outcome.agent.toUpperCase()}.`;
    case 'status':
      return textoDeActivos(outcome.agent, outcome.otros);
    case 'cowork':
      return textoDeActivos(outcome.primario, outcome.otros);
    case 'project':
      return `Proyecto activo: ${outcome.project}.`;
    case 'ocupado':
      return textoDeOcupado(outcome.agent, outcome.quien, outcome.desde, outcome.esperandoOk);
    case 'error':
      return `⚠️ ${outcome.text}`;
    case 'ignored':
      return '';
    case 'sin_vincular':
      return outcome.yaEstaba
        ? 'Este chat ya esta vinculado a una cuenta.'
        : 'No te tengo vinculado a ninguna cuenta. Mandame /vincular y te doy un codigo para pegar en el panel.';
    case 'codigo':
      return (
        `Tu codigo es:\n\n<code>${outcome.codigo}</code>\n\n` +
        `Pegalo en el panel, en Configuracion. Vence en ${outcome.minutos} minutos.`
      );
    case 'menu_proyectos':
      return 'Elegi un proyecto:';
    case 'menu_agentes':
      return (
        `Agentes de <b>${outcome.proyecto}</b>:\n\n` +
        '● listo · ○ apagado · ⚠ sin cuenta · ⛔ sin tokens'
      );
    case 'sin_proyectos':
      return 'Todavia no pertenecés a ningun proyecto. Creá uno desde el panel y volvé.';
    case 'elegido':
      // El tick y el slot en la primera linea, como etiqueta de estado y no
      // como frase: lo que se busca al volver al chat es "con cual estoy
      // hablando", y eso tiene que leerse de un vistazo.
      return (
        `✅ <b>${outcome.agente.toUpperCase()} conectado</b>\n` +
        `${outcome.nombre} · <i>${outcome.proyecto}</i>\n\n` +
        'Escribime lo que querés que haga.'
      );
  }
}

/**
 * Con quien estas trabajando.
 *
 * El primario primero y marcado como tal: es a quien le llega lo que escribas
 * sin prefijo, y confundirlo es mandarle un pedido al agente equivocado. Los
 * otros van con el comando al lado —`/c2`— porque saber que estan no sirve si
 * no se sabe como hablarles.
 */
export function textoDeActivos(primario: AgentId, otros: AgentId[]): string {
  const cabeza = `Le hablas a ${primario.toUpperCase()}.`;
  if (otros.length === 0) {
    return `${cabeza}\n\nCon /cowork c2 sumas otro agente a este chat y le hablas con /c2.`;
  }
  const lista = otros.map((a) => `· ${a.toUpperCase()} — escribile con /${a}`).join('\n');
  return `${cabeza}\n\nTambien tenes en este chat:\n${lista}\n\nCon /cowork ${otros[0]} lo sacas.`;
}

/**
 * Hace cuanto que alguien tiene el slot, en palabras.
 *
 * Importa mas de lo que parece: "hace 1 min" invita a esperar y "hace 40 min"
 * invita a cambiar de agente. Un aviso sin el tiempo obliga a preguntar.
 */
function haceCuanto(desde: number | undefined, ahora: number): string {
  if (desde === undefined) return '';
  const minutos = Math.floor((ahora - desde) / 60_000);
  if (minutos < 1) return ' (recien)';
  if (minutos === 1) return ' (hace 1 min)';
  return ` (hace ${minutos} min)`;
}

/**
 * El aviso de que el slot lo tiene otro.
 *
 * Sin nombre queda "otra persona": no saber como se llama degrada el mensaje
 * pero no lo invalida, y voltearlo por no poder leer un email seria cambiar un
 * mensaje incompleto por ninguno.
 */
export function textoDeOcupado(
  agente: AgentId,
  quien: string | undefined,
  desde: number | undefined,
  esperandoOk = false,
  ahora = Date.now(),
): string {
  const duenio = quien ?? 'otra persona';
  // Un turno frenado en una aprobacion se destraba con un toque de la otra
  // persona; uno trabajando hay que esperarlo. Es la diferencia entre esperar
  // un cachito e irse a otro agente, y sin decirlo hay que adivinar.
  const porque = esperandoOk
    ? `\nEsta frenado esperando que ${duenio} apruebe algo, asi que puede destrabarse en cualquier momento.`
    : '';
  return (
    `⛔ ${agente.toUpperCase()} lo esta usando ${duenio}${haceCuanto(desde, ahora)}.${porque}\n\n` +
    'Te paso a otro y le mando lo que me escribiste:'
  );
}

/**
 * Que outcomes van con parse_mode HTML.
 *
 * Lista explicita y no "todos": la respuesta de un agente es texto arbitrario y
 * mandarla como HTML haria que un `<` suelto rompa el mensaje entero.
 */
function usaHtml(outcome: PipelineOutcome): boolean {
  return (
    outcome.kind === 'codigo' || outcome.kind === 'menu_agentes' || outcome.kind === 'elegido'
  );
}

/** El teclado de un outcome de menu, si lo tiene. */
function tecladoDe(outcome: PipelineOutcome): InlineKeyboard | undefined {
  const botones: Boton[][] | undefined =
    outcome.kind === 'menu_proyectos' ||
    outcome.kind === 'menu_agentes' ||
    // El error tambien puede traer botones: `usage_limit` ofrece los otros
    // Claude. Ver `botonesDeRelevo` en el pipeline.
    outcome.kind === 'error' ||
    // Y ocupado SIEMPRE los trae: sin otro agente que ofrecer, el aviso seria
    // un "no" sin salida.
    outcome.kind === 'ocupado'
      ? outcome.botones
      : undefined;
  if (!botones || botones.length === 0) return undefined;

  const teclado = new InlineKeyboard();
  for (const fila of botones) {
    for (const b of fila) teclado.text(b.label, b.data);
    teclado.row();
  }
  return teclado;
}

export interface DecidirDeps {
  store: Store;
  send: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  /** Refleja la decision en el mensaje del chat. Puede fallar sin consecuencias. */
  editarMensaje: (chatId: number, messageId: number, texto: string) => Promise<void>;
}

/**
 * Traduce un toque de boton en una decision.
 *
 * `claimApproval` va ANTES del `send`: si se mandara primero al agente y
 * despues se marcara, dos toques simultaneos mandarian dos decisiones. Al
 * reves, el segundo toque no llega nunca al agente.
 */
export async function decidirAprobacion(
  accion: { kind: BotonKind; approvalId: string },
  deps: DecidirDeps,
  usuarioId?: string,
): Promise<{ text: string }> {
  const rec = await deps.store.getApproval(accion.approvalId);
  if (!rec) return { text: 'Esa aprobacion no existe o ya no esta en juego.' };

  if (accion.kind === 'ex') {
    // Todavia no se decide nada: primero hace falta el motivo. El proximo
    // mensaje del chat ES el motivo, no un prompt nuevo.
    await deps.store.setAwaitingFeedback(rec.chatId, accion.approvalId);
    return { text: 'Contame por que no, con un mensaje o un audio.' };
  }

  const decision: ApprovalDecision =
    accion.kind === 'ok' ? { decision: 'allow' } : { decision: 'deny' };

  // Por `decidir` y no a mano: es el unico camino, y ahora la misma aprobacion
  // se puede tocar tambien desde el panel. Dos caminos serian dos reglas.
  const r = await decidir(
    { store: deps.store, send: deps.send, editarMensaje: deps.editarMensaje },
    { approvalId: accion.approvalId, decision, desde: 'telegram', usuarioId },
  );

  if (r === 'ya_decidida') return { text: 'Eso ya estaba contestado.' };
  if (r === 'desconocida') return { text: 'Esa aprobacion no existe.' };
  return { text: accion.kind === 'ok' ? '✅ Aprobado.' : '❌ Rechazado.' };
}

export interface BridgeDeps extends PipelineDeps {
  botToken: string;
  fetchPending: (agent: AgentId) => Promise<ApprovalRequest[]>;
  sendDecision: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  /**
   * Guarda un archivo que llego por el chat como documento del proyecto.
   *
   * Opcional: sin `SUPABASE_SERVICE_KEY` el bridge no puede escribir en el
   * Storage, y entonces esto no se pasa. El bot lo dice en vez de aceptar un
   * archivo que se iba a perder — ver el handler de `message:document`.
   */
  guardarDocumento?: (entrada: {
    proyectoId: string;
    usuarioId: string;
    nombreOriginal: string;
    datos: Uint8Array;
  }) => Promise<{ nombre: string; error?: string }>;
}

/**
 * Baja cualquier archivo de Telegram por su file_id.
 *
 * Telegram no manda el contenido en el update: manda un id que hay que canjear
 * por una ruta con `getFile` y despues bajar del CDN, con el token del bot en
 * la URL. Por eso esto necesita el token y no alcanza con el `ctx`.
 */
async function bajarArchivo(
  api: { getFile: (id: string) => Promise<{ file_path?: string }> },
  fileId: string,
  botToken: string,
): Promise<Uint8Array> {
  const file = await api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`telegram devolvio ${res.status} al bajar el archivo`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Baja un audio de Telegram. Se usa tanto para un prompt como para un motivo. */
async function bajarAudio(
  api: { getFile: (id: string) => Promise<{ file_path?: string }> },
  fileId: string,
  mimeType: string,
  botToken: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const file = await api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType };
}

/**
 * Los comandos que Telegram muestra en el boton de menu del chat.
 *
 * Sin registrarlos, los comandos existen pero son invisibles: el boton de menu
 * aparece vacio y hay que adivinar que `/menu` cambia de agente. `getMyCommands`
 * devolvia `[]`.
 *
 * `/start` NO va en la lista aunque el bot lo entienda: Telegram ya lo ofrece
 * solo al abrir un chat nuevo, y repetirlo en el menu ocupa un renglon para algo
 * que ya paso.
 *
 * Tampoco van `/c1`..`/c6`: son seis renglones para elegir agente, que es
 * exactamente lo que `/menu` hace con botones y sabiendo cuales tienen cuenta.
 * Siguen funcionando escritos a mano.
 */
const COMANDOS = [
  { command: 'menu', description: 'Elegir con qué agente hablar' },
  { command: 'proyecto', description: 'Ver o cambiar el proyecto activo' },
  { command: 'status', description: 'Con qué agentes estás trabajando' },
  { command: 'cowork', description: 'Sumar o sacar un agente de este chat' },
  { command: 'vincular', description: 'Conectar este chat con tu cuenta del panel' },
];

export function buildBot(deps: BridgeDeps): Bot {
  const bot = new Bot(deps.botToken);

  // Al arrancar y sin esperarlo: es una llamada a la API de Telegram que puede
  // tardar o fallar, y un bot que no levanta porque no pudo publicar su menu
  // seria peor que un menu vacio. Si falla se loguea y el bot anda igual.
  void bot.api.setMyCommands(COMANDOS).catch((err: unknown) => {
    console.error('[bridge] no se pudieron publicar los comandos:', err);
  });

  bot.on('callback_query:data', async (ctx) => {
    const accion = parseApprovalData(ctx.callbackQuery.data);
    if (!accion) {
      // No es una aprobacion: puede ser el menu. Un dato que tampoco es del
      // menu —un boton viejo de antes de un deploy, o el inerte de un agente
      // sin cuenta— se contesta y se ignora.
      const menu = parseMenuData(ctx.callbackQuery.data);
      // answerCallbackQuery primero: sin eso Telegram deja el boton
      // "cargando" hasta que se conteste, y armar el menu siguiente tarda.
      await ctx.answerCallbackQuery();
      if (menu) await manejarMenu(ctx, menu, deps);
      return;
    }

    // Quien decidio, para poder mostrarlo despues en el panel. Puede no haber:
    // un chat sin vincular igual puede tocar el boton de una aprobacion vieja.
    const usuarioId = ctx.chat ? await deps.store.usuarioDeChat(ctx.chat.id) : undefined;

    const { text } = await decidirAprobacion(
      {
        ...accion,
      },
      {
        store: deps.store,
        send: deps.sendDecision,
        editarMensaje: (chatId, messageId, texto) =>
          ctx.api.editMessageText(chatId, messageId, texto).then(() => undefined),
      },
      usuarioId,
    );

    // answerCallbackQuery saca el relojito del boton; sin esto el cliente lo
    // deja "cargando" hasta que se rinde.
    await ctx.answerCallbackQuery({ text });
    // Se sacan los botones: ya no hay nada que tocar ahi.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  /**
   * Un archivo mandado al chat.
   *
   * Va ANTES del handler general de mensajes porque un documento no es un
   * prompt: no arranca un turno, se guarda. Antes de esto, mandarle un archivo
   * al bot no hacia nada y no contestaba nada — el handler de abajo miraba
   * `voice`, `audio` y `text`, y todo lo demas caia en un `return` mudo.
   *
   * Las fotos NO entran por aca a proposito. Telegram las manda como `photo`
   * —recomprimidas y sin nombre de archivo— y el conversor no lee imagenes: no
   * habria de donde sacar texto. Una imagen mandada "como archivo" si entra,
   * porque viaja como `document`, y ahi el rechazo lo da el tipo.
   */
  bot.on('message:document', async (ctx) => {
    const usuarioId = await deps.store.usuarioDeChat(ctx.chat.id);
    if (!usuarioId) {
      await ctx.reply(
        'No te tengo vinculado a ninguna cuenta, asi que no se a que proyecto guardar esto. ' +
          'Mandame /vincular.',
      );
      return;
    }

    if (!deps.guardarDocumento) {
      // Se dice, no se ignora: aceptar el archivo en silencio y perderlo es
      // justo el comportamiento que esta feature vino a sacar.
      await ctx.reply('Todavia no puedo guardar archivos. Subilo desde el panel, en Configuracion.');
      return;
    }

    const doc = ctx.message.document;
    const nombreOriginal = doc.file_name ?? 'documento';

    // El tamaño se mira ANTES de bajar: Telegram ya lo dice en el update, y
    // bajar 20 MB para despues rechazarlos es tiempo y memoria por nada.
    if (doc.file_size !== undefined && doc.file_size > MAXIMO_BYTES) {
      await ctx.reply(`Ese archivo pasa los ${MAXIMO_BYTES / (1024 * 1024)} MB.`);
      return;
    }

    const tipo = tipoDe(nombreOriginal);
    if (!tipo) {
      await ctx.reply(`No se leer ese tipo de archivo. Puedo con: ${TIPOS.join(', ')}.`);
      return;
    }

    // El proyecto al que va: el activo del chat. Es el mismo con el que
    // hablarian los turnos, asi que el documento aparece donde la persona
    // espera y no en otro proyecto.
    const proyecto = (await deps.store.getActiveProject(ctx.chat.id)) ?? deps.project;
    const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
    const proyectoId = proyectos.find((p) => p.nombre === proyecto)?.id;
    if (!proyectoId) {
      await ctx.reply(
        `El proyecto activo (${proyecto}) no existe en el panel, asi que no tiene donde guardarse. ` +
          'Elegi otro con /menu.',
      );
      return;
    }

    const aviso = await ctx.reply('📎 guardando…');
    try {
      const datos = await bajarArchivo(ctx.api, doc.file_id, deps.botToken);
      const guardado = await deps.guardarDocumento({
        proyectoId,
        usuarioId,
        nombreOriginal,
        datos,
      });

      // El error de conversion NO es un fallo del guardado: el original quedo,
      // y se puede descargar del panel. Se cuenta aparte para que se entienda
      // que el archivo esta pero el agente no lo va a poder leer.
      const cola = guardado.error
        ? `\n\n⚠️ No pude convertirlo a texto (${guardado.error}), asi que el agente no va a poder leerlo.`
        : '\n\nYa lo pueden leer los agentes de este proyecto.';

      await ctx.api.editMessageText(
        ctx.chat.id,
        aviso.message_id,
        `✅ Guardado en <b>${proyecto}</b> como <code>${guardado.nombre}</code>.${cola}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        aviso.message_id,
        `⚠️ No pude guardar el archivo: ${message}`,
      );
    }
  });

  bot.on('message', async (ctx) => {
    // Antes habia aca un filtro por TELEGRAM_ALLOWED_USER_IDS. Quien puede
    // hablarle al bot ahora sale de telegram_vinculos, y lo resuelve el
    // pipeline: un chat sin vincular recibe una linea y nada mas.
    const voice = ctx.message.voice ?? ctx.message.audio;

    // Una foto tiene su propio aviso: cae aca porque no es `document`, y sin
    // esto seria otro mensaje que el bot ignora en silencio.
    if (ctx.message.photo) {
      await ctx.reply(
        'No puedo leer imagenes. Si es un PDF o un Excel, mandalo como archivo ' +
          `(clip → Archivo). Puedo con: ${TIPOS.join(', ')}.`,
      );
      return;
    }

    if (!voice && !ctx.message.text) return;

    // Si el chat quedo esperando un motivo, este mensaje ES el motivo y no un
    // prompt nuevo. Va antes que todo lo demas por eso.
    const esperando = await deps.store.getAwaitingFeedback(ctx.chat.id);
    if (esperando) {
      const rec = await deps.store.getApproval(esperando);

      let motivo = ctx.message.text ?? '';
      if (!motivo && voice) {
        // El motivo por audio es el caso normal: se explica mas rapido
        // hablando que escribiendo, y por eso este boton es el mas usado.
        const a = await bajarAudio(
          ctx.api,
          voice.file_id,
          voice.mime_type ?? 'audio/ogg',
          deps.botToken,
        );
        motivo = await deps.transcribe(a.bytes, a.mimeType);
      }
      // Se limpia SIEMPRE, aunque falte el motivo: si no, el chat queda
      // atrapado y ningun mensaje siguiente llega al agente.
      await deps.store.setAwaitingFeedback(ctx.chat.id, null);
      if (rec && motivo) {
        const decision: ApprovalDecision = { decision: 'deny', feedback: motivo };
        await decidir(
          {
            store: deps.store,
            send: deps.sendDecision,
            editarMensaje: (chatId, messageId, texto) =>
              ctx.api.editMessageText(chatId, messageId, texto).then(() => undefined),
          },
          {
            approvalId: esperando,
            decision,
            desde: 'telegram',
            usuarioId: await deps.store.usuarioDeChat(ctx.chat.id),
          },
        );
        await ctx.reply('Listo, se lo paso y sigue con eso en cuenta.');
      }
      return;
    }

    // Un mensaje por job: se manda el placeholder y despues se edita.
    //
    // Y COLGADO del mensaje que lo pidio. Con dos agentes trabajando a la vez
    // en el mismo chat —`/c1 esto` y `/c2 aquello`— las dos respuestas llegan
    // mezcladas y no hay como saber cual contesta a cual. El reply lo dice sin
    // que nadie tenga que leer las dos.
    const placeholder = await ctx.reply('🤖 trabajando…', {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    try {
      let audio: { bytes: Uint8Array; mimeType: string } | undefined;
      if (voice) {
        audio = await bajarAudio(
          ctx.api,
          voice.file_id,
          voice.mime_type ?? 'audio/ogg',
          deps.botToken,
        );
      }

      const outcome = await handleIncoming(
        { chatId: ctx.chat.id, messageId: placeholder.message_id, text: ctx.message.text, audio },
        {
          ...deps,
          watchApprovals: ({ agent, jobId, chatId, messageId }) =>
            startWatching(
              {
                fetchPending: () => deps.fetchPending(agent),
                announce: async (a) => {
                  // recordApproval devuelve false si ya se anuncio en otra
                  // corrida: Render puede reiniciar a mitad de turno.
                  const nueva = await deps.store.recordApproval({
                    approvalId: a.approvalId,
                    jobId,
                    chatId,
                    messageId,
                    agent,
                    tool: a.tool,
                    summary: a.summary,
                  });
                  if (!nueva) return;

                  // El turno esta bloqueado esperando el OK. Sin esto la tabla
                  // dice 'running' y no hay forma de distinguir un agente que
                  // piensa de uno que espera hace diez minutos.
                  const estado =
                    a.tool === 'mcp__multicodigo__run' ? 'awaiting_build' : 'awaiting_approval';
                  await deps.store.setJobStatus(jobId, estado);

                  const { text, buttons } = renderApproval(a);
                  const teclado = new InlineKeyboard();
                  for (const fila of buttons) {
                    for (const b of fila) teclado.text(b.label, b.data);
                    teclado.row();
                  }
                  // Mensaje NUEVO, no editando el de "trabajando…": ese tiene
                  // que seguir mostrando el progreso, y un mensaje con botones
                  // que se edita encima pierde los botones.
                  await ctx.reply(text, { reply_markup: teclado });
                },
                seen: new Set(),
              },
              2000,
            ),
        },
      );

      const text = renderOutcome(outcome);
      if (text === '') return;
      const teclado = tecladoDe(outcome);
      await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, {
        // Solo donde hace falta: ver `usaHtml`.
        ...(usaHtml(outcome) ? { parse_mode: 'HTML' as const } : {}),
        ...(teclado ? { reply_markup: teclado } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        placeholder.message_id,
        `⚠️ Se rompio algo en el puente: ${message}`,
      );
    }
  });

  return bot;
}

/**
 * Un toque del menu.
 *
 * La membresia se verifica aunque el boton haya salido de este mismo bot: el
 * callback_data vuelve del cliente y no hay nada que garantice que sea el que
 * mandamos.
 */
async function manejarMenu(
  ctx: {
    chat?: { id: number };
    reply: (
      texto: string,
      opciones?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard },
    ) => Promise<unknown>;
  },
  menu: { kind: 'proyecto'; id: string } | { kind: 'agente'; slot: AgentId } | { kind: 'menu' },
  deps: BridgeDeps,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return;

  // El boton que trae el mensaje de "se quedo sin tokens". Es el MISMO menu que
  // /menu: no hay una pantalla especial de agentes agotados, porque el menu ya
  // los marca con su hora de vuelta.
  if (menu.kind === 'menu') {
    const out = await armarMenu(usuarioId, chatId, deps);
    await ctx.reply(renderOutcome(out), {
      parse_mode: 'HTML',
      reply_markup: tecladoDe(out),
    });
    return;
  }

  if (menu.kind === 'proyecto') {
    const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
    const elegido = proyectos.find((p) => p.id === menu.id);
    if (!elegido) return;

    await deps.store.setActiveProject(chatId, elegido.nombre);
    const out = await armarMenuDeAgentes(elegido, deps);
    await ctx.reply(renderOutcome(out), {
      parse_mode: 'HTML',
      reply_markup: tecladoDe(out),
    });
    return;
  }

  await deps.store.setActiveAgent(chatId, menu.slot);
  const proyecto = (await deps.store.getActiveProject(chatId)) ?? deps.project;

  // El nombre que le puso la persona, si tiene: el slot esta anotado con
  // nombre en su proyecto y en ningun otro lado.
  const proyectos = await deps.store.proyectosDeUsuario(usuarioId);
  const p = proyectos.find((x) => x.nombre === proyecto);
  const registrados = p ? await deps.store.agentesDeProyecto(p.id) : [];
  const nombre = registrados.find((a) => a.slot === menu.slot)?.nombre ?? menu.slot.toUpperCase();

  await ctx.reply(renderOutcome({ kind: 'elegido', agente: menu.slot, nombre, proyecto }), {
    parse_mode: 'HTML',
  });

  // Lo que habias escrito cuando el slot anterior estaba ocupado. Se manda al
  // agente recien elegido en vez de hacerte reescribirlo.
  //
  // `tomarPendiente` lo saca y lo borra en la misma sentencia: dos toques
  // seguidos al boton no pueden mandar el mismo mensaje dos veces.
  const pendiente = await deps.store.tomarPendiente(chatId).catch(() => undefined);
  if (pendiente === undefined) return;

  const out = await handleIncoming(
    { chatId, messageId: 0, text: `/${menu.slot} ${pendiente}` },
    deps,
  );
  await ctx.reply(renderOutcome(out), { reply_markup: tecladoDe(out) });
}
