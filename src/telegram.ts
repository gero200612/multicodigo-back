import { Bot, InlineKeyboard } from 'grammy';
import type { AgentId, ApprovalDecision, ApprovalRequest } from '@multicodigo/shared';
import type { PipelineDeps, PipelineOutcome } from './pipeline.js';
import { handleIncoming } from './pipeline.js';
import { startWatching } from './approvals.js';
import { parseApprovalData, renderApproval, type BotonKind } from './render.js';
import type { Store } from './store.js';

export function isAllowedUser(userId: number | undefined, allowed: number[]): boolean {
  if (userId === undefined) return false;
  return allowed.includes(userId);
}

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
  }
}

export interface DecidirDeps {
  store: Store;
  send: (agent: AgentId, approvalId: string, decision: ApprovalDecision) => Promise<void>;
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

  const claim = await deps.store.claimApproval(accion.approvalId, decision);
  if (claim === 'already_decided') return { text: 'Eso ya lo habias contestado.' };
  if (claim === 'unknown') return { text: 'Esa aprobacion no existe.' };

  // El turno vuelve a correr: tanto aprobar como rechazar lo desbloquean —con
  // deny el agente sigue vivo hasta que decida cerrar—. `setJobStatus` no
  // reabre un job ya cerrado, asi que una decision que llega tarde no lo
  // revive.
  await deps.store.setJobStatus(rec.jobId, 'running');

  await deps.send(rec.agent, accion.approvalId, decision);
  return { text: accion.kind === 'ok' ? '✅ Aprobado.' : '❌ Rechazado.' };
}

export interface BridgeDeps extends PipelineDeps {
  botToken: string;
  allowedUserIds: number[];
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

export function buildBot(deps: BridgeDeps): Bot {
  const bot = new Bot(deps.botToken);

  bot.on('callback_query:data', async (ctx) => {
    if (!isAllowedUser(ctx.from?.id, deps.allowedUserIds)) return;

    const accion = parseApprovalData(ctx.callbackQuery.data);
    if (!accion) {
      await ctx.answerCallbackQuery();
      return;
    }

    const { text } = await decidirAprobacion(accion, {
      store: deps.store,
      send: deps.sendDecision,
    });

    // answerCallbackQuery saca el relojito del boton; sin esto el cliente lo
    // deja "cargando" hasta que se rinde.
    await ctx.answerCallbackQuery({ text });
    // Se sacan los botones: ya no hay nada que tocar ahi.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.on('message', async (ctx) => {
    if (!isAllowedUser(ctx.from?.id, deps.allowedUserIds)) return; // silencio, no error

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
        const claim = await deps.store.claimApproval(esperando, decision);
        if (claim === 'claimed') await deps.sendDecision(rec.agent, esperando, decision);
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
      await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text);
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
