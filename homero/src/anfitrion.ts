import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Meta } from './meta.js';
import { ErrorDeMeta } from './meta.js';
import type { Store } from './store.js';
import type { Boton } from './ventas.js';

/**
 * Homero como CANAL del Sincro Host (sincro-agents/apps/sincro-host): el host
 * es quien piensa (agente de contenido, agente de marketing y los topes de
 * plata); Homero le pone Telegram y le reenvia los leads.
 *
 * - El host manda por aca las tarjetas de calibracion (el reel con Aprobar y
 *   Rechazar) y los avisos; Homero las muestra y le devuelve la decision.
 * - Homero le reenvia al host cada lead nuevo (formulario de Meta, WhatsApp,
 *   formulario de la web) SIN datos de personas: un id, la fuente y el estado.
 * - Nada de esto gasta plata: "arrancar" solo le pasa al host el limite que
 *   dio Gero; los topes los aplica el host.
 */

/** En homero.estado: los reels que esperan decision. `mapa` va del numero del boton al id de revision del host. */
export const ANFITRION_REVISIONES = 'anfitrion:revisiones';
/** En homero.estado: la revision a la que Gero le esta por decir por que la rechaza. */
export const ANFITRION_RECHAZO = 'anfitrion:rechazo_pendiente';

interface Revisiones {
  siguiente: number;
  mapa: Record<string, string>;
}

export type FuenteDeLead = 'meta_form' | 'whatsapp' | 'web';

export interface LeadParaElAnfitrion {
  /** Un id estable. Nunca un mail ni un telefono. */
  id: string;
  fuente: FuenteDeLead;
  creado: Date;
  /** El anuncio de Meta del que vino, si se sabe. */
  anuncio?: string;
  estado?: 'nuevo' | 'en_conversacion' | 'link_enviado' | 'registrado' | 'perdido';
}

export class ErrorDelAnfitrion extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorDelAnfitrion';
  }
}

export interface ConfigDelAnfitrion {
  url: string;
  token: string;
}

export interface ClienteDelAnfitrion {
  /** La URL del host: de ahi (y de ningun otro lado) se baja el video de una tarjeta. */
  readonly url: string;
  aprobar(revision: string): Promise<void>;
  rechazar(revision: string, motivo: string): Promise<void>;
  lead(l: LeadParaElAnfitrion): Promise<void>;
  arrancar(tope: number): Promise<string>;
  experimento(): Promise<string>;
}

type Pedir = typeof fetch;

/** El cliente del host. El token va en el header y nunca en un mensaje de error. */
export function clienteDelAnfitrion(cfg: ConfigDelAnfitrion, pedir: Pedir = fetch): ClienteDelAnfitrion {
  const base = cfg.url.replace(/\/$/, '');
  async function llamar(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<Record<string, unknown>> {
    let r: Response;
    try {
      r = await pedir(`${base}${ruta}`, {
        method: metodo,
        headers: { authorization: `Bearer ${cfg.token}`, ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }) },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ErrorDelAnfitrion(`no pude hablar con el host: ${err instanceof Error ? err.message.split(cfg.token).join('[token]') : String(err)}`);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await r.json()) as Record<string, unknown>;
    } catch {
      // Sin JSON: alcanza con el status.
    }
    if (!r.ok) {
      const detalle = typeof json.error === 'string' ? json.error : `HTTP ${r.status}`;
      throw new ErrorDelAnfitrion(detalle.split(cfg.token).join('[token]'));
    }
    return json;
  }
  return {
    url: base,
    async aprobar(revision) {
      await llamar('POST', `/homero/calibracion/${encodeURIComponent(revision)}/aprobar`, {});
    },
    async rechazar(revision, motivo) {
      await llamar('POST', `/homero/calibracion/${encodeURIComponent(revision)}/rechazar`, { motivo });
    },
    async lead(l) {
      await llamar('POST', '/homero/leads', {
        id: l.id,
        fuente: l.fuente,
        creado: l.creado.toISOString(),
        ...(l.anuncio ? { anuncio: l.anuncio } : {}),
        ...(l.estado ? { estado: l.estado } : {}),
      });
    },
    async arrancar(tope) {
      const r = await llamar('POST', '/homero/arrancar', { tope });
      return typeof r.texto === 'string' ? r.texto : 'El experimento arrancó.';
    },
    async experimento() {
      const r = await llamar('GET', '/homero/experimento');
      return typeof r.texto === 'string' ? r.texto : 'El host no dio el estado.';
    },
  };
}

