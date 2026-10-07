import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';
import { crearApi } from './api.js';
import { buzonGmail, revisarBandejas } from './bandeja.js';
import { cambiarEnsayo, estadoDeHomero } from './comandos.js';
import { armarDemo, cancelarDemo, clienteDePunchi, editarPliego, enviarDemo, seguirDemos } from './demos.js';
import { correrSiguiente, type DepsDeCola } from './cola.js';
import { leerConfig } from './config.js';
import { correoGmail } from './envio.js';
import { fuenteGoogle, fuenteOsm } from './fuentes.js';
import { pedirTexto } from './ia.js';
import { clienteDeGateway, type ClienteDeGateway } from './gateway.js';
import { crearServidorMcp, SesionesMcp } from './mcp.js';
import { SISTEMA } from './prompts.js';
import { PgStore } from './store.js';
import { COMANDOS, crearBot, NOMBRE, type Acciones } from './telegram.js';
import {
  aprobarLead,
  aprobarSaliente,
  descartarLead,
  descartarSaliente,
  apagarEnsayo,
  ensayoActivo,
  mandarMuestras,
  reproponerBorradores,
  proponerPrioridad,
  lugaresHoy,
  planificar,
  procesarRebote,
} from './ventas.js';
import { bajarPaginaConDestino, recibeMail } from './web.js';

const MIGRACIONES = ['001_homero.sql', '002_prospeccion.sql', '003_demos.sql', '004_patan.sql', '005_agentes.sql'].map((f) =>
  fileURLToPath(new URL('../migrations/' + f, import.meta.url)),
);
/** Cuanto duerme la cola cuando no hay nada listo. */
const COLA_VACIA_MS = 15_000;
/** Cada cuanto se fija si toca buscar clientes o mandar el resumen del dia. */
const PLANIFICADOR_MS = 5 * 60_000;
/** Cada cuanto le pregunta a Punchi como van las demos. */
const DEMOS_MS = 5 * 60_000;

