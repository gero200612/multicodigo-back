/**
 * Punto de entrada del bridge.
 *
 * Se llamaba server.ts, pero no construia nada: era todo arranque. El
 * constructor de verdad vive en webhook.ts (buildWebhookServer), asi que el
 * nombre mentia y ademas rompia la simetria con el agente y el gateway, que ya
 * tienen su main.ts separado.
 */
// PRIMERO y por su efecto: sube el techo real de un turno antes del primer
// fetch. Ver `dispatcher.ts` — el techo de verdad eran 5 minutos, no 20.
import './dispatcher.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentId, reportarCrashes } from '@multicodigo/shared';
import { PgStore, type FilaDeDocumento } from './store.js';
import { askAgent, listarAgentes, esperarAlGateway } from './agents-client.js';
import { firmarToken, crearRepo } from './panel-client.js';
import { publicar } from './publicar.js';
import { dispararDeploy, setearEnvVar, ultimoDeploy } from './render-api.js';
import { reescribirConfig } from './conectar.js';
import { escribirArchivo, leerArchivo } from './github-contenido.js';
import { guardarAnalisis, guardarCapturas } from './analisis.js';
import { asegurarDockerfile } from './dockerfile-back.js';
import { asegurarOutputPathDeAngular } from './angular-output.js';
import { verificarDespliegue, tareaDeProblema } from './verificar.js';
import type { Corrida } from './corrida.js';
import { mergearEnGateway, guardarEnGateway, inspeccionarRepo, trabajoEnGateway } from './gateway-admin.js';
import { fetchPending, sendDecision } from './approvals.js';
import { transcribeAudio } from './transcribe.js';
import {
  documentosDelTurno,
  guardarDocumento,
  guardarDocumentoGenerado,
} from './documentos.js';
import { buildBot, retomarCorridas } from './telegram.js';
import { buildWebhookServer } from './webhook.js';
import { abrirDemo, abrirDesarrollo, estadoDeDemo } from './demo-homero.js';
import { cifrar, claveDe, descifrar } from './cifrado.js';
import { verificar } from './proveedores.js';
import { aDestino, desplegarRepo, publicarCambios, textoDePublicacion } from './publicar-ticket.js';
import type { Destino } from './store.js';
import { apagarEnVps, borrarDelVps, estadoEnVps, publicarEnVps, revisarDemos, type VpsDeps } from './vps.js';
import { probarEnVivo, type ResultadoDeHumo } from './humo.js';
import { usoDelVps } from './vps-uso.js';
import { asegurarDockerfileDeFront } from './dockerfile-front.js';
import { partirParaTelegram } from './codigo.js';
import { startWatching } from './approvals.js';
import { LimitePorChat } from './vinculacion.js';
import { crearUsuarioPorApi, crearUsuarioPorSql } from './altas.js';
import { trabajoDeMiEmpresa } from './trabajo.js';
import { PgRegistroDeErrores, registrarSinRomper, type RegistroDeErrores } from './errores.js';

/**
 * Los crashes del bridge quedan en el registro de errores.
 *
 * Es lo PRIMERO que corre (despues de los imports, que en ESM van antes de
 * todo): un `Env.parse` que tira o una migracion que falla tambien son
 * crashes. Hasta que la base conecte, `registroDeErrores` es `undefined` y el
 * reporte solo queda en el log, como antes. El comportamiento no cambia: el
 * handler sale con 1 y el compose lo reinicia.
 *
 * 3 s de espera, como `reportarError` de shared: el proceso se esta muriendo, y
 * una base colgada no puede dejarlo vivo a medias.
 */
