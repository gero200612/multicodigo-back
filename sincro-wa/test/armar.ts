import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Contexto, Push } from '../src/contexto.js';
import { Despertador } from '../src/eventos.js';
import { ErrorDeMeta, type ClienteMeta, type DatosDelNumero } from '../src/meta.js';
import { crearPrivado } from '../src/privado.js';
import { crearPublico } from '../src/publico.js';
import { MemoriaStore } from './memoria.js';

export const SECRETO_APP = 'secreto-de-la-app-de-meta';
export const VERIFY = 'verificame';
export const CLAVE_ADMIN = 'admin-'.padEnd(40, 'x');

/** Un Meta que anota todo y contesta lo que el test le diga. */
export class MetaFalsa implements ClienteMeta {
  enviados: { tipo: 'texto' | 'plantilla'; token: string; desde: string; a: string; texto?: string; plantilla?: string; variables?: string[] }[] = [];
  creadas: { wabaId: string; nombre: string; categoria: string }[] = [];
  fallar: string | null = null;
  categoriaAlCrear: string | null = null;
  datos: DatosDelNumero = { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250', status: 'CONNECTED', verified_name: 'Sincro' };
  archivos = new Map<string, { mime: string; datos: Buffer }>();
  private n = 0;

  private revisar() {
    if (this.fallar) throw new ErrorDeMeta(this.fallar);
  }
  async enviarTexto(token: string, desde: string, a: string, texto: string) {
    this.revisar();
    this.enviados.push({ tipo: 'texto', token, desde, a, texto });
    return { wamid: `wamid.sale.${++this.n}` };
  }
  async enviarPlantilla(token: string, desde: string, a: string, p: { nombre: string; idioma: string; variables: string[] }) {
    this.revisar();
    this.enviados.push({ tipo: 'plantilla', token, desde, a, plantilla: p.nombre, variables: p.variables });
    return { wamid: `wamid.sale.${++this.n}` };
  }
  async urlDeMedia(_token: string, mediaId: string) {
    const a = this.archivos.get(mediaId);
    if (!a) throw new ErrorDeMeta('no existe');
    return { url: `https://meta.falsa/${mediaId}`, mime: a.mime };
  }
  async bajarMedia(_token: string, url: string) {
    return this.archivos.get(url.split('/').pop()!)!.datos;
  }
  async crearPlantilla(_token: string, wabaId: string, p: { nombre: string; categoria: string }) {
    this.revisar();
    this.creadas.push({ wabaId, nombre: p.nombre, categoria: p.categoria });
    return { id: `tpl-${++this.n}`, estado: 'PENDING', categoria: this.categoriaAlCrear ?? p.categoria };
  }
  async datosDelNumero() {
    return this.datos;
  }
}

export interface Banco {
  ctx: Contexto;
  store: MemoriaStore;
  meta: MetaFalsa;
  publico: FastifyInstance;
  privado: FastifyInstance;
  reloj: { ahora: Date; avanzar(ms: number): void };
  pushes: { url: string; cuerpo: string; firma: string }[];
  pushOk: { valor: boolean };
  logs: string[];
}

export function armar(): Banco {
  const store = new MemoriaStore();
  const meta = new MetaFalsa();
  const reloj = {
    ahora: new Date('2026-10-10T15:00:00.000Z'),
    avanzar(ms: number) {
      this.ahora = new Date(this.ahora.getTime() + ms);
    },
  };
  const pushes: Banco['pushes'] = [];
  const pushOk = { valor: true };
  const push: Push = async (url, cuerpo, firma) => {
    pushes.push({ url, cuerpo, firma });
    return pushOk.valor;
  };
  const logs: string[] = [];
  const ctx: Contexto = {
    store,
    meta,
    ahora: () => reloj.ahora,
    claveCifrado: randomBytes(32),
    tokenMeta: 'EAAtokenDelSystemUser123',
    despertador: new Despertador(),
    push,
    log: (t) => logs.push(t),
  };
  return {
    ctx,
    store,
    meta,
    publico: crearPublico(ctx, { appSecret: SECRETO_APP, verifyToken: VERIFY }),
    privado: crearPrivado(ctx, { claveAdmin: CLAVE_ADMIN }),
    reloj,
    pushes,
    pushOk,
    logs,
  };
}

const auth = (clave: string) => ({ authorization: `Bearer ${clave}` });

export async function pedir(
  b: Banco,
  clave: string | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
) {
  const res = await b.privado.inject({ method, url, headers: clave ? auth(clave) : {}, payload: payload as any });
  let json: any = undefined;
  try {
    json = res.json();
  } catch {
    // binario
  }
  return { status: res.statusCode, json, res };
}

let siguienteNumero = 1000;

/** Da de alta un negocio con un numero, como lo haria Homero. */
export async function negocioConNumero(
  b: Banco,
  capacidades: string[],
  extra: { tope?: number; urlBase?: string; nombre?: string } = {},
) {
  const alta = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/negocios', {
    nombre: extra.nombre ?? `Negocio ${capacidades.join('+')}`,
    app: 'prueba',
    capacidades,
    tope_mensual_ars: extra.tope ?? 100_000,
    ...(extra.urlBase ? { url_base: extra.urlBase } : {}),
    quien: 'gero',
  });
  if (alta.status !== 201) throw new Error(`alta: ${alta.status} ${JSON.stringify(alta.json)}`);
  const phoneNumberId = String(++siguienteNumero * 1000);
  const wabaId = `9${phoneNumberId}`;
  const num = await pedir(b, CLAVE_ADMIN, 'POST', '/admin/numeros', {
    negocio_id: alta.json.negocio.id,
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    quien: 'gero',
  });
  if (num.status !== 201) throw new Error(`numero: ${num.status} ${JSON.stringify(num.json)}`);
  return {
    id: alta.json.negocio.id as number,
    clave: alta.json.clave as string,
    secreto: alta.json.secreto_eventos as string,
    phoneNumberId,
    wabaId,
    numeroId: num.json.numero.id as number,
  };
}

