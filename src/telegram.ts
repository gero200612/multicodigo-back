import { Bot } from 'grammy';
import type { PipelineDeps, PipelineOutcome } from './pipeline.js';
import { handleIncoming } from './pipeline.js';

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
    case 'error':
      return `⚠️ ${outcome.text}`;
    case 'ignored':
      return '';
  }
}

export interface BridgeDeps extends PipelineDeps {
  botToken: string;
  allowedUserIds: number[];
}

export function buildBot(deps: BridgeDeps): Bot {
  const bot = new Bot(deps.botToken);

  bot.on('message', async (ctx) => {
    if (!isAllowedUser(ctx.from?.id, deps.allowedUserIds)) return; // silencio, no error

    const voice = ctx.message.voice ?? ctx.message.audio;
    if (!voice && !ctx.message.text) return;

    // Un mensaje por job: se manda el placeholder y despues se edita.
    const placeholder = await ctx.reply('🤖 trabajando…');

    try {
      let audio: { bytes: Uint8Array; mimeType: string } | undefined;
      if (voice) {
        const file = await ctx.api.getFile(voice.file_id);
        const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
        const res = await fetch(url);
        audio = {
          bytes: new Uint8Array(await res.arrayBuffer()),
          mimeType: voice.mime_type ?? 'audio/ogg',
        };
      }

      const outcome = await handleIncoming(
        { chatId: ctx.chat.id, messageId: placeholder.message_id, text: ctx.message.text, audio },
        deps,
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
