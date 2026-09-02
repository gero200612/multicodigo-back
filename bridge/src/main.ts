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
import { askAgent, listarAgentes } from './agents-client.js';
import { firmarToken } from './panel-client.js';
import { fetchPending, sendDecision } from './approvals.js';
import { transcribeAudio } from './transcribe.js';
import { documentosDelTurno, guardarDocumento } from './documentos.js';
import { buildBot } from './telegram.js';
import { buildWebhookServer } from './webhook.js';
import { startWatching } from './approvals.js';
import { LimitePorChat } from './vinculacion.js';

/**
 * Una variable opcional que el compose entrega como cadena vacia.
 *
 * `${VAR:-}` NO omite la variable: la define en "". Con `.optional()` a secas
 * eso no es "ausente" sino un string que no pasa el `.min(1)` —o el `.url()`—
 * y el proceso no arranca. Paso exactamente eso en el primer despliegue de los
 * documentos: el bridge quedo en crash-loop con
 * `SUPABASE_SERVICE_KEY: String must contain at least 1 character(s)`.
 *
 * Esto hace que "no configurado" y "vacio" signifiquen lo mismo, que es lo que
 * el compose ya asume al escribir `${VAR:-}`.
 */
const opcional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  // TELEGRAM_ALLOWED_USER_IDS se fue: quien puede hablarle al bot sale de
  // telegram_vinculos.
  GEMINI_API_KEY: z.string().min(1),
  GATEWAY_URL: z.string().url(),
  GATEWAY_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  DEFAULT_AGENT: AgentId.default('c1'),
  DEFAULT_PROJECT: z.string().min(1),
  // Credencial de la API de lectura que consume el panel. Distinta del secret
  // del webhook a proposito: son dos cosas con dueños distintos.
  BRIDGE_API_TOKEN: z.string().min(16),
  // Por la red interna de Docker: http://panel:8091. OPCIONAL — sin esto los
  // turnos de Telegram van por SSH con la deploy key, que es como funcionaban
  // antes de la GitHub App. No se hace obligatorio para no voltear el bridge de
  // un despliegue que todavia no registro la App.
  PANEL_URL: opcional(z.string().url()),
  /**
   * Supabase, para los documentos que llegan por Telegram.
   *
   * Los tres son OPCIONALES juntos: sin ellos el bot avisa que no puede
   * guardar archivos y todo lo demas anda igual. No se hacen obligatorios para
   * no voltear un despliegue que todavia no los configuro.
   *
   * `SUPABASE_SERVICE_KEY` es la service_role, y pasa por encima de RLS. Vive
   * aca y NO en el panel a proposito: el panel es el proceso expuesto a
   * internet y la tiene negada desde el diseño original, mientras que el bridge
   * ya se conecta a la misma base como `postgres` —o sea que ya puede escribir
   * cualquier fila—. Ver el comentario largo de documentos.ts.
   */
  SUPABASE_URL: opcional(z.string().url()),
  SUPABASE_SERVICE_KEY: opcional(z.string().min(1)),
  /** Por la red del compose. El bridge y el conversor comparten `puente`. */
  CONVERSOR_URL: opcional(z.string().url()),
  PORT: z.coerce.number().int().positive().default(3000),
});

const env = Env.parse(process.env);
// La ruta se resuelve contra ESTE modulo, no contra el working directory del
// proceso: un 'src/bridge/migrations/...' relativo funciona solo si Render
// arranca parado en la raiz del repo, y si no, el bridge no levanta. Desde
// src/ y desde dist/ el '..' cae en el mismo lugar.
const MIGRACIONES = [
  '001_init.sql',
  '002_approvals.sql',
  '003_multiproyecto.sql',
  '004_proyectos.sql',
  '005_agentes.sql',
  '006_telegram.sql',
  '007_jobs.sql',
  '008_rls.sql',
  '009_agentes_insert.sql',
  '010_realtime.sql',
  '011_proyectos_rpc.sql',
  '012_aprobaciones.sql',
  '013_sesiones_por_proyecto.sql',
  '014_vinculos_visibles.sql',
  '015_agotamiento.sql',
  '016_pendiente.sql',
  '017_cowork.sql',
  '018_modo_permisos.sql',
  '019_modelo.sql',
].map((f) => fileURLToPath(new URL('../migrations/' + f, import.meta.url)));
const store = await PgStore.connect(env.DATABASE_URL, MIGRACIONES);

// Un solo lugar con la URL y el token del gateway: prompt, aprobaciones y git
// salen todos por ahi.
const gatewayDeps = { gatewayUrl: env.GATEWAY_URL, token: env.GATEWAY_TOKEN };

/**
 * Con que guardar y leer los documentos, o `undefined`.
 *
 * Las dos claves van juntas: con la URL y sin la key no se puede escribir nada,
 * y al reves tampoco. Tenerlo en una sola constante evita un estado a medias en
 * el que el bot acepta un archivo y despues no lo puede subir.
 */