export function firmar(cuerpo: string, secreto = SECRETO_APP): string {
  return `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
}

export async function webhook(b: Banco, cuerpo: unknown, firma?: string | null) {
  const texto = JSON.stringify(cuerpo);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const f = firma === undefined ? firmar(texto) : firma;
  if (f) headers['x-hub-signature-256'] = f;
  return b.publico.inject({ method: 'POST', url: '/webhook', headers, payload: texto });
}

let siguienteWamid = 1;

export function cambioDeMensajes(phoneNumberId: string, valor: Record<string, unknown>, field = 'messages', waba = '1') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: waba, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...valor } }] }],
  };
}

/** Un mensaje entrante de texto (o lo que se le pase en `m`). */
export function entrante(phoneNumberId: string, de: string, m: Record<string, unknown> = {}) {
  const mensaje = { from: de, id: `wamid.entra.${siguienteWamid++}`, timestamp: '1760108400', type: 'text', text: { body: 'hola' }, ...m };
  return cambioDeMensajes(phoneNumberId, { contacts: [{ wa_id: de, profile: { name: 'Juan' } }], messages: [mensaje] });
}

export function texto(phoneNumberId: string, de: string, body: string) {
  return entrante(phoneNumberId, de, { type: 'text', text: { body } });
}

export function estado(phoneNumberId: string, wamid: string, status: string, extra: Record<string, unknown> = {}) {
  return cambioDeMensajes(phoneNumberId, {
    statuses: [{ id: wamid, status, timestamp: '1760108400', recipient_id: '5491100000000', ...extra }],
  });
}

/** Una plantilla aprobada directo en la base, sin pasar por Meta. */
export async function plantillaAprobada(b: Banco, negocioId: number, wabaId: string, nombre: string, categoria: 'UTILITY' | 'MARKETING') {
  return b.store.crearPlantilla({
    negocioId,
    wabaId,
    metaId: `meta-${nombre}`,
    nombre,
    idioma: 'es_AR',
    categoria,
    componentes: [{ type: 'BODY', text: 'Hola {{1}}' }],
    estado: 'APPROVED',
    motivo: null,
    bloqueada: false,
  });
}
