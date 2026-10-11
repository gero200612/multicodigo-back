import { leerConfig } from './config.js';
import { pushConFetch, type Contexto } from './contexto.js';
import { PgStore } from './db.js';
import { Despertador } from './eventos.js';
import { clienteMeta } from './meta.js';
import { crearPrivado } from './privado.js';
import { crearPublico } from './publico.js';
import { taparTokens, textoDeError } from './tapar.js';
import { arrancarTareas } from './tareas.js';

const log = (texto: string) => console.log(`[sincro-wa] ${taparTokens(texto)}`);

async function main(): Promise<void> {
  const cfg = leerConfig(process.env);
  const store = await PgStore.abrir(cfg.databaseUrl, log);
  const ctx: Contexto = {
    store,
    meta: clienteMeta(cfg.versionMeta),
    ahora: () => new Date(),
    claveCifrado: cfg.claveCifrado,
    tokenMeta: cfg.tokenMeta,
    despertador: new Despertador(),
    push: pushConFetch,
    log,
  };

  const publico = crearPublico(ctx, { appSecret: cfg.appSecret, verifyToken: cfg.verifyToken });
  const privado = crearPrivado(ctx, { claveAdmin: cfg.claveAdmin });
  await publico.listen({ host: '0.0.0.0', port: cfg.puertoPublico });
  await privado.listen({ host: '0.0.0.0', port: cfg.puertoPrivado });
  const parar = arrancarTareas(ctx);
  log(`escuchando: público ${cfg.puertoPublico}, privado ${cfg.puertoPrivado}`);

  const cerrar = async () => {
    parar();
    await Promise.allSettled([publico.close(), privado.close()]);
    await store.cerrar();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cerrar());
  process.on('SIGINT', () => void cerrar());
}

main().catch((e) => {
  // Zod tira el detalle de la variable que falta; nunca su valor.
  console.error(`[sincro-wa] no arranca: ${textoDeError(e)}`);
  process.exit(1);
});
