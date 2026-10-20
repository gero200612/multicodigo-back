import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Meta } from './meta.js';
import { ErrorDeMeta } from './meta.js';
import type { CalidadDeLead, EstadoDeLead, Lead, OrigenDeCalidad, Store } from './store.js';
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
  /** Sirve o no sirve (la marco Gero o la clasifico Homero solo). */
  calidad?: CalidadDeLead;
  origen_calidad?: OrigenDeCalidad;
  /** Corto y sin datos de personas: pasa por {@link motivoSeguro}. */
  motivo_calidad?: string;
  /** Hasta donde llego: respondio, tiene reunion, es cliente o se perdio. */
  etapa?: EtapaDeLead;
}

export type EtapaDeLead = 'respondio' | 'reunion' | 'cliente' | 'perdido';

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
        ...(l.calidad ? { calidad: l.calidad } : {}),
        ...(l.calidad && l.origen_calidad ? { origen_calidad: l.origen_calidad } : {}),
        ...(l.calidad && l.motivo_calidad ? { motivo_calidad: l.motivo_calidad } : {}),
        ...(l.etapa ? { etapa: l.etapa } : {}),
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

/**
 * El motivo de una calidad, apto para salir de Homero: una sola linea, hasta 120 caracteres y sin nada que parezca un dato
 * de una persona (un mail o 6+ digitos seguidos, que es un telefono). Si lo tiene, no sale: `undefined`.
 */
export function motivoSeguro(motivo: string | undefined | null): string | undefined {
  const m = (motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!m || m.includes('@') || /\d{6,}/.test(m)) return undefined;
  return m;
}

/** Del estado del lead en Homero a la etapa que entiende el host. Lo demas no cambia la etapa. */
export function etapaDeEstado(estado: EstadoDeLead): EtapaDeLead | undefined {
  switch (estado) {
    case 'respondio':
      return 'respondio';
    case 'reunion':
      return 'reunion';
    case 'cerrado':
      return 'cliente';
    case 'baja':
    case 'descartado':
      return 'perdido';
    default:
      return undefined;
  }
}

/**
 * El id con el que el host conoce a un lead (el mismo que cuando entro): `meta-<leadgen>`, `web-<evento>` o `wa-<hash>`.
 * Los leads de prospeccion (OSM, Google) y los que escriben por mail no van al host.
 */
export function idParaElAnfitrion(l: Pick<Lead, 'leadgenId' | 'telefono' | 'fuente'>): { id: string; fuente: FuenteDeLead } | undefined {
  if (l.leadgenId && /^\d+$/.test(l.leadgenId)) return { id: idDeLeadDeMeta(l.leadgenId), fuente: 'meta_form' };
  if (l.leadgenId?.startsWith('web:')) return { id: idDeLeadDeLaWeb(l.leadgenId.slice(4)), fuente: 'web' };
  if (l.fuente === 'whatsapp' && l.telefono) return { id: idDeLeadDeWhatsapp(l.telefono), fuente: 'whatsapp' };
  return undefined;
}

/** Lo que se le cuenta al host de un lead de Homero. Nunca nombre, mail ni telefono. */
export function leadParaElAnfitrion(l: Lead, etapa?: EtapaDeLead, anuncio?: string): LeadParaElAnfitrion | undefined {
  const destino = idParaElAnfitrion(l);
  if (!destino) return undefined;
  const motivo = l.calidadOrigen === 'auto' ? motivoSeguro(l.calidadMotivo) : undefined;
  return {
    id: destino.id,
    fuente: destino.fuente,
    creado: l.creado ?? new Date(),
    ...(anuncio ? { anuncio } : {}),
    ...(l.calidad ? { calidad: l.calidad, origen_calidad: l.calidadOrigen ?? 'dueño' } : {}),
    ...(l.calidad && motivo ? { motivo_calidad: motivo } : {}),
    ...(etapa ? { etapa } : {}),
  };
}

type EcoDelAnfitrion = Pick<Store, 'lead' | 'anuncio'>;

/**
 * El store con un eco al host: cada vez que cambia la calidad de un lead (la automatica o el boton de Gero) o llega a una etapa
 * (respondio, reunion, cliente, perdido), se lo cuenta. Va por aca y no en cada lugar que cambia el estado porque son muchos
 * (WhatsApp, mail, agentes, Telegram). Sin host no hace nada; el aviso sale en segundo plano (no frena a quien cambia el lead) y si el host no contesta se reintenta una vez.
 */
export function conEcoAlAnfitrion<S extends Store>(store: S, host: ClienteDelAnfitrion | undefined, log: (t: string) => void = console.warn): S {
  if (!host) return store;
  // Una etapa repetida (WhatsApp marca "respondio" en cada mensaje) no se vuelve a mandar mientras el proceso siga vivo.
  const mandadas = new Set<string>();
  async function eco(leadId: number, etapa?: EtapaDeLead): Promise<void> {
    try {
      const clave = etapa ? `${leadId}:${etapa}` : undefined;
      if (clave && mandadas.has(clave)) return;
      // Se anota ya: dos cambios seguidos al mismo estado no salen dos veces; si no llega, se desanota para el proximo intento.
      if (clave) mandadas.add(clave);
      const lead = await (store as EcoDelAnfitrion).lead(leadId);
      if (!lead) return void (clave && mandadas.delete(clave));
      const anuncio = lead.anuncioId === undefined ? undefined : (await (store as EcoDelAnfitrion).anuncio(lead.anuncioId))?.metaIds.anuncio;
      const l = leadParaElAnfitrion(lead, etapa, anuncio);
      if (!l) return void (clave && mandadas.delete(clave));
      if (!(await reenviarLead(host, l, log)) && clave) mandadas.delete(clave);
    } catch (err) {
      if (etapa) mandadas.delete(`${leadId}:${etapa}`);
      log(`[homero] no pude armar el aviso del lead ${leadId} para el host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return new Proxy(store, {
    get(destino, propiedad, receptor) {
      const valor = Reflect.get(destino, propiedad, receptor) as unknown;
      if (typeof valor !== 'function') return valor;
      const f = valor as (...a: unknown[]) => unknown;
      switch (propiedad) {
        case 'marcarCalidad':
        case 'guardarCalidadAuto':
          return async (leadId: number, ...resto: unknown[]) => {
            const r = (await f.call(destino, leadId, ...resto)) as Lead | undefined;
            if (r) void eco(leadId);
            return r;
          };
        case 'actualizarLead':
          return async (id: number, cambios: { estado?: EstadoDeLead }) => {
            await f.call(destino, id, cambios);
            const etapa = cambios.estado ? etapaDeEstado(cambios.estado) : undefined;
            if (etapa) void eco(id, etapa);
          };
        case 'crearReunion':
          return async (r: { leadId: number }) => {
            const id = await f.call(destino, r);
            if (id !== undefined) void eco(r.leadId, 'reunion');
            return id;
          };
        default:
          return f.bind(destino);
      }
    },
  });
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
