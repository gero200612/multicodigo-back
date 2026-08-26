/**
 * Punto de entrada del bridge.
 *
 * Se llamaba server.ts, pero no construia nada: era todo arranque. El
 * constructor de verdad vive en webhook.ts (buildWebhookServer), asi que el
 * nombre mentia y ademas rompia la simetria con el agente y el gateway, que ya
 * tienen su main.ts separado.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentId } from '@multicodigo/shared';
import { PgStore } from './store.js';
import { askAgent } from './agents-client.js';
import { fetchPending, sendDecision } from './approvals.js';
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
// La ruta se resuelve contra ESTE modulo, no contra el working directory del
// proceso: un 'src/bridge/migrations/...' relativo funciona solo si Render
// arranca parado en la raiz del repo, y si no, el bridge no levanta. Desde
// src/ y desde dist/ el '..' cae en el mismo lugar.
const MIGRACIONES = ['001_init.sql', '002_approvals.sql'].map((f) =>
  fileURLToPath(new URL('../migrations/' + f, import.meta.url)),
);
const store = await PgStore.connect(env.DATABASE_URL, MIGRACIONES);

// Un solo lugar con la URL y el token del gateway: prompt, aprobaciones y git
// salen todos por ahi.
const gatewayDeps = { gatewayUrl: env.GATEWAY_URL, token: env.GATEWAY_TOKEN };

const bot = buildBot({
  botToken: env.TELEGRAM_BOT_TOKEN,
  allowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS.split(',').map((s) => Number(s.trim())),
  store,
  defaultAgent: env.DEFAULT_AGENT,
  project: env.DEFAULT_PROJECT,
  ask: (req) => askAgent(req, gatewayDeps),
  transcribe: (bytes, mimeType) =>
    transcribeAudio(bytes, mimeType, { apiKey: env.GEMINI_API_KEY }),
  fetchPending: (agent) => fetchPending(agent, gatewayDeps),
  sendDecision: (agent, approvalId, decision) =>
    sendDecision(agent, approvalId, decision, gatewayDeps),
});

await bot.init(); // necesario antes de handleUpdate cuando no se usa bot.start()

export const app = buildWebhookServer(bot, env.TELEGRAM_WEBHOOK_SECRET);
await app.listen({ port: env.PORT, host: '0.0.0.0' });
