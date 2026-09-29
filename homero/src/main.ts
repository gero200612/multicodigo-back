import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';
import { buzonGmail, revisarBandejas } from './bandeja.js';
import { correrSiguiente, type DepsDeCola } from './cola.js';
import { leerConfig } from './config.js';
import { correoGmail } from './envio.js';
import { PgStore } from './store.js';
import { crearBot, NOMBRE } from './telegram.js';

const MIGRACIONES = ['001_homero.sql'].map((f) =>
  fileURLToPath(new URL('../migrations/' + f, import.meta.url)),
);
/** Cuanto duerme la cola cuando no hay nada listo. */
const COLA_VACIA_MS = 15_000;

async function main() {
  const config = leerConfig(process.env);
  const store = await PgStore.conectar(config.databaseUrl, MIGRACIONES);
  for (const c of config.casillas) await store.registrarCuenta(c.email);

  const rescatadas = await store.rescatarColgadas();
  const { bot, avisar } = crearBot(config, store);

  const deps: DepsDeCola = {
    store,
    correo: correoGmail,
    remitente: config.remitente,
    casillas: config.casillas,
    modelo: config.modelo,
    ahora: () => new Date(),
    avisar: (t) => avisar(t).catch((e) => console.error('[homero] no pude avisar:', e)),
  };

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
    revisarBandejas({ store, buzon: buzonGmail, casillas: config.casillas, log: console.warn })
      .then((n) => n > 0 && console.log(`[homero] ${n} mails nuevos encolados`))
      .catch((err) => console.error('[homero] bandeja:', err));
  void barrer();
  const bandeja = setInterval(barrer, config.bandejaCadaMs);

  // Polling y no webhook: Homero no necesita entrada publica, y asi no hay
  // host de cloudflared ni secreto que mantener.
  await bot.api.deleteWebhook();
  void bot.start({
    onStart: () => console.log(`[homero] ${NOMBRE} escuchando en Telegram`),
  });

  await deps.avisar(
    `🟢 ${NOMBRE} arrancó. ${config.casillas.length} casilla(s)` +
      (rescatadas > 0 ? `, retomo ${rescatadas} tarea(s) que quedaron a medias.` : '.'),
  );

  const apagar = async () => {
    corriendo = false;
    clearInterval(bandeja);
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
