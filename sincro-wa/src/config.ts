import { z } from 'zod';
import { claveDeCifrado } from './cifrado.js';

// Un `${VAR:-}` del compose llega como string vacio, no como ausente.
const opcional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), s.optional());

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_TOKEN: z.string().min(1),
  // Fija a proposito, como en Homero: un cambio de version se prueba antes.
  META_API_VERSION: opcional(z.string().regex(/^v\d+\.\d+$/)).transform((v) => v ?? 'v23.0'),
  // 32 como minimo: es la unica llave de todo lo de admin, y la usa una sola app.
  SINCRO_WA_ADMIN_KEY: z.string().min(32),
  SINCRO_WA_CIFRADO: z.string().min(1),
  PUERTO_PUBLICO: z.coerce.number().int().default(3000),
  PUERTO_PRIVADO: z.coerce.number().int().default(3001),
});

export interface Config {
  databaseUrl: string;
  appSecret: string;
  verifyToken: string;
  tokenMeta: string;
  versionMeta: string;
  claveAdmin: string;
  claveCifrado: Buffer;
  puertoPublico: number;
  puertoPrivado: number;
}

export function leerConfig(env: NodeJS.ProcessEnv): Config {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    appSecret: e.META_APP_SECRET,
    verifyToken: e.META_VERIFY_TOKEN,
    tokenMeta: e.META_TOKEN,
    versionMeta: e.META_API_VERSION,
    claveAdmin: e.SINCRO_WA_ADMIN_KEY,
    // Se valida al arrancar y no al primer token de cliente: mejor no levantar
    // que descubrirlo cuando alguien conecta su numero.
    claveCifrado: claveDeCifrado(e.SINCRO_WA_CIFRADO),
    puertoPublico: e.PUERTO_PUBLICO,
    puertoPrivado: e.PUERTO_PRIVADO,
  };
}