async function main() {
  const config = leerConfig(process.env);
  const store = await PgStore.conectar(config.databaseUrl, MIGRACIONES);
  for (const c of config.casillas) await store.registrarCuenta(c.email);

  const rescatadas = await store.rescatarColgadas();
  const { bot, avisar, proponer, conectar, cambiarBotones } = crearBot(config, store);

  const aviso = (t: string) => avisar(t).catch((e) => console.error('[homero] no pude avisar:', e));
  // Las cuentas de Claude son un fondo comun que maneja el gateway: Homero no
  // tiene ninguna. Sin gateway configurado, todo lo que piensa espera en la
  // cola (con un error que dice por que) y lo ya escrito se sigue mandando.
  const gateway: ClienteDeGateway = config.gateway
    ? clienteDeGateway(config.gateway)
    : {
        correr: async () => {
          throw new Error('falta HOMERO_GATEWAY_URL / HOMERO_GATEWAY_TOKEN: no hay donde correr a Claude');
        },
      };
  if (!config.gateway) console.error('[homero] SIN GATEWAY: los agentes no van a correr hasta configurarlo');
  const sesiones = new SesionesMcp();
  const deps: DepsDeCola = {
    store,
    correo: correoGmail,
    remitente: config.remitente,
    casillas: config.casillas,
    firma: config.firma,
    emailGero: config.emailGero,
    ahora: () => new Date(),
    avisar: aviso,
    proponer: (t, b) =>
      proponer(t, b).catch((e) => {
        console.error('[homero] no pude mandar la tarjeta:', e);
        return undefined;
      }),
    pedirIa: (prompt) => pedirTexto(prompt, { sistema: SISTEMA, modelo: config.modelo, gateway }),
    gateway,
    sesiones,
    modelo: config.modelo,
    bajarPagina: bajarPaginaConDestino,
    fuente: config.placesKey ? fuenteGoogle(config.placesKey) : fuenteOsm,
    nombreDeFuente: config.placesKey ? 'google' : 'osm',
    recibeMail,
    punchi:
      config.bridge && config.chatId !== undefined
        ? clienteDePunchi({ ...config.bridge, chatId: config.chatId })
        : undefined,
  };
  const acciones: Acciones = {
    aprobarLead: (id) => aprobarLead(id, deps),
    descartarLead: (id) => descartarLead(id, deps),
    aprobarSaliente: (id) => aprobarSaliente(id, deps),
    descartarSaliente: (id) => descartarSaliente(id, deps),
    mandarMuestras: (a) => mandarMuestras(a, deps),
    ensayo: () => ensayoActivo(deps),
    apagarEnsayo: () => apagarEnsayo(deps),
    reproponerBorradores: () => reproponerBorradores(deps),
    prioridad: (n) => proponerPrioridad(deps, n),
    lugaresHoy: () => lugaresHoy(deps),
    estado: () => estadoDeHomero({ ...deps, placesKey: config.placesKey }),
    cambiarEnsayo: (p: 'off' | string | undefined) => cambiarEnsayo(deps, p),
    armarDemo: (id: number) => armarDemo(id, deps),
    enviarDemo: (id: number) => enviarDemo(id, deps),
    cancelarDemo: (id: number) => cancelarDemo(id, deps),
    editarPliego: (id: number, pliego: string) => editarPliego(id, pliego, deps),
    probarIa: () => pedirTexto('Presentate en una sola oración.', { sistema: SISTEMA, modelo: config.modelo, gateway }),
  };
  conectar(acciones);

  const api = config.apiToken
    ? crearApi({ token: config.apiToken, store, acciones, cambiarBotones, ahora: deps.ahora })
    : undefined;
  if (api) {
    // 0.0.0.0 dentro del contenedor; el compose no publica el puerto, asi que
    // solo lo alcanza quien comparte la red `puente` (el panel).
    await api.listen({ host: '0.0.0.0', port: config.apiPuerto });
    console.log(`[homero] API interna en :${config.apiPuerto}`);
  }

  // Las herramientas de los agentes. Escucha en la red que comparte con el
  // gateway (`enlace_homero`); cada corrida trae su propio token.
  const mcp = crearServidorMcp(sesiones);
  await mcp.listen({ host: '0.0.0.0', port: config.mcpPuerto });
  console.log(`[homero] MCP de los agentes en :${config.mcpPuerto}`);

  let corriendo = true;

  const bucleDeCola = (async () => {
    while (corriendo) {
      try {
        if (!(await correrSiguiente(deps))) await dormir(COLA_VACIA_MS);
      } catch (err) {
        // Un error aca es de infraestructura (la base, casi siempre): se
        // espera y se reintenta, no se cae el proceso.
        console.error('[homero] cola:', err);
        await dormir(30_000);
      }
    }
  })();

  const barrer = () =>
    revisarBandejas({
      store,
      buzon: buzonGmail,
      casillas: config.casillas,
      log: console.warn,
      alRebote: (r) => procesarRebote(r, deps),
    })
      .then((n) => n > 0 && console.log(`[homero] ${n} mails nuevos encolados`))
      .catch((err) => console.error('[homero] bandeja:', err));
  void barrer();
  const bandeja = setInterval(barrer, config.bandejaCadaMs);

  const plan = () => planificar(deps).catch((err) => console.error('[homero] planificador:', err));
  void plan();
  const planificador = setInterval(plan, PLANIFICADOR_MS);

  const demos = setInterval(
    () => void seguirDemos(deps).catch((err) => console.error('[homero] demos:', err)),
    DEMOS_MS,
  );

  // Polling y no webhook: Homero no necesita entrada publica, y asi no hay
  // host de cloudflared ni secreto que mantener.
  await bot.api.deleteWebhook();
  // El boton de menu con todos los comandos. Si falla, el bot anda igual.
  await bot.api.setMyCommands(COMANDOS).catch((e) => console.warn('[homero] no pude cargar el menu:', e));
  void bot.start({
    onStart: () => console.log(`[homero] ${NOMBRE} escuchando en Telegram`),
  });

  await aviso(
    `🟢 ${NOMBRE} arrancó. ${config.casillas.length} casilla(s), agentes ${config.gateway ? 'en el fondo común de cuentas' : 'SIN gateway (no piensan)'}` +
      (rescatadas > 0 ? `, retomo ${rescatadas} tarea(s) que quedaron a medias.` : '.'),
  );

  const apagar = async () => {
    corriendo = false;
    clearInterval(bandeja);
    clearInterval(planificador);
    clearInterval(demos);
    await api?.close();
    await mcp.close();
    await bot.stop();
    await bucleDeCola;
    await store.cerrar();
    process.exit(0);
  };
  process.once('SIGTERM', apagar);
  process.once('SIGINT', apagar);
}

main().catch((err) => {
  console.error('[homero] no pude arrancar:', err);
  process.exit(1);
});