// ------------------------------------------------------------ leads hacia el host

/**
 * El id del lead de un WhatsApp: un hash del numero. El host no recibe telefonos, y el mismo numero siempre da el mismo id
 * (una charla es un lead, no uno por mensaje).
 */
export function idDeLeadDeWhatsapp(contacto: string): string {
  return `wa-${createHash('sha256').update(contacto.replace(/\D/g, '')).digest('hex').slice(0, 20)}`;
}

export const idDeLeadDeMeta = (leadgenId: string): string => `meta-${leadgenId}`;
export const idDeLeadDeLaWeb = (evento: number | string): string => `web-${evento}`;

/**
 * Reenvia un lead sin frenar a nadie: si el host no contesta se reintenta una vez y se sigue (los leads de Meta ya se cuentan en
 * los insights; esto es la calidad). Devuelve si llego.
 */
export async function reenviarLead(host: ClienteDelAnfitrion | undefined, l: LeadParaElAnfitrion, log: (t: string) => void = console.warn): Promise<boolean> {
  if (!host) return false;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await host.lead(l);
      return true;
    } catch (err) {
      if (intento === 2) log(`[homero] no pude reenviar el lead ${l.id} al host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return false;
}

// ------------------------------------------------------------ tarjetas de calibracion

export const Aprobacion = z.object({
  revision: z.string().uuid(),
  pieza: z.string().uuid().optional(),
  tema: z.string().max(300).default(''),
  texto: z.string().max(2500).default(''),
  porQue: z.string().max(1500).default(''),
  puntaje: z.number().nullable().optional(),
  duracion: z.number().nullable().optional(),
  videoUrl: z.string().url(),
});
export type Aprobacion = z.infer<typeof Aprobacion>;

export const Aviso = z.object({ texto: z.string().min(1).max(3500) });

/** Lo mas que se baja de un video de una tarjeta (Telegram acepta hasta 50 MB por sendVideo). */
export const TOPE_DE_VIDEO = 50 * 1024 * 1024;

export interface DepsDelAnfitrion {
  store: Pick<Store, 'leerEstado' | 'guardarEstado'>;
  anfitrion?: ClienteDelAnfitrion;
  /** El volumen de medios: el video espera ahi hasta que Gero decide. */
  medios: string;
  mandarVideo?: (archivo: string, pie: string) => Promise<void>;
  proponer: (texto: string, botones: Boton[]) => Promise<number | undefined>;
  avisar: (texto: string) => Promise<void>;
  /** En los tests no sale a la red. */
  pedir?: Pedir;
}

export const botonesDeRevision = (n: number): Boton[] => [
  { texto: '✅ Aprobar', datos: `ha:${n}` },
  { texto: '❌ Rechazar', datos: `hn:${n}` },
];

export function tarjetaDeRevision(n: number, a: Aprobacion): string {
  return [
    `🎬 Reel ${n} del experimento de anuncios${a.duracion ? ` (${Math.round(a.duracion)} s)` : ''}: ${a.tema}`,
    '',
    a.texto,
    a.porQue ? `\nPor qué: ${a.porQue}` : '',
    a.puntaje != null ? `Puntaje del crítico: ${a.puntaje.toFixed(1)} de 5` : '',
    '',
    '✅ Aprobar: queda listo y el asistente de marketing arma su anuncio (pausado: no gasta nada hasta que vos arranques).',
    '❌ Rechazar: te pido el motivo y el asistente rehace el reel.',
  ]
    .filter((l, i, todas) => l !== '' || todas[i - 1] !== '')
    .join('\n');
}

/**
 * El host manda una tarjeta: se baja el video (solo del propio host: la URL
 * viene en un pedido y no se le cree), se manda con su texto y los botones, y
 * se anota el numero del boton. Repetido (el host reintenta) no se vuelve a
 * mandar.
 */
export async function recibirAprobacion(cuerpo: unknown, d: DepsDelAnfitrion): Promise<{ ok: true; n: number; repetido?: boolean } | { ok: false; motivo: string }> {
  const parsed = Aprobacion.safeParse(cuerpo);
  if (!parsed.success) return { ok: false, motivo: 'pedido inválido' };
  const a = parsed.data;
  if (!d.anfitrion) return { ok: false, motivo: 'Homero no tiene configurado el host (SINCRO_HOST_URL)' };
  if (new URL(a.videoUrl).origin !== new URL(d.anfitrion.url).origin) return { ok: false, motivo: 'el video no es del host' };

  const estado = (await d.store.leerEstado<Revisiones>(ANFITRION_REVISIONES)) ?? { siguiente: 1, mapa: {} };
  const ya = Object.entries(estado.mapa).find(([, rev]) => rev === a.revision);
  if (ya) return { ok: true, n: Number(ya[0]), repetido: true };

  const n = estado.siguiente;
  const carpeta = join(d.medios, 'anfitrion');
  await mkdir(carpeta, { recursive: true });
  const archivo = join(carpeta, `${n}.mp4`);
  try {
    const res = await (d.pedir ?? fetch)(a.videoUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { ok: false, motivo: `el host contestó ${res.status} al bajar el video` };
    const video = Buffer.from(await res.arrayBuffer());
    if (video.length === 0 || video.length > TOPE_DE_VIDEO) return { ok: false, motivo: `el video pesa ${video.length} bytes` };
    await writeFile(archivo, video);
  } catch (err) {
    return { ok: false, motivo: `no pude bajar el video: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Se anota ANTES de mandar: si Telegram falla el host reintenta con la misma tarjeta y sigue el mismo numero.
  await d.store.guardarEstado(ANFITRION_REVISIONES, { siguiente: n + 1, mapa: { ...estado.mapa, [n]: a.revision } } satisfies Revisiones);
  try {
    await d.mandarVideo?.(archivo, `Reel ${n} · ${a.tema}`.slice(0, 200));
    await d.proponer(tarjetaDeRevision(n, a), botonesDeRevision(n));
  } catch (err) {
    await d.store.guardarEstado(ANFITRION_REVISIONES, estado);
    await rm(archivo, { force: true });
    return { ok: false, motivo: `no pude mandar la tarjeta: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, n };
}

async function revisionDe(n: number, d: DepsDelAnfitrion): Promise<string | undefined> {
  return (await d.store.leerEstado<Revisiones>(ANFITRION_REVISIONES))?.mapa[String(n)];
}

async function olvidar(n: number, d: DepsDelAnfitrion): Promise<void> {
  const estado = await d.store.leerEstado<Revisiones>(ANFITRION_REVISIONES);
  if (estado) {
    const { [String(n)]: _quitada, ...resto } = estado.mapa;
    await d.store.guardarEstado(ANFITRION_REVISIONES, { ...estado, mapa: resto });
  }
  await rm(join(d.medios, 'anfitrion', `${n}.mp4`), { force: true });
}

/** ✅ Aprobar. Devuelve lo que se le contesta a Gero. */
export async function aprobarRevision(n: number, d: DepsDelAnfitrion): Promise<string> {
  const rev = await revisionDe(n, d);
  if (!rev || !d.anfitrion) return 'Ese reel ya estaba decidido.';
  try {
    await d.anfitrion.aprobar(rev);
  } catch (err) {
    return `No pude aprobarlo: ${err instanceof Error ? err.message : String(err)}`;
  }
  await olvidar(n, d);
  return `✅ Aprobado. El reel ${n} queda listo y el asistente de marketing arma su anuncio (pausado, sin gastar).`;
}

/** ❌ Rechazar: primero el motivo. */
export async function pedirMotivo(n: number, d: DepsDelAnfitrion): Promise<string> {
  if (!(await revisionDe(n, d))) return 'Ese reel ya estaba decidido.';
  await d.store.guardarEstado(ANFITRION_RECHAZO, { n });
  return `✏️ Escribime por qué rechazás el reel ${n} (qué cambiar) y el asistente lo rehace.`;
}

/** Hay un motivo esperando? Devuelve el numero de reel y lo deja de esperar: el mensaje que sigue es solo el motivo. */
export async function motivoPendiente(d: Pick<DepsDelAnfitrion, 'store'>): Promise<number | undefined> {
  const p = await d.store.leerEstado<{ n: number } | null>(ANFITRION_RECHAZO);
  if (!p) return undefined;
  await d.store.guardarEstado(ANFITRION_RECHAZO, null);
  return p.n;
}

export async function rechazarRevision(n: number, motivo: string, d: DepsDelAnfitrion): Promise<string> {
  const rev = await revisionDe(n, d);
  if (!rev || !d.anfitrion) return 'Ese reel ya estaba decidido.';
  const limpio = motivo.trim().slice(0, 1000);
  if (!limpio) return 'Necesito el motivo para rechazarlo.';
  try {
    await d.anfitrion.rechazar(rev, limpio);
  } catch (err) {
    // Se vuelve a esperar el motivo: Gero lo reenvia o lo reescribe.
    await d.store.guardarEstado(ANFITRION_RECHAZO, { n });
    return `No pude rechazarlo: ${err instanceof Error ? err.message : String(err)}. Mandame el motivo de nuevo.`;
  }
  await olvidar(n, d);
  return `❌ Rechazado. El asistente rehace el reel ${n} con tu motivo y te llega la tarjeta nueva.`;
}

// ------------------------------------------------------------ arrancar

/** `/arrancar_experimento 150000`: el limite de gasto de la cuenta, en pesos. El host valida y activa; Homero solo pasa el numero. */
export async function arrancarExperimento(tope: number, d: Pick<DepsDelAnfitrion, 'anfitrion'>): Promise<string> {
  if (!d.anfitrion) return 'Homero no tiene configurado el host (SINCRO_HOST_URL).';
  try {
    return await d.anfitrion.arrancar(tope);
  } catch (err) {
    return `No arranqué: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function estadoDelHost(d: Pick<DepsDelAnfitrion, 'anfitrion'>): Promise<string> {
  if (!d.anfitrion) return 'Homero no tiene configurado el host (SINCRO_HOST_URL).';
  try {
    return await d.anfitrion.experimento();
  } catch (err) {
    return `No pude leer el experimento: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ------------------------------------------------------------ anuncios propios en pausa

/** Lo de Meta que lee o publica contenido organico: sigue andando con los anuncios propios en pausa. Todo lo que no esta aca se bloquea. */
const PERMITIDOS: ReadonlySet<string> = new Set([
  'cuenta',
  'buscarIntereses',
  'insights',
  'conjuntos',
  'leads',
  'conConversiones',
  'enviarEtapas',
  'subirReelInstagram',
  'estadoDelContenedor',
  'publicarEnInstagram',
  'subirReelFacebook',
  'metricasDeReel',
  'promocionable',
]);

export const MOTIVO_EN_PAUSA = 'Los anuncios propios de Homero están en pausa: el experimento lo maneja Sincro Host (HOMERO_ANUNCIOS_PROPIOS=no).';

/**
 * Meta de solo lectura (mas el contenido organico y las etapas de los leads): con `HOMERO_ANUNCIOS_PROPIOS=no` Homero no crea
 * campañas, formularios, conjuntos, creativos ni anuncios, ni cambia estados ni presupuestos. Un metodo nuevo de `Meta` queda
 * bloqueado hasta que alguien lo agregue a PERMITIDOS: se falla cerrado.
 */
export function metaSinAnuncios(meta: Meta): Meta {
  return new Proxy(meta, {
    get(destino, propiedad, receptor) {
      const valor = Reflect.get(destino, propiedad, receptor) as unknown;
      if (typeof propiedad !== 'string' || typeof valor !== 'function') return valor;
      if (PERMITIDOS.has(propiedad)) return valor.bind(destino);
      return async () => {
        throw new ErrorDeMeta(MOTIVO_EN_PAUSA);
      };
    },
  });
}