let registroDeErrores: RegistroDeErrores | undefined;
reportarCrashes('bridge', (r) => registrarSinRomper(registroDeErrores, r, 3_000));

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
  /**
   * Donde se escriben los documentos que llegan por Telegram.
   *
   * El gateway monta el MISMO directorio y los copia al worktree del agente.
   * Antes iban a Supabase Storage, que entre dos procesos de la misma maquina
   * era mandar el archivo a internet para traerlo de vuelta.
   */
  /**
   * Drive en vivo: la app de Google con la que se habla.
   *
   * El `GOOGLE_CLIENT_ID` es PUBLICO —el navegador lo recibe en el config del
   * panel— y el secret NO: es lo que canjea el codigo de OAuth por el refresh
   * token, o sea la mitad de la credencial permanente de una cuenta personal.
   *
   * Los dos son opcionales JUNTOS: sin ellos las herramientas de Drive no se
   * registran y todo lo demas anda igual. Ver
   * `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.
   */
  GOOGLE_CLIENT_ID: opcional(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: opcional(z.string().min(1)),
  /**
   * Supabase, para que una corrida deje la base creada y migrada.
   *
   * `SUPABASE_ACCESS_TOKEN` es el token de ADMINISTRACION (el de
   * supabase.com/dashboard/account/tokens), no la anon ni la service_role de un
   * proyecto: con el se crean proyectos. Vive aca y en ningun otro lado — el
   * agente no tiene salida a internet, asi que el pasamanos va agente ->
   * gateway -> bridge y recien este proceso habla con Supabase.
   *
   * Los dos son opcionales JUNTOS: sin ellos las herramientas contestan que no
   * hay Supabase configurado y todo lo demas anda igual.
   */
  SUPABASE_ACCESS_TOKEN: opcional(z.string().min(1)),
  /**
   * La organizacion de Supabase, por su id.
   *
   * Acepta la URL del panel y le saca el id, porque es lo que uno tiene en el
   * portapapeles: la pantalla de la org es
   * `supabase.com/dashboard/org/<id>/general`, y copiar de ahi es mas natural
   * que buscar el id suelto.
   *
   * Sin esto, pegar la URL daba un 400 de Supabase —"Invalid organization
   * slug"— recien al crear el primer proyecto, o sea a mitad de una corrida y
   * varias horas despues de configurarlo. Paso exactamente eso.
   */
  SUPABASE_ORG_ID: opcional(
    z.string().min(1).transform((v) => {
      const m = /\/org\/([A-Za-z0-9_-]+)/.exec(v);
      return m ? m[1]! : v.trim();
    }),
  ),
  /**
   * Por que dominio ven el panel las personas.
   *
   * Distinto de `PANEL_URL`, que es la direccion INTERNA del compose: un link
   * que se manda a un chat lo abre alguien desde su telefono, y
   * `http://panel:8091` ahi no resuelve. Sin esto no se pueden armar links de
   * "pedir acceso".
   */
  PANEL_PUBLIC_URL: opcional(z.string().url()),
  DOCS_ROOT: z.string().min(1).default('/srv/docs'),
  PORT: z.coerce.number().int().positive().default(3000),
  RENDER_API_KEY: opcional(z.string().min(1)),
  RENDER_OWNER_ID: opcional(z.string().min(1)),
  GATEWAY_ADMIN_TOKEN: opcional(z.string().min(16)),
  /** Con qué se cifran los tokens de Render/Vercel/Netlify/Railway. Sin ella, se deriva del BRIDGE_API_TOKEN. */
  CONEXIONES_CLAVE: opcional(z.string().min(16)),
  /**
   * El VPS (Coolify) donde Punchi publica por defecto. Ver `vps.ts`.
   *
   * Sin `COOLIFY_TOKEN` el VPS no existe para el sistema y todo publica como
   * antes. `COOLIFY_URL` va por Tailscale: el panel de Coolify no esta abierto
   * a internet.
   */
  COOLIFY_URL: opcional(z.string().url()),
  COOLIFY_TOKEN: opcional(z.string().min(16)),
  COOLIFY_SERVIDOR: opcional(z.string().min(8)),
  /** `owner=uuid,owner=uuid`: que GitHub App de Coolify ve cada cuenta/org. */
  COOLIFY_GITHUB_APPS: opcional(z.string().min(3)),
  /** `mc-uso` en el VPS: memoria y disco para el freno. */
  VPS_USO_URL: opcional(z.string().url()),
  VPS_USO_TOKEN: opcional(z.string().min(16)),
  /** Usuarios (uuid, separados por coma) que administran el VPS: ven todo lo que corre ahi. */
  VPS_ADMINS: opcional(z.string().min(36)),
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
  '020_cola.sql',
  '021_consumo.sql',
  '022_google_drive.sql',
  '023_corridas.sql',
  '024_repos_referencia.sql',
  '025_borrador.sql',
  '026_pendientes.sql',
  '027_borrador_org.sql',
  '028_preguntas.sql',
  '029_org_de_corridas.sql',
  '030_borrador_paso_org.sql',
  '031_deploy.sql',
  '032_veredictos.sql',
  '033_contrato.sql',
  '034_render_url.sql',
  '035_cortada.sql',
  '036_resultado.sql',
  '037_fichas.sql',
  '038_agentes_bot.sql',
  '039_despliegue.sql',
  '040_empresas.sql',
  '041_claudes_y_grupos.sql',
  '042_invitaciones_y_compartir.sql',
  '043_cuenta_demo.sql',
  '044_corrida_en_revision.sql',
  '045_agentes_borrar.sql',
  '046_agentes_sin_bot.sql',
  '047_errores.sql',
  '048_borrar_agente_solo_duenio.sql',
  '049_vps.sql',
].map((f) => fileURLToPath(new URL('../migrations/' + f, import.meta.url)));
const store = await PgStore.connect(env.DATABASE_URL, MIGRACIONES);

/**
 * Lo que necesita `vps.ts`, o `undefined` si el VPS no esta configurado.
 *
 * `githubToken` es el de la instalacion del proyecto: con el se escriben el
 * Dockerfile y el config del front. Sin el se publica igual, sin esos arreglos.
 */
function depsDeVps(githubToken?: string, esperarMs = 0, proyectoId?: string): VpsDeps | undefined {
  if (!env.COOLIFY_URL || !env.COOLIFY_TOKEN || !env.COOLIFY_SERVIDOR) return undefined;
  const githubApps: Record<string, string> = {};
  for (const par of (env.COOLIFY_GITHUB_APPS ?? '').split(',')) {
    const [owner, uuid] = par.split('=').map((x) => x.trim());
    if (owner && uuid) githubApps[owner.toLowerCase()] = uuid;
  }
  const gh = githubToken ? { token: githubToken } : undefined;
  return {
    config: {
      coolify: { url: env.COOLIFY_URL, token: env.COOLIFY_TOKEN, servidor: env.COOLIFY_SERVIDOR },
      githubApps,
      clave: claveDe(env.CONEXIONES_CLAVE ?? env.BRIDGE_API_TOKEN),
    },
    store,
    ...(env.VPS_USO_URL && env.VPS_USO_TOKEN
      ? { uso: () => usoDelVps({ url: env.VPS_USO_URL!, token: env.VPS_USO_TOKEN! }) }
      : {}),
    ...(gh
      ? {
          asegurarDockerfileBack: (repo: string) => asegurarDockerfile(repo, gh),
          asegurarDockerfileFront: (repo: string) => asegurarDockerfileDeFront(repo, gh),
          asegurarOutputPath: (repo: string) => asegurarOutputPathDeAngular(repo, gh),
          reescribirConfig: (repo: string, url: string) =>
            reescribirConfig(repo, url, {
              leer: (r, ruta) => leerArchivo(r, ruta, gh),
              escribir: (r, ruta, texto, sha, mensaje) => escribirArchivo(r, ruta, texto, sha, mensaje, gh),
            }),
        }
      : {}),
    esperarMs,
    ...(proyectoId ? { humo: (backUrl: string) => humoDe(proyectoId, backUrl) } : {}),
  };
}

/**
 * La prueba de humo del back publicado de un proyecto (ver `humo.ts`): con el
 * contrato y el pliego de la ultima corrida del DUEÑO sobre ese proyecto —la
 * corrida guarda el nombre, no el id, y otro usuario puede tener uno que se
 * llame igual— y la cuenta de demo si la hay.
 */
async function humoDe(proyectoId: string, backUrl: string): Promise<ResultadoDeHumo | undefined> {
  const [nombre, dueno] = await Promise.all([
    store.nombreDeProyecto(proyectoId).catch(() => undefined),
    store.duenoDeProyecto(proyectoId).catch(() => undefined),
  ]);
  if (!nombre || !dueno) return undefined;
  const corrida = (await store.corridasDeUsuario(dueno, 30).catch(() => [])).find(
    (c) => c.proyecto === nombre && c.contrato,
  );
  if (!corrida) return undefined;
  const c = await store.cuentaDemo(proyectoId).catch(() => undefined);
  let demo: { email: string; password: string } | undefined;
  try {
    if (c) demo = { email: c.usuario, password: descifrar(c.passwordCifrada, claveDe(env.CONEXIONES_CLAVE ?? env.BRIDGE_API_TOKEN)) };
  } catch {
    demo = undefined;
  }
  return probarEnVivo({ backUrl, contrato: corrida.contrato, md: corrida.md, ...(demo ? { demo } : {}), hoy: new Date() });
}