const docsDeps =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
    ? {
        supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
        serviceKey: env.SUPABASE_SERVICE_KEY,
        conversorUrl: env.CONVERSOR_URL,
      }
    : undefined;

if (!docsDeps) {
  // Ruidoso a proposito: es una funcionalidad apagada, no un default. El
  // sintoma sin este aviso seria "el bot no guarda mis archivos" sin nada en
  // los logs que diga por que.
  console.warn(
    '[bridge] sin SUPABASE_URL/SUPABASE_SERVICE_KEY: no se pueden guardar documentos de Telegram',
  );
}

/**
 * Lo que un turno necesita, sin lo que es propio de Telegram.
 *
 * Se arma aparte porque lo usan los dos: `buildBot` para el camino del chat, y
 * el endpoint `/turnos` del panel. Es la misma configuracion a proposito —el
 * hilo es uno solo— y tenerla en una constante evita que se separen.
 */
const pipelineDeps = {
  store,
  defaultAgent: env.DEFAULT_AGENT,
  project: env.DEFAULT_PROJECT,
  limite: new LimitePorChat(),
  ask: (req: Parameters<typeof askAgent>[0]) => askAgent(req, gatewayDeps),
  // Sin PANEL_URL no se pasa la funcion: `tokenDelProyecto` la trata como
  // ausente y devuelve undefined, que es el camino SSH.
  firmarToken: env.PANEL_URL
    ? (id: number) =>
        firmarToken(id, { panelUrl: env.PANEL_URL!, token: env.BRIDGE_API_TOKEN })
    : undefined,
  transcribe: (bytes: Uint8Array, mimeType: string) =>
    transcribeAudio(bytes, mimeType, { apiKey: env.GEMINI_API_KEY }),
  // Sin Supabase no se pasa: el turno corre sin documentos, que es como
  // funcionaba antes de esto.
  documentosDelTurno: docsDeps
    ? (proyectoId: string) => documentosDelTurno(proyectoId, docsDeps)
    : undefined,
  listarAgentes: () => listarAgentes(gatewayDeps),
  // Para poder decir POR QUE un slot esta ocupado: un turno frenado esperando
  // un OK se destraba con un toque de la otra persona, y uno trabajando hay que
  // esperarlo. Es el mismo fetchPending del poller de aprobaciones.
  pendientesDe: (agent: AgentId) => fetchPending(agent, gatewayDeps),
};

const bot = buildBot({
  ...pipelineDeps,
  botToken: env.TELEGRAM_BOT_TOKEN,
  fetchPending: (agent) => fetchPending(agent, gatewayDeps),
  sendDecision: (agent, approvalId, decision) =>
    sendDecision(agent, approvalId, decision, gatewayDeps),
  guardarDocumento: docsDeps
    ? (entrada) => guardarDocumento(entrada, docsDeps)
    : undefined,
});

await bot.init(); // necesario antes de handleUpdate cuando no se usa bot.start()

export const app = buildWebhookServer(bot, env.TELEGRAM_WEBHOOK_SECRET, {
  store,
  apiToken: env.BRIDGE_API_TOKEN,
  // El MISMO camino que usan los botones del chat. El panel no escribe la
  // tabla por su cuenta: decidir tambien es avisarle al gateway y editar el
  // mensaje de Telegram, y el bot es el unico que puede hacer lo ultimo.
  // Un turno del panel es el MISMO turno que el de Telegram: mismo job, mismo
  // poller de aprobaciones, misma sesion. El `watchApprovals` sale de aca y no
  // de `buildBot` porque ese lo arma por mensaje, con el chat al que contestar;
  // este no tiene chat al que contestarle.
  pipeline: {
    ...pipelineDeps,
    watchApprovals: ({ agent, jobId }) =>
      startWatching(
        {
          fetchPending: () => fetchPending(agent, gatewayDeps),
          announce: async (a) => {
            // Se anota igual que las de Telegram —el panel las lee de la
            // tabla— pero sin mensaje que editar: chat 0 y mensaje 0.
            const nueva = await store.recordApproval({
              approvalId: a.approvalId,
              jobId,
              chatId: 0,
              messageId: 0,
              agent,
              tool: a.tool,
              summary: a.summary,
            });
            if (!nueva) return;
            const estado =
              a.tool === 'mcp__multicodigo__run' ? 'awaiting_build' : 'awaiting_approval';
            await store.setJobStatus(jobId, estado);
          },
          seen: new Set(),
        },
        2000,
      ),
  },
  decisiones: {
    store,
    send: (agent, approvalId, decision) =>
      sendDecision(agent, approvalId, decision, gatewayDeps),
    editarMensaje: (chatId, messageId, texto) =>
      bot.api.editMessageText(chatId, messageId, texto).then(() => undefined),
  },
});
await app.listen({ port: env.PORT, host: '0.0.0.0' });
