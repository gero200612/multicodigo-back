import { z } from 'zod';

/** Una casilla de Gmail con su contraseña de aplicacion. */
export interface Casilla {
  email: string;
  clave: string;
}

// Un `${VAR:-}` del compose llega como string vacio, no como ausente. Sin esto
// `z.coerce.number()` convierte '' en 0 y el bot quedaria "vinculado" al chat 0.
const opcional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), s.optional());

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  // Sin esto el bot solo contesta /start con el id del chat, para poder
  // configurarlo. Ver `telegram.ts`.
  HOMERO_CHAT_ID: opcional(z.coerce.number().int()),
  DATABASE_URL: z.string().min(1),
  HOMERO_MODELO: z.string().min(1).default('sonnet'),
  // El nombre que ve el destinatario en la bandeja.
  HOMERO_REMITENTE: opcional(z.string().min(1)).transform((v) => v ?? 'Geronimo Enrici'),
  HOMERO_BANDEJA_MIN: z.coerce.number().int().min(1).default(10),
  // Como firma los mails. Un nombre de persona responde mas que una marca.
  // Va en dos renglones: nombre y marca. En mc.env el salto se escribe \n.
  HOMERO_FIRMA: opcional(z.string().min(1)).transform((v) => (v ?? 'Geronimo Enrici\nSincro_ar').replace(/\\n/g, '\n')),
  // Adonde le llega a Gero la invitacion de cada reunion.
  HOMERO_EMAIL_GERO: opcional(z.string().email()),
  // Sin esto se busca en OpenStreetMap, que es gratis y no pide cuenta.
  GOOGLE_PLACES_API_KEY: opcional(z.string().min(1)),
  // La API interna que usa punchi.dev (a traves del panel). Sin token no se
  // levanta: Homero sigue andando solo por Telegram.
  HOMERO_API_TOKEN: opcional(z.string().min(16)),
  HOMERO_API_PUERTO: z.coerce.number().int().default(8095),
  // Para pedirle demos a Punchi. Van juntas; sin ellas no hay boton de demo.
  BRIDGE_URL: opcional(z.string().url()),
  BRIDGE_API_TOKEN: opcional(z.string().min(16)),
  HOMERO_GMAIL_1_USER: opcional(z.string().email()),
  HOMERO_GMAIL_1_PASS: opcional(z.string().min(1)),
  HOMERO_GMAIL_2_USER: opcional(z.string().email()),
  HOMERO_GMAIL_2_PASS: opcional(z.string().min(1)),
  HOMERO_GMAIL_3_USER: opcional(z.string().email()),
  HOMERO_GMAIL_3_PASS: opcional(z.string().min(1)),
});

export interface Config {
  telegramToken: string;
  chatId?: number;
  databaseUrl: string;
  modelo: string;
  remitente: string;
  bandejaCadaMs: number;
  firma: string;
  emailGero?: string;
  placesKey?: string;
  casillas: Casilla[];
  apiToken?: string;
  apiPuerto: number;
  bridge?: { url: string; token: string };
}

export function leerConfig(env: NodeJS.ProcessEnv): Config {
  const e = Env.parse(env);
  const casillas: Casilla[] = [];
  for (const n of [1, 2, 3] as const) {
    const email = e[`HOMERO_GMAIL_${n}_USER`];
    const clave = e[`HOMERO_GMAIL_${n}_PASS`];
    if (!email && !clave) continue;
    if (!email || !clave) {
      throw new Error(`HOMERO_GMAIL_${n}: falta el USER o el PASS, van los dos juntos`);
    }
    // Google muestra la contraseña de aplicacion en grupos de cuatro con
    // espacios. Acepta las dos formas, pero con espacios no sobrevive a
    // /root/mc.env sin comillas.
    casillas.push({ email: email.toLowerCase(), clave: clave.replace(/\s+/g, '') });
  }
  return {
    telegramToken: e.TELEGRAM_BOT_TOKEN,
    chatId: e.HOMERO_CHAT_ID,
    databaseUrl: e.DATABASE_URL,
    modelo: e.HOMERO_MODELO,
    remitente: e.HOMERO_REMITENTE,
    bandejaCadaMs: e.HOMERO_BANDEJA_MIN * 60_000,
    firma: e.HOMERO_FIRMA,
    emailGero: e.HOMERO_EMAIL_GERO,
    placesKey: e.GOOGLE_PLACES_API_KEY,
    casillas,
    apiToken: e.HOMERO_API_TOKEN,
    apiPuerto: e.HOMERO_API_PUERTO,
    bridge: e.BRIDGE_URL && e.BRIDGE_API_TOKEN ? { url: e.BRIDGE_URL, token: e.BRIDGE_API_TOKEN } : undefined,
  };
}