/** El token de la App de GitHub del proyecto, o undefined. */
async function githubTokenDe(proyectoId: string): Promise<string | undefined> {
  const instalacion = await store.instalacionDeProyecto(proyectoId).catch(() => undefined);
  return instalacion !== undefined && env.PANEL_URL
    ? await firmarToken(instalacion, { panelUrl: env.PANEL_URL, token: env.BRIDGE_API_TOKEN }).catch(() => undefined)
    : undefined;
}
// La misma conexion que el store: la tabla `errores` es de la 047.
registroDeErrores = new PgRegistroDeErrores(store.consulta);

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
const docsDeps = {
  // Las dos claves de Supabase quedaron sin uso en este camino y se dejan por
  // compatibilidad del tipo: el archivo va al disco y la fila va por el store,
  // que se conecta a la misma base como `postgres`.
  supabaseUrl: (env.SUPABASE_URL ?? '').replace(/\/$/, ''),
  serviceKey: env.SUPABASE_SERVICE_KEY ?? '',
  conversorUrl: env.CONVERSOR_URL,
  docsRaiz: env.DOCS_ROOT,
  crearDir: async (ruta: string) => {
    await mkdir(ruta, { recursive: true });
  },
  escribir: async (ruta: string, datos: Uint8Array) => {
    await writeFile(ruta, datos);
  },
  guardarFila: (fila: FilaDeDocumento) => store.guardarDocumento(fila),
};
// Para el análisis funcional: el PDF lee las capturas ya guardadas del disco.
const analisisDeps = {
  ...docsDeps,
  leer: async (ruta: string) => new Uint8Array(await readFile(`${env.DOCS_ROOT}/${ruta}`)),
};

// El aviso de "sin SUPABASE_SERVICE_KEY no se pueden guardar documentos" se
// fue: ya no es cierto. El archivo va al disco y la fila por el store, asi que
// los documentos andan sin esa clave — que es lo que los tenia apagados
// enteros, tanto los del panel como los del bot.
if (!env.CONVERSOR_URL) {
  // Lo unico que sigue siendo una funcionalidad a medias: sin conversor, un PDF
  // se guarda pero el agente no lo puede LEER —solo citarlo—, porque lo que lee
  // es la version en Markdown.
  console.warn('[bridge] sin CONVERSOR_URL: los documentos se guardan sin convertir a texto');
}

