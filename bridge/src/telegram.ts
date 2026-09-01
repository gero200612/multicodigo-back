import { Bot, InlineKeyboard } from 'grammy';
import type { AgentId, ApprovalDecision, ApprovalRequest } from '@multicodigo/shared';
import type { PipelineDeps, PipelineOutcome } from './pipeline.js';
import { handleIncoming, armarMenuDeAgentes } from './pipeline.js';
import { parseMenuData } from './menu.js';
import type { Boton } from './render.js';
import { startWatching } from './approvals.js';
import { parseApprovalData, renderApproval, type BotonKind } from './render.js';
import { decidir } from './decisiones.js';
import type { Store } from './store.js';

export function renderOutcome(outcome: PipelineOutcome): string {
  switch (outcome.kind) {
    case 'answer': {
      const head = outcome.transcript ? `🎙 te escuche: ${outcome.transcript}\n\n` : '';
      return `${head}🤖 ${outcome.agent.toUpperCase()}\n\n${outcome.text}`;
    }
    case 'switched':
      return `Listo, ahora hablas con ${outcome.agent.toUpperCase()}.`;
    case 'status':
      return `Agente activo: ${outcome.agent.toUpperCase()}.`;
    case 'project':
      return `Proyecto activo: ${outcome.project}.`;
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
      return `Agentes de <b>${outcome.proyecto}</b>:\n\n● listo · ○ apagado · ⚠ sin cuenta`;
    case 'sin_proyectos':
      return 'Todavia no pertenecés a ningun proyecto. Creá uno desde el panel y volvé.';
    case 'elegido':
      return (
        `Listo, hablás con <b>${outcome.nombre}</b> en <i>${outcome.proyecto}</i>.\n\n` +
        'Escribime lo que querés que haga.'
      );
  }
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
    outcome.kind === 'menu_proyectos' || outcome.kind === 'menu_agentes'
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
  { command: 'status', description: 'Qué está haciendo cada agente' },
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

  bot.on('message', async (ctx) => {
    // Antes habia aca un filtro por TELEGRAM_ALLOWED_USER_IDS. Quien puede
    // hablarle al bot ahora sale de telegram_vinculos, y lo resuelve el
    // pipeline: un chat sin vincular recibe una linea y nada mas.
    const voice = ctx.message.voice ?? ctx.message.audio;
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
    const placeholder = await ctx.reply('🤖 trabajando…');

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
  menu: { kind: 'proyecto'; id: string } | { kind: 'agente'; slot: AgentId },
  deps: BridgeDeps,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return;

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
}
