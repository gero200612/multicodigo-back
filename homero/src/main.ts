import { fileURLToPath } from 'node:url';
import { reportarCrashes, reportarError, type ReporteDeError } from '@multicodigo/shared';
import { setTimeout as dormir } from 'node:timers/promises';
import {
  aprobarAnuncio,
  cambiarPresupuesto,
  descartarAnuncio,
  descartarPlantillasViejas,
  retomarPublicaciones,
  leerLeadsDeMeta,
  pedirCambio,
  planificarAnuncios,
} from './anuncios.js';
import { clasificarPendientes } from './calidad.js';
import { crearApi } from './api.js';
import { crearBuzonGmail, revisarBandejas } from './bandeja.js';
import { cambiarEnsayo, estadoDeHomero } from './comandos.js';
import { armarDemo, cancelarDemo, clienteDePunchi, editarPliego, enviarDemo, seguirDemos } from './demos.js';
import { correrSiguiente, TIPOS_URGENTES, type DepsDeCola } from './cola.js';
import { planificarFinanzas } from './finanzas.js';
import { leerConfig } from './config.js';
import { correoGmail } from './envio.js';
import { fuenteGoogle, fuenteOsm } from './fuentes.js';
import { pedirTexto } from './ia.js';
import { clienteDeGateway, type ClienteDeGateway } from './gateway.js';
import { crearServidorMcp, SesionesMcp } from './mcp.js';
import { clienteDeMeta } from './meta.js';
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
import { adminWa, atenderIa, bucle, clienteWa, pedidorWa, recibirLeads, reenviarAlertas } from './whatsapp.js';
import { asegurarPlantilla, VIGILAR_PLANTILLA_MS, vigilarPlantilla } from './primer-whatsapp.js';
import { PLANTILLA_LINK, recibirMeet } from './meet.js';
import {
  aprobarRevision,
  arrancarExperimento,
  clienteDelAnfitrion,
  conEcoAlAnfitrion,
  estadoDelHost,
  idDeLeadDeLaWeb,
  idDeLeadDeMeta,
  idDeLeadDeWhatsapp,
  metaSinAnuncios,
  motivoPendiente,
  pedirMotivo,
  recibirAprobacion,
  rechazarRevision,
  reenviarLead,
  type DepsDelAnfitrion,
  type LeadParaElAnfitrion,
} from './anfitrion.js';
import { armarBancoDeMusica, buscarEnPixabay, leerBanco } from './medios.js';
import { aprobarReel, cambiarReel, descartarReel, promocionarReel, recibirVideo, reintentarReel, retomarReels } from './publicar-reel.js';
import { hojaDeContacto, medirVideo, portadaDe } from './video.js';

const MIGRACIONES = ['001_homero.sql', '002_prospeccion.sql', '003_demos.sql', '004_patan.sql', '005_agentes.sql', '006_resumen.sql', '008_anuncios.sql', '009_plantillas.sql', '010_finanzas.sql', '011_cuenta_es_gasto.sql', '012_corrida_contacto.sql', '013_calidad_de_leads.sql', '014_variantes.sql', '015_reels.sql', '016_calidad_origen.sql', '017_calidad_auto.sql'].map((f) =>
  fileURLToPath(new URL('../migrations/' + f, import.meta.url)),
);
/** Cuanto duerme la cola cuando no hay nada listo. */
const COLA_VACIA_MS = 15_000;
/** El de WhatsApp mira mas seguido: hay alguien esperando. */
const COLA_URGENTE_VACIA_MS = 1_000;
/** Cada cuanto se fija si toca buscar clientes o mandar el resumen del dia. */
const PLANIFICADOR_MS = 5 * 60_000;
/** Cada cuanto le pregunta a Punchi como van las demos. */
const DEMOS_MS = 5 * 60_000;
/** Cada cuanto lee los formularios de los anuncios. */
const LEADS_DE_META_MS = 5 * 60_000;