// Un aviso al arrancar y no un error al usarlo: configurar dos de las tres es
// un error de despliegue, y el sintoma sin esto seria un agente diciendo "esa
// herramienta no esta habilitada" sin que nadie sepa por que.
const faltanDeDrive = (
  [
    ['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID],
    ['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET],
    ['PANEL_PUBLIC_URL', env.PANEL_PUBLIC_URL],
  ] as const
).filter(([, v]) => !v);
if (faltanDeDrive.length > 0 && faltanDeDrive.length < 3) {
  console.warn(
    `[bridge] Drive apagado: falta ${faltanDeDrive.map(([k]) => k).join(', ')}`,
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
  // `quien` se pasa: sin él el gateway toma el slot como de un desconocido, y
  // tu propio turno siguiente rebota con agente_ocupado en vez de esperar.
  ask: (req: Parameters<typeof askAgent>[0], quien: Parameters<typeof askAgent>[2]) =>
    askAgent(req, gatewayDeps, quien),
  // El aviso de trabajo en curso (parte C de empresas). `/trabajo` es ruta de
  // admin del gateway: sin ese token no hay aviso y el turno sigue igual.
  trabajoEnCurso: env.GATEWAY_ADMIN_TOKEN
    ? (repos: string[]) =>
        trabajoEnGateway(repos, { gatewayUrl: env.GATEWAY_URL, adminToken: env.GATEWAY_ADMIN_TOKEN! })
    : undefined,
  // Sin PANEL_URL no se pasa la funcion: `tokenDelProyecto` la trata como
  // ausente y devuelve undefined, que es el camino SSH.
  firmarToken: env.PANEL_URL
    ? (id: number) =>
        firmarToken(id, { panelUrl: env.PANEL_URL!, token: env.BRIDGE_API_TOKEN })
    : undefined,
  // Igual que arriba: sin PANEL_URL no hay quien firme, y `/corrida` lo dice en
  // vez de crear un proyecto sin los repos que se le pidieron.
  crearRepo: env.PANEL_URL
    ? (id: number, nombre: string, descripcion?: string, publico?: boolean) =>
        crearRepo(
          id,
          nombre,
          descripcion,
          {
            panelUrl: env.PANEL_URL!,
            token: env.BRIDGE_API_TOKEN,
          },
          // `?? false`: si el llamador no lo dice, privado. Se publica en el
          // VPS, que clona con su app de GitHub (2026-10-09).
          publico ?? false,
        )
    : undefined,
  /**
   * El cierre publica: mergea a main y crea el servicio en Render.
   *
   * Se cablea SOLO con las dos variables. Sin ellas el pipeline no recibe la
   * dependencia y el sistema se comporta exactamente como antes — el informe
   * vuelve a terminar en "conectalo a mano", que es el piso de esta feature.
   *
   * Este adaptador existe para traducir: el pipeline tiene una corrida y
   * `publicar()` quiere el id del proyecto y los agentes. Traducir aca deja al
   * pipeline sin tener que aprender de donde sale cada cosa.
   */
  // Sin Render del sistema igual se publica: los repos con app elegida van a
  // la cuenta de la persona. Sin GATEWAY_ADMIN_TOKEN no hay merge, y sin merge
  // no hay nada que publicar.
  publicar:
    env.GATEWAY_ADMIN_TOKEN
      ? async (corrida: Corrida, agentes: readonly string[]) => {
          const proyectoId = await store.idDeProyecto(corrida.proyecto);
          // Sin proyecto en la base no hay repos que publicar. Pasa cuando la
          // corrida se armo por un camino que no creo el proyecto.
          if (!proyectoId) return { publicados: [], pendientes: [] };

          const admin = {
            gatewayUrl: env.GATEWAY_URL,
            adminToken: env.GATEWAY_ADMIN_TOKEN!,
          };
          // El token de GitHub sale de la instalacion de la App, no de una
          // variable: es de una cuenta, y el gateway lo necesita para pushear
          // main. En el merge SI viaja en el cuerpo porque `TokenDelTurno` esta
          // vacio — no hay ningun turno en vuelo cuando la corrida cierra.
          const instalacion = await store.instalacionDeProyecto(proyectoId);
          const githubToken =
            instalacion !== undefined && env.PANEL_URL
              ? await firmarToken(instalacion, {
                  panelUrl: env.PANEL_URL,
                  token: env.BRIDGE_API_TOKEN,
                })
              : undefined;

          // Con las cuentas del DUEÑO del proyecto, no de quien abrió la corrida.
          const dueno = await store.duenoDeProyecto(proyectoId).catch(() => undefined);
          const conexiones = dueno ? await store.conexionesDeDespliegue(dueno).catch(() => []) : [];
          // El cierre espera los armados (hasta 20 min): asi el informe dice
          // si el link anda, y no solo que se pidio.
          const vps = depsDeVps(githubToken, 20 * 60_000, proyectoId);
          return publicar(proyectoId, corrida.proyecto, agentes, {
            store,
            ...(vps ? { enVps: (repos) => publicarEnVps(proyectoId, corrida.proyecto, repos, vps) } : {}),
            enDestino: (repo) =>
              aDestino(repo, conexiones, proyectoId, {
                store,
                clave: claveDe(env.CONEXIONES_CLAVE ?? env.BRIDGE_API_TOKEN),
              }),
            render: { apiKey: env.RENDER_API_KEY, ownerId: env.RENDER_OWNER_ID },
            mergear: (req) => mergearEnGateway(req, githubToken, admin),
            // El `agent` viene de arriba y no se cierra aca: el worktree es de
            // un slot, y con varios hay que poder preguntar por cada uno.
            // Preguntarle al equivocado es el bug que esto arregla.
            tienePackageJson: async (agent, project, repo) =>
              (await inspeccionarRepo({ agent, project, repo }, admin)).tienePackageJson,
            usaSqlite: async (agent, project, repo) =>
              (await inspeccionarRepo({ agent, project, repo }, admin)).usaSqlite,
            // Render no trae runtime de .NET: sin Dockerfile el back no se
            // puede desplegar. Lo escribe el sistema, que sabe exactamente como
            // tiene que ser, en vez de pedirselo al modelo en un turno.
            // Sin token no hay a quien pedirle: se omite y el flujo queda como
            // estaba, igual que `reescribirConfig` mas abajo.
            ...(githubToken
              ? {
                  asegurarDockerfile: (githubRepo: string) =>
                    asegurarDockerfile(githubRepo, { token: githubToken }),
                  // `@angular/build:application` anida el sitio bajo
                  // `dist/<proyecto>/browser/` y Render publica `dist/` a
                  // secas: sin esto el front puede quedar publicado y vacio.
                  // Mismo criterio que el Dockerfile de arriba.
                  asegurarOutputPathDeAngular: (githubRepo: string) =>
                    asegurarOutputPathDeAngular(githubRepo, { token: githubToken }),
                }
              : {}),
            // La conexion a la base la escribio el bridge al crear el proyecto
            // de Supabase; aca se la carga al servicio del back.
            conexionDeBase: (proyectoId: string) => store.conexionDeBase(proyectoId),
            // Sin script `start`, Render no puede arrancar el servicio: mejor
            // no crearlo y decirlo, que dejar uno roto ocupando el nombre.
            puedeArrancar: async (agent, project, repo) =>
              (await inspeccionarRepo({ agent, project, repo }, admin)).tieneStart,
            // El deploy de un servicio que ya existe. Los servicios se crean
            // con `autoDeploy: 'no'` porque con un repo publico Render no se
            // entera de los push, asi que el que dispara es el sistema.
            desplegar: (serviceId) =>
              dispararDeploy(serviceId, {
                apiKey: env.RENDER_API_KEY,
                ownerId: env.RENDER_OWNER_ID,
              }),
            // Para que el front sepa donde quedo el back. Lee las variables que
            // el servicio ya tiene antes de escribir: el PUT de Render reemplaza
            // la lista entera.
            setearEnvVar: (serviceId, clave, valor, opciones) =>
              setearEnvVar(
                serviceId,
                clave,
                valor,
                { apiKey: env.RENDER_API_KEY, ownerId: env.RENDER_OWNER_ID },
                opciones,
              ),
            // El respaldo de la variable: el config.js del front. Con el mismo
            // token de la App que pushea main; sin token no hay con que
            // escribir, y se conecta solo por entorno, como antes.
            ...(githubToken
              ? {
                  reescribirConfig: (githubRepo: string, url: string) =>
                    reescribirConfig(githubRepo, url, {
                      leer: (repo, ruta) => leerArchivo(repo, ruta, { token: githubToken }),
                      escribir: (repo, ruta, texto, sha, mensaje) =>
                        escribirArchivo(repo, ruta, texto, sha, mensaje, { token: githubToken }),
                    }),
                }
              : {}),
          });
        }
      : undefined,
  /**
   * El merge de CADA tarea a main, que es lo que hace posible repartir la cola.
   *
   * Se cablea solo con `GATEWAY_ADMIN_TOKEN`, igual que `publicar`, y por la
   * misma razon: `/git/merge` va con el bearer de admin, no con el del agente.
   * Sin el, el pipeline no reparte — repartir sin mergear dejaria a cada slot
   * construyendo sobre un main viejo.
   *
   * Ver
   * `multicodigo-vm/docs/superpowers/specs/2026-09-09-reparto-por-capacidad-design.md`.
   */
  mergearTrabajo: env.GATEWAY_ADMIN_TOKEN
    ? async (proyecto: string, agente: string) => {
        const proyectoId = await store.idDeProyecto(proyecto);
        if (!proyectoId) return { ok: false, detalle: 'el proyecto no esta en la base' };

        const admin = { gatewayUrl: env.GATEWAY_URL, adminToken: env.GATEWAY_ADMIN_TOKEN! };
        const instalacion = await store.instalacionDeProyecto(proyectoId);
        const githubToken =
          instalacion !== undefined && env.PANEL_URL
            ? await firmarToken(instalacion, {
                panelUrl: env.PANEL_URL,
                token: env.BRIDGE_API_TOKEN,
              })
            : undefined;

        // TODOS los repos que creo el bot, no solo el que la tarea toco: el
        // bridge no sabe cual fue —el modelo elige donde escribe— y sobre un
        // repo que no cambio el `--ff-only` es "Already up to date", o sea
        // gratis. Los que conecto una persona no se tocan nunca.
        //
        // En serie, por la misma razon que el resto de los bucles de repos: si
        // el segundo falla, el primero ya entro y el detalle puede nombrarlo.
        const fallos: string[] = [];
        for (const repo of await store.reposDeProyecto(proyectoId)) {
          if (!repo.creado_por_el_bot) continue;
          const m = await mergearEnGateway(
            { agent: agente, project: proyecto, repo: repo.nombre, creadoPorElBot: true },
            githubToken,
            admin,
          );
          if (!m.ok) fallos.push(`${repo.nombre}: ${m.output}`);
        }
        // Si CUALQUIERA fallo se devuelve el fallo: main quedo sin parte del
        // trabajo, y el pipeline tiene que dejar de rotar para que la tarea que
        // viene no se construya sobre eso.
        return fallos.length === 0
          ? { ok: true }
          : { ok: false, detalle: fallos.join(' · ') };
      }
    : undefined,
  /**
   * Guardar lo que dejo un turno cortado por tiempo.
   *
   * Mismo cableado y misma puerta que `mergearTrabajo`: sale por
   * `GATEWAY_ADMIN_TOKEN` porque commitea y pushea con el token de GitHub que
   * firma el bridge, no con el del turno —que a esa altura ya no existe—.
   */
  guardarTrabajo: env.GATEWAY_ADMIN_TOKEN
    ? async (proyecto: string, agente: string, mensaje: string) => {
        const proyectoId = await store.idDeProyecto(proyecto);
        if (!proyectoId) return { ok: false, detalle: 'el proyecto no esta en la base', commiteo: false };

        const admin = { gatewayUrl: env.GATEWAY_URL, adminToken: env.GATEWAY_ADMIN_TOKEN! };
        const instalacion = await store.instalacionDeProyecto(proyectoId);
        const githubToken =
          instalacion !== undefined && env.PANEL_URL
            ? await firmarToken(instalacion, {
                panelUrl: env.PANEL_URL,
                token: env.BRIDGE_API_TOKEN,
              })
            : undefined;

        // Todos los repos del bot, como en el merge: el bridge no sabe en cual
        // escribio el modelo, y sobre uno que no cambio esto es un status
        // limpio y un push que no manda nada.
        const fallos: string[] = [];
        let commiteo = false;
        for (const repo of await store.reposDeProyecto(proyectoId)) {
          if (!repo.creado_por_el_bot) continue;
          const g = await guardarEnGateway(
            { agent: agente, project: proyecto, repo: repo.nombre, message: mensaje },
            githubToken,
            admin,
          );
          if (g.commiteo) commiteo = true;
          if (!g.ok) fallos.push(`${repo.nombre}: ${g.output}`);
        }
        return fallos.length === 0
          ? { ok: true, commiteo }
          : { ok: false, detalle: fallos.join(' · '), commiteo };
      }
    : undefined,
  transcribe: (bytes: Uint8Array, mimeType: string) =>
    transcribeAudio(bytes, mimeType, { apiKey: env.GEMINI_API_KEY }),
  // Los documentos ya no se pasan: el pipeline los lee del store, que se
  // conecta a la misma base como `postgres`. Antes iban por la API REST de
  // Supabase con la service_role, y sin esa clave quedaban apagados enteros.
  listarAgentes: () => listarAgentes(gatewayDeps),
  /**
   * La app desplegada, al final de cada ronda.
   *
   * Los tests en verde no dicen que la app levante: en `Hoteleria`
   * (2026-09-20) las tareas del login, del CORS y del despliegue figuraban
   * todas hechas y no se podia entrar. Esto le pide la pagina a la URL
   * publica y, si no responde, lo devuelve como trabajo.
   */
  vpsPorDefecto: Boolean(depsDeVps()),
  verificarApp: async (proyectoId: string) => {
    const repos = await store.reposDeProyecto(proyectoId).catch(() => []);
    const problemas = await verificarDespliegue(
      repos
        .filter((r) => r.render_service_id || r.render_url || r.destino_url)
        .map((r) => ({
          nombre: r.nombre,
          // El estado del deploy solo se le pregunta a Render; en el VPS (o en
          // otra app) alcanza con que la URL responda.
          ...(r.render_service_id && !r.destino ? { serviceId: r.render_service_id } : {}),
          ...((r.destino_url ?? r.render_url) ? { url: (r.destino_url ?? r.render_url)! } : {}),
        })),
      {
        estadoDeDeploy: (serviceId: string) =>
          ultimoDeploy(serviceId, {
            apiKey: env.RENDER_API_KEY,
            ownerId: env.RENDER_OWNER_ID,
          }),
      },
    );
    return problemas.map((p) => ({ resumen: p.resumen, tarea: tareaDeProblema(p) }));
  },
  // Para poder decir POR QUE un slot esta ocupado: un turno frenado esperando
  // un OK se destraba con un toque de la otra persona, y uno trabajando hay que
  // esperarlo. Es el mismo fetchPending del poller de aprobaciones.
  pendientesDe: (agent: AgentId) => fetchPending(agent, gatewayDeps),
};

/**
 * Las dependencias del bot, en una constante.
 *
 * Salieron del llamado a `buildBot` porque `retomarCorridas` necesita LAS
 * MISMAS: retomar una corrida corre el mismo bucle de cola que un mensaje, con
 * los mismos agentes y el mismo store. Armarlas dos veces era la unica forma de
 * que se separen.
 */
const botDeps = {
  ...pipelineDeps,
  botToken: env.TELEGRAM_BOT_TOKEN,
  // Se consulta al arrancar, antes de retomar una corrida: un deploy recrea
  // el stack y el bridge vuelve antes que el gateway. Ver `esperarAlGateway`.
  gatewayListo: () => esperarAlGateway(gatewayDeps),
  fetchPending: (agent: AgentId) => fetchPending(agent, gatewayDeps),
  sendDecision: (
    agent: AgentId,
    approvalId: string,
    decision: Parameters<typeof sendDecision>[2],
  ) => sendDecision(agent, approvalId, decision, gatewayDeps),
  // Siempre, ya no condicionado a tener la service_role: el archivo va al
  // disco y la fila por el store.
  guardarDocumento: (entrada: Parameters<typeof guardarDocumento>[0]) =>
    guardarDocumento(entrada, docsDeps),
};

const bot = buildBot(botDeps);

await bot.init(); // necesario antes de handleUpdate cuando no se usa bot.start()

/**
 * El despliegue a la app de cada persona. Ver `publicar-ticket.ts`.
 *
 * El merge a main va por la puerta de admin del gateway, igual que el de las
 * corridas: sin `GATEWAY_ADMIN_TOKEN` se puede conectar cuentas y elegir apps,
 * pero publicar contesta que falta configurarlo.
 */
function despliegueDelPanel() {
  const clave = claveDe(env.CONEXIONES_CLAVE ?? env.BRIDGE_API_TOKEN);
  // Del DUEÑO y no de cualquier miembro: publicar pasa ramas a main y usa las
  // cuentas de despliegue del dueño.
  const puedeEscribir = async (usuarioId: string, proyectoId: string) =>
    (await store.proyectosDeUsuario(usuarioId)).some((x) => x.id === proyectoId);
  const esSuyo = async (usuarioId: string, proyectoId: string) =>
    (await store.duenoDeProyecto(proyectoId)) === usuarioId
      ? (await store.proyectosDeUsuario(usuarioId)).find((x) => x.id === proyectoId)
      : undefined;

  return {
    conexiones: async (usuarioId: string) =>
      (await store.conexionesDeDespliegue(usuarioId)).map((c) => ({
        proveedor: c.proveedor,
        cuenta: c.cuenta,
        creadoEn: c.creadoEn,
      })),
    conectar: async (
      usuarioId: string,
      proveedor: Parameters<typeof verificar>[0],
      token: string,
      extra: Record<string, string>,
    ) => {
      const v = await verificar(proveedor, token, extra);
      if (!v.ok) return v;
      await store.guardarConexionDeDespliegue(usuarioId, {
        proveedor,
        tokenCifrado: cifrar(token, clave),
        extra: v.extra,
        cuenta: v.cuenta,
      });
      return { ok: true as const, cuenta: v.cuenta };
    },
    desconectar: (usuarioId: string, proveedor: Parameters<typeof verificar>[0]) =>
      store.borrarConexionDeDespliegue(usuarioId, proveedor),
    elegirDestino: async (
      usuarioId: string,
      proyectoId: string,
      repo: string,
      destino: Destino | null,
    ) => {
      if (!(await esSuyo(usuarioId, proyectoId))) return { ok: false as const, motivo: 'solo el dueño del proyecto elige dónde se publica' };
      if (!(await store.reposDeProyecto(proyectoId)).some((x) => x.nombre === repo)) {
        return { ok: false as const, motivo: 'ese repo no está en el proyecto' };
      }
      await store.guardarDestino(proyectoId, repo, destino);
      return { ok: true as const };
    },
    publicar: async (usuarioId: string, proyectoId: string, agente: string, explicito: boolean) => {
      const proyecto = await esSuyo(usuarioId, proyectoId);
      if (!proyecto) return { ok: false as const, motivo: 'solo el dueño del proyecto puede publicar' };
      if (!env.GATEWAY_ADMIN_TOKEN) return { ok: false as const, motivo: 'este servidor no puede pasar ramas a main (falta GATEWAY_ADMIN_TOKEN)' };
      const admin = { gatewayUrl: env.GATEWAY_URL, adminToken: env.GATEWAY_ADMIN_TOKEN };
      const instalacion = await store.instalacionDeProyecto(proyectoId);
      const githubToken =
        instalacion !== undefined && env.PANEL_URL
          ? await firmarToken(instalacion, { panelUrl: env.PANEL_URL, token: env.BRIDGE_API_TOKEN })
          : undefined;
      const resultado = await publicarCambios(
        { usuarioId, proyectoId, proyecto: proyecto.nombre, agente, explicito },
        {
          store,
          clave,
          mergear: (req) => mergearEnGateway(req, githubToken, admin),
          ...(env.RENDER_API_KEY
            ? { renderDelSistema: { apiKey: env.RENDER_API_KEY, ...(env.RENDER_OWNER_ID ? { ownerId: env.RENDER_OWNER_ID } : {}) } }
            : {}),
        },
      );
      // Lo que pasó a main lleva los arreglos de errores que hizo este agente
      // en este proyecto: dejan de ofrecer "Publicar".
      if (resultado.mergeados?.length && registroDeErrores) {
        await registroDeErrores
          .marcarPublicados(proyectoId, agente)
          .then((ids) => {
            if (ids.length) console.log(`[bridge] errores ya en main con la rama de ${agente}: #${ids.join(', #')}`);
          })
          .catch((err: unknown) => console.error('[bridge] no pude marcar los errores publicados:', err));
      }
      const texto = textoDePublicacion(resultado);
      // La publicación automática no tiene a nadie mirando el panel: el
      // resultado va al Telegram vinculado, si hay.
      if (!explicito) {
        const [chat] = await store.chatsDeUsuario(usuarioId).catch(() => [] as number[]);
        if (chat !== undefined) {
          await bot.api
            .sendMessage(chat, `📦 ${proyecto.nombre}\n${texto}`)
            .catch((err: unknown) => console.error('[bridge] no pude avisar la publicacion:', err));
        }
      }
      return { ok: true as const, resultado, texto };
    },
    desplegar: async (usuarioId: string, proyectoId: string, repo: string) => {
      // Del dueño, como publicar: despliega con SUS cuentas.
      const proyecto = await esSuyo(usuarioId, proyectoId);
      if (!proyecto) return { ok: false as const, motivo: 'solo el dueño del proyecto puede desplegar' };
      const fila = (await store.reposDeProyecto(proyectoId)).find((r) => r.nombre === repo);
      const vps = depsDeVps(await githubTokenDe(proyectoId));
      if (fila && vps && (fila.destino === 'vps' || (!fila.destino && !fila.render_service_id))) {
        // En el VPS el proyecto se publica entero: el front necesita al back y
        // el back a su base.
        const r = await publicarEnVps(proyectoId, proyecto.nombre, await store.reposDeProyecto(proyectoId), vps);
        const url = r.publicados.find((x) => x.repo === repo)?.url;
        return url
          ? { ok: true as const, url, app: 'VPS' }
          : { ok: false as const, motivo: r.pendientes.join('; ') || `${repo} no se publicó en el VPS` };
      }
      return desplegarRepo(usuarioId, proyectoId, repo, {
        store,
        clave,
        ...(env.RENDER_API_KEY
          ? { renderDelSistema: { apiKey: env.RENDER_API_KEY, ...(env.RENDER_OWNER_ID ? { ownerId: env.RENDER_OWNER_ID } : {}) } }
          : {}),
      });
    },
    /**
     * El VPS de un proyecto, desde Repositorios. Solo el dueño, como publicar.
     * Apagar y borrar existen SOLO aca: ni los agentes ni las corridas los tienen.
     */
    vps: {
      estado: async (usuarioId: string, proyectoId: string) => {
        if (!(await esSuyo(usuarioId, proyectoId))) return { ok: false as const, motivo: 'solo el dueño del proyecto' };
        const vps = depsDeVps(undefined, 0, proyectoId);
        if (!vps) return { ok: true as const, estado: { configurado: false, partes: [], otros: [] } };
        const demo = (await store.demosPorVencer(24 * 400).catch(() => [])).find((d) => d.proyectoId === proyectoId);
        return {
          ok: true as const,
          estado: {
            ...(await estadoEnVps(proyectoId, vps, {
              conOtros: (env.VPS_ADMINS ?? '').split(',').map((x) => x.trim()).includes(usuarioId),
            })),
            ...(demo ? { demoApagarEl: demo.apagarEl } : {}),
          },
        };
      },
      publicar: async (usuarioId: string, proyectoId: string) => {
        const proyecto = await esSuyo(usuarioId, proyectoId);
        if (!proyecto) return { ok: false as const, motivo: 'solo el dueño del proyecto puede publicar' };
        const vps = depsDeVps(await githubTokenDe(proyectoId));
        if (!vps) return { ok: false as const, motivo: 'el VPS no está configurado en el servidor' };
        const repos = (await store.reposDeProyecto(proyectoId)).filter(
          (r) => !r.solo_lectura && (r.destino === 'vps' || (!r.destino && !r.render_service_id)),
        );
        if (repos.length === 0) return { ok: false as const, motivo: 'ningún repo de este proyecto se publica en el VPS' };
        return { ok: true as const, ...(await publicarEnVps(proyectoId, proyecto.nombre, repos, vps)) };
      },
      apagar: async (usuarioId: string, proyectoId: string) => {
        if (!(await esSuyo(usuarioId, proyectoId))) return { ok: false as const, motivo: 'solo el dueño del proyecto puede apagar' };
        const vps = depsDeVps();
        if (!vps) return { ok: false as const, motivo: 'el VPS no está configurado en el servidor' };
        const r = await apagarEnVps(proyectoId, vps);
        return r.ok ? { ok: true as const } : { ok: false as const, motivo: r.pendientes.join('; ') };
      },
      borrar: async (usuarioId: string, proyectoId: string, confirmacion: string) => {
        const proyecto = await esSuyo(usuarioId, proyectoId);
        if (!proyecto) return { ok: false as const, motivo: 'solo el dueño del proyecto puede borrar' };
        const vps = depsDeVps();
        if (!vps) return { ok: false as const, motivo: 'el VPS no está configurado en el servidor' };
        const r = await borrarDelVps(proyectoId, proyecto.nombre, confirmacion, vps);
        return r.ok ? { ok: true as const } : { ok: false as const, motivo: r.pendientes.join('; ') };
      },
      /** Una demo que se queda prendida: deja de apagarse sola. */
      mantener: async (usuarioId: string, proyectoId: string) => {
        if (!(await esSuyo(usuarioId, proyectoId))) return { ok: false as const, motivo: 'solo el dueño del proyecto' };
        await store.guardarDemoApagarEl(proyectoId, null);
        return { ok: true as const };
      },
    },
    /**
     * La cuenta de demo de un proyecto (043): la carga quien puede ESCRIBIR en
     * el, no solo el dueño — el que pide el ticket es el que sabe con que
     * cuenta se ve su cambio. La contraseña nunca vuelve al panel.
     */
    cuentaDemo: async (usuarioId: string, proyectoId: string) => {
      if (!(await puedeEscribir(usuarioId, proyectoId))) return undefined;
      const c = await store.cuentaDemo(proyectoId);
      return { cuenta: c ? { ruta: c.ruta, usuario: c.usuario } : null };
    },
    guardarCuentaDemo: async (
      usuarioId: string,
      proyectoId: string,
      c: { ruta: string; usuario: string; password: string },
    ) => {
      if (!(await puedeEscribir(usuarioId, proyectoId))) return false;
      await store.guardarCuentaDemo(
        proyectoId,
        { ruta: c.ruta, usuario: c.usuario, passwordCifrada: cifrar(c.password, clave) },
        usuarioId,
      );
      return true;
    },
    borrarCuentaDemo: async (usuarioId: string, proyectoId: string) => {
      if (!(await puedeEscribir(usuarioId, proyectoId))) return false;
      await store.borrarCuentaDemo(proyectoId);
      return true;
    },
    publicadosDe: async (proyecto: string) => {
      const id = await store.idDeProyecto(proyecto);
      if (!id) return [];
      const repos = await store.reposDeProyecto(id);
      return repos
        .filter((r) => !r.solo_lectura)
        .map((r) => r.destino_url ?? r.render_url)
        .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'));
    },
    /** Para el gateway (`mirar`), por nombre de proyecto: con la contraseña en claro. */
    loginDeDemo: async (proyecto: string) => {
      const id = await store.idDeProyecto(proyecto);
      const c = id ? await store.cuentaDemo(id) : undefined;
      if (!c) return undefined;
      try {
        return { ruta: c.ruta, email: c.usuario, password: descifrar(c.passwordCifrada, clave) };
      } catch (err) {
        console.error('[bridge] no pude descifrar la cuenta de demo de', proyecto, err);
        return undefined;
      }
    },
  };
}

export const app = buildWebhookServer(bot, env.TELEGRAM_WEBHOOK_SECRET, {
  store,
  apiToken: env.BRIDGE_API_TOKEN,
  errores: registroDeErrores,
  finanzas: {
    // Los de la máquina con cuenta: en este servidor todos son de Gero.
    cuentas: async () =>
      (await listarAgentes(gatewayDeps))
        .filter((a) => a.cuenta)
        .map((a) => ({ slot: a.id, arriba: a.arriba, ...(a.cuentaId ? { cuenta: a.cuentaId } : {}) }))
        .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true })),
  },
  // Las demos de Homero avisan en el chat de Punchi como cualquier corrida.
  despliegue: despliegueDelPanel(),
  demos: {
    abrir: (p) =>
      abrirDemo(p, botDeps, async (html) => {
        for (const parte of partirParaTelegram(html)) {
          await bot.api.sendMessage(p.chatId, parte, { parse_mode: 'HTML' });
        }
      }),
    estado: (chatId, id) => estadoDeDemo(chatId, id, botDeps),
    desarrollo: (p) =>
      abrirDesarrollo(p, botDeps, (chatId) => async (html) => {
        for (const parte of partirParaTelegram(html)) {
          await bot.api.sendMessage(chatId, parte, { parse_mode: 'HTML' });
        }
      }),
  },
  // Los documentos que ESCRIBE el agente. Las mismas deps que los que llegan
  // por Telegram: mismo disco, misma tabla, mismo conversor — solo cambia la
  // direccion de la conversion.
  guardarGenerado: (entrada) => guardarDocumentoGenerado(entrada, docsDeps),
  guardarCapturas: (entrada) => guardarCapturas(entrada, docsDeps),
  guardarAnalisis: (entrada) => guardarAnalisis(entrada, analisisDeps),
  nombreDeProyecto: (id) => store.nombreDeProyecto(id),
  /**
   * Drive en vivo, o nada.
   *
   * Las tres variables van JUNTAS: sin el secret no se puede canjear el codigo
   * de OAuth, y sin la URL publica del panel no se puede armar el link de
   * "pedir acceso" — que es lo que convierte el limite de `drive.file` en algo
   * que la persona puede resolver. Con dos de tres, la feature existiria a
   * medias y fallaria recien cuando alguien la use.
   */
  drive:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.PANEL_PUBLIC_URL
      ? {
          drive: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // El MISMO conversor que los documentos: un PDF de Drive y uno
            // mandado por Telegram se leen igual, y fallan con el mismo motivo.
            conversorUrl: env.CONVERSOR_URL,
          },
          panelUrl: env.PANEL_PUBLIC_URL,
        }
      : undefined,
  // Los dos JUNTOS o ninguno, igual que Drive: con el token y sin la org no se
  // puede crear un proyecto, y la feature existiria a medias hasta que alguien
  // la use a las tres de la mañana.
  supabase: {
    ...(env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_ORG_ID
      ? { accessToken: env.SUPABASE_ACCESS_TOKEN, orgId: env.SUPABASE_ORG_ID }
      : {}),
    // Con VPS, la base del proyecto nace en el VPS al publicar: no se crea en
    // Supabase. Un proyecto con repos de Render/Vercel de antes sigue igual.
    ...(depsDeVps()
      ? {
          usaVps: async (jobId: string) => {
            const ctx = await store.contextoDeJob(jobId).catch(() => undefined);
            if (!ctx?.proyectoId) return false;
            const repos = (await store.reposDeProyecto(ctx.proyectoId)).filter((r) => !r.solo_lectura);
            return repos.length > 0 && repos.every((r) => r.destino === 'vps' || (!r.destino && !r.render_service_id));
          },
        }
      : {}),
  },
  registrarClaude: (usuarioId: string, proyectoId: string, slot: string) =>
    store.registrarClaude(usuarioId, proyectoId, slot),
  // El trabajo en curso de la empresa, para la sección "En curso" del panel.
  trabajo: env.GATEWAY_ADMIN_TOKEN
    ? async (usuarioId: string) =>
        trabajoDeMiEmpresa(usuarioId, await store.reposDeMiEmpresa(usuarioId), {
          store,
          trabajoEnCurso: (repos) =>
            trabajoEnGateway(repos, { gatewayUrl: env.GATEWAY_URL, adminToken: env.GATEWAY_ADMIN_TOKEN! }),
        })
    : undefined,
  // Con la service_role, la cuenta se crea por la Admin API (el camino
  // oficial); sin ella, escribiendo en `auth` desde esta misma conexion.
  altas: (token: string, clave: string) =>
    store.darDeAlta(
      token,
      clave,
      env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
        ? crearUsuarioPorApi(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
        : crearUsuarioPorSql,
    ),
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

// Las corridas que quedaron abiertas, retomadas.
//
// DESPUES del listen y sin await: el bucle de una corrida puede durar horas, y
// esperarlo aca dejaria el webhook sin escuchar. Ver `retomarCorridas`.
retomarCorridas(bot, botDeps);

// Las demos de Homero en el VPS: aviso el dia antes y apagado a los 14 dias de
// la reunion. Nunca se borran solas. Cada hora alcanza: el aviso es "mañana".
const vpsParaDemos = depsDeVps();
if (vpsParaDemos) {
  const revisar = () =>
    revisarDemos({
      ...vpsParaDemos,
      demos: store,
      avisar: async ({ proyectoId, texto }) => {
        const dueno = await store.duenoDeProyecto(proyectoId).catch(() => undefined);
        const [chat] = dueno ? await store.chatsDeUsuario(dueno).catch(() => [] as number[]) : [];
        if (chat !== undefined) await bot.api.sendMessage(chat, `🖥️ ${texto}`).catch(() => undefined);
      },
    }).catch((err: unknown) => console.error('[bridge] no pude revisar las demos del VPS:', err));
  setInterval(revisar, 60 * 60_000).unref();
  setTimeout(revisar, 60_000).unref();
}
