import { z } from 'zod';
import { AgentId } from '@multicodigo/shared';
import { PgStore } from './store.js';
import { askAgent } from './agents-client.js';
import { transcribeAudio } from './transcribe.js';
import { buildBot } from './telegram.js';
import { buildWebhookServer } from './webhook.js';

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GATEWAY_URL: z.string().url(),
  GATEWAY_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  DEFAULT_AGENT: AgentId.default('c1'),
  DEFAULT_PROJECT: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
});

const env = Env.parse(process.env);
const store = await PgStore.connect(env.DATABASE_URL, 'src/bridge/migrations/001_init.sql');

const bot = buildBot({
  botToken: env.TELEGRAM_BOT_TOKEN,
  allowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS.split(',').map((s) => Number(s.trim())),
  store,
  defaultAgent: env.DEFAULT_AGENT,
  project: env.DEFAULT_PROJECT,
  ask: (req) => askAgent(req, { gatewayUrl: env.GATEWAY_URL, token: env.GATEWAY_TOKEN }),
  transcribe: (bytes, mimeType) =>
    transcribeAudio(bytes, mimeType, { apiKey: env.GEMINI_API_KEY }),
});

await bot.init(); // necesario antes de handleUpdate cuando no se usa bot.start()

export const app = buildWebhookServer(bot, env.TELEGRAM_WEBHOOK_SECRET);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