async function main() {
  const config = leerConfig(process.env);
  // Al registro de errores del bridge. Sin bridge no hay a quien contarle: se
  // sigue solo con los logs, como antes.
  const bridge = config.bridge;
  const reportar = bridge ? (r: ReporteDeError) => reportarError(bridge, r) : undefined;
  // Antes de conectar nada: el crash del 2026-10-08 fue un timeout del IMAP y
  // solo se supo leyendo `docker logs`. El handler reporta y despues sale con
  // 1, igual que sin el.
  if (reportar) reportarCrashes('homero', reportar);
  const tienda = await PgStore.conectar(config.databaseUrl, MIGRACIONES);
  for (const c of config.casillas) await tienda.registrarCuenta(c.email);

  // Sincro Host: quien piensa el experimento de anuncios. Homero le pone Telegram y le reenvia los leads (sin datos de personas).
  const anfitrion = config.anfitrion ? clienteDelAnfitrion(config.anfitrion) : undefined;
  // Con eco al host: cada cambio de calidad (la automatica o el boton de Gero) y cada etapa del lead (respondio, reunion, cliente, perdido) se le cuenta.
  const store = conEcoAlAnfitrion(tienda, anfitrion);

  const rescatadas = await tienda.rescatarColgadas();
  const { bot, avisar, proponer, mandarFoto, mandarVideo, conectar, cambiarBotones } = crearBot(config, store);

  const aviso = (t: string) => avisar(t).catch((e) => console.error('[homero] no pude avisar:', e));
  const alLeadDelAnfitrion = (l: LeadParaElAnfitrion) => void reenviarLead(anfitrion, l);
  if (!config.anunciosPropios) console.log('[homero] anuncios propios en pausa (HOMERO_ANUNCIOS_PROPIOS=no): el experimento lo maneja Sincro Host');
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
  // Una sola vez y sin el token: sin Meta, Homero sigue como antes.
  if (!config.meta) console.log(`[homero] sin anuncios en Meta: ${config.sinMeta}`);
  const sesiones = new SesionesMcp();
  // WhatsApp: el bot general vive en el VPS. Cada clave abre solo su parte.
  const wa = config.whatsapp?.clave ? clienteWa(pedidorWa(config.whatsapp.url, config.whatsapp.clave)) : undefined;
  const waAdmin = config.whatsapp?.claveAdmin
    ? adminWa(pedidorWa(config.whatsapp.url, config.whatsapp.claveAdmin))
    : undefined;
  if (!config.whatsapp) console.log('[homero] sin WhatsApp: falta SINCRO_WA_URL');
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
    reportar,
    bajarPagina: bajarPaginaConDestino,
    fuente: config.placesKey ? fuenteGoogle(config.placesKey) : fuenteOsm,
    nombreDeFuente: config.placesKey ? 'google' : 'osm',
    recibeMail,
    punchi:
      config.bridge && config.chatId !== undefined
        ? clienteDePunchi({ ...config.bridge, chatId: config.chatId })
        : undefined,
    // Con los anuncios propios en pausa, Homero lee Meta pero no crea ni cambia anuncios, formularios ni presupuestos.
    meta: config.meta ? (config.anunciosPropios ? clienteDeMeta(config.meta) : metaSinAnuncios(clienteDeMeta(config.meta))) : undefined,
    alLeadNuevo: (l) => alLeadDelAnfitrion({ id: idDeLeadDeMeta(l.id), fuente: l.fuente, anuncio: l.anuncio, creado: l.creado, estado: 'nuevo' }),
    mandarFoto: (png, pie) => mandarFoto(png, pie).catch((e) => console.error('[homero] no pude mandar la imagen:', e)),
    // Los reels que manda Gero: el video vive en el volumen de medios hasta publicarlo.
    medios: config.medios.dir,
    medir: medirVideo,
    hoja: hojaDeContacto,
    portada: portadaDe,
    mandarVideo: (archivo, pie) => mandarVideo(archivo, pie).catch((e) => console.error('[homero] no pude mandar el video:', e)),
    wa,
    waAdmin,
    numerosDePrueba: config.whatsapp?.numerosDePrueba ?? [],
  };
  const depsDelAnfitrion: DepsDelAnfitrion = {
    store,
    anfitrion,
    medios: config.medios.dir,
    mandarVideo: deps.mandarVideo,
    proponer: async (t, b) => proponer(t, b),
    avisar: aviso,
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
    aprobarAnuncio: (id: number) => aprobarAnuncio(id, deps),
    descartarAnuncio: (id: number) => descartarAnuncio(id, deps),
    marcarCalidad: async (id: number, calidad: 'sirve' | 'no_sirve') => (await store.marcarCalidad(id, calidad)) !== undefined,
    pasarMeet: (citado: number, texto: string) => recibirMeet(citado, texto, { ...deps, aprobar: (id) => aprobarSaliente(id, deps) }),
    cambiarAnuncio: (id: number, pedido: string) => pedirCambio(id, pedido, deps),
    cambiarPresupuesto: (monto: number) => cambiarPresupuesto(monto, deps),
    recibirVideo: (v) => recibirVideo(v, deps),
    aprobarReel: (id, promocionar) => aprobarReel(id, { promocionar }, deps),
    reintentarReel: (id) => reintentarReel(id, deps),
    descartarReel: (id) => descartarReel(id, deps),
    cambiarReel: (id, pedido) => cambiarReel(id, pedido, deps),
    promocionarReel: (id) => promocionarReel(id, deps),
    anfitrion: anfitrion
      ? {
          aprobar: (n) => aprobarRevision(n, depsDelAnfitrion),
          pedirMotivo: (n) => pedirMotivo(n, depsDelAnfitrion),
          motivoPendiente: () => motivoPendiente(depsDelAnfitrion),
          rechazar: (n, motivo) => rechazarRevision(n, motivo, depsDelAnfitrion),
          arrancar: (tope) => arrancarExperimento(tope, depsDelAnfitrion),
          estado: () => estadoDelHost(depsDelAnfitrion),
        }
      : undefined,
  };
  conectar(acciones);

  // Una sola vez: los anuncios propuestos con la plantilla de antes (una frase
  // sola) no le llegan a Gero; el publicista los reemplaza con las nuevas.
  const viejos = await descartarPlantillasViejas({ ...deps, cambiarBotones });
  if (viejos > 0) console.log(`[homero] descarté ${viejos} anuncio(s) con la plantilla vieja`);
  // Con los anuncios propios en pausa no se vuelve a publicar nada aprobado antes.
  const retomados = config.anunciosPropios ? await retomarPublicaciones(deps) : 0;
  if (retomados > 0) console.log(`[homero] vuelvo a publicar ${retomados} anuncio(s) aprobado(s)`);
  const reelsRetomados = await retomarReels(deps);
  if (reelsRetomados > 0) console.log(`[homero] retomo ${reelsRetomados} reel(s): subidas a medias o tarjetas que no salieron`);

  const api = config.apiToken
    ? crearApi({
        token: config.apiToken,
        store,
        acciones,
        cambiarBotones,
        ahora: deps.ahora,
        enCurso: () => sesiones.enCurso(),
        whatsapp: waAdmin,
        anfitrion: anfitrion
          ? { aviso: (texto) => avisar(texto), aprobacion: (cuerpo) => recibirAprobacion(cuerpo, depsDelAnfitrion) }
          : undefined,
      })
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

  // WhatsApp no espera atras de una corrida larga (buscar, publicitar): tiene
  // su propio bucle, que solo toma esas tareas.
  const bucleUrgente = (async () => {
    while (corriendo) {
      try {
        if (!(await correrSiguiente(deps, TIPOS_URGENTES))) await dormir(COLA_URGENTE_VACIA_MS);
      } catch (err) {
        console.error('[homero] cola urgente:', err);
        await dormir(30_000);
      }
    }
  })();

  const buzon = crearBuzonGmail({ log: console.warn, reportar });
  const barrer = () =>
    revisarBandejas({
      store,
      buzon,
      casillas: config.casillas,
      log: console.warn,
      alRebote: (r) => procesarRebote(r, deps),
    })
      .then((n) => n > 0 && console.log(`[homero] ${n} mails nuevos encolados`))
      .catch((err) => console.error('[homero] bandeja:', err));
  void barrer();
  const bandeja = setInterval(barrer, config.bandejaCadaMs);

  // La calidad de cada consulta nueva (sirve / no sirve + motivo) con el modelo del gateway. Sin gateway no se califica y se reintenta.
  const clasificar = () =>
    clasificarPendientes({
      store,
      pedirIa: (prompt, sistema) => pedirTexto(prompt, { sistema, modelo: config.modeloChico ?? config.modelo, gateway }),
      ahora: deps.ahora,
    }).then((n) => n > 0 && console.log(`[homero] ${n} consulta(s) clasificada(s) solas`));
  const plan = () =>
    Promise.all([planificar(deps), config.anunciosPropios ? planificarAnuncios(deps) : undefined, planificarFinanzas(deps), clasificar()]).catch((err) =>
      console.error('[homero] planificador:', err),
    );
  void plan();
  const planificador = setInterval(plan, PLANIFICADOR_MS);

  const demos = setInterval(
    () => void seguirDemos(deps).catch((err) => console.error('[homero] demos:', err)),
    DEMOS_MS,
  );

  // El banco de musica de los reels: se completa de a poco, una vuelta por dia
  // (Openverse sin cuenta frena si se le pide mucho). Y un control de la clave
  // de Pixabay al arrancar, para enterarse ya si esta mal cargada.
  const bancoDeMusica = () =>
    void armarBancoDeMusica({ dir: config.medios.dir, ahora: () => new Date() })
      .then(async (n) => {
        const banco = await leerBanco(config.medios.dir);
        console.log(`[homero] musica: ${n} tema(s) nuevo(s), ${banco.length} en el banco`);
      })
      .catch((err) => console.error('[homero] musica:', err instanceof Error ? err.message : err));
  setTimeout(bancoDeMusica, 60_000);
  const musica = setInterval(bancoDeMusica, 24 * 3_600_000);
  if (config.medios.pixabay) {
    void buscarEnPixabay('office', 'foto', { clave: config.medios.pixabay, cantidad: 3 })
      .then((f) => console.log(`[homero] pixabay: la clave anda (${f.length} fotos de prueba)`))
      .catch((err) => console.error('[homero] pixabay:', err instanceof Error ? err.message : err));
  } else {
    console.log('[homero] sin PIXABAY_API_KEY: los reels no van a tener fotos de Pixabay');
  }

  const leadsDeMeta = config.meta
    ? setInterval(
        () =>
          void leerLeadsDeMeta(deps)
            .then(async (n) => {
              if (n > 0) console.log(`[homero] ${n} consulta(s) nueva(s) de Meta`);
              if (n > 0) await clasificar();
            })
            .catch((err) => console.error('[homero] leads de Meta:', err instanceof Error ? err.message : err)),
        LEADS_DE_META_MS,
      )
    : undefined;

  // La plantilla del primer WhatsApp: se registra sola y se avisa cuando Meta la aprueba.
  const plantillaWa = wa
    ? (() => {
        const mirar = () =>
          void vigilarPlantilla({ wa, store, avisar: aviso })
            .then((e) => console.log(`[homero] plantilla consulta_web: ${e}`))
            .catch((err) => console.error('[homero] plantilla de WhatsApp:', err instanceof Error ? err.message : err));
          // La del link de la reunion, para cuando pasaron mas de 24 h: con que quede registrada alcanza.
          void asegurarPlantilla(wa, PLANTILLA_LINK)
            .then((e) => console.log(`[homero] plantilla link_reunion: ${e}`))
            .catch((err) => console.error('[homero] plantilla link_reunion:', err instanceof Error ? err.message : err));
        mirar();
        return setInterval(mirar, VIGILAR_PLANTILLA_MS);
      })()
    : undefined;

  // WhatsApp: tres long-polls al bot, por la VPN. Homero pregunta y el bot
  // contesta; la Toshiba no abre ningun puerto para esto.
  const sigue = () => corriendo;
  const buclesWa = [
    wa ? bucle('leads', () => recibirLeads(wa, store, deps.ahora, (l) => alLeadDelAnfitrion({
      id: l.fuente === 'web' ? idDeLeadDeLaWeb(l.evento) : idDeLeadDeWhatsapp(l.contacto ?? String(l.evento)),
      fuente: l.fuente,
      creado: deps.ahora(),
      estado: l.fuente === 'web' ? 'nuevo' : 'en_conversacion',
    })), sigue) : undefined,
    waAdmin ? bucle('alertas', () => reenviarAlertas(waAdmin, aviso), sigue) : undefined,
    waAdmin ? bucle('ia', () => atenderIa({ admin: waAdmin, gateway, sesiones, modelo: config.modelo }), sigue) : undefined,
  ];

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
    clearInterval(leadsDeMeta);
    clearInterval(musica);
    clearInterval(plantillaWa);
    await api?.close();
    await mcp.close();
    await bot.stop();
    await bucleDeCola;
    await bucleUrgente;
    // Un long-poll tarda hasta 25 s en volver: no se lo espera para apagar.
    void Promise.all(buclesWa);
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
