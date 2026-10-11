import { taparTokens } from './tapar.js';

/**
 * El cliente de la Cloud API de WhatsApp (Graph).
 *
 * Con `fetch` y no con `node:http` como el gateway de Homero: aca todo pedido
 * es corto (mandar un mensaje, bajar una foto) y el techo de 300 s de undici
 * no molesta. Cada pedido lleva su propio techo para no colgar el webhook.
 *
 * Todo error sale tapado: Meta devuelve el token entero en algunos mensajes.
 */

export interface DatosDelNumero {
  quality_rating?: string;
  messaging_limit_tier?: string;
  status?: string;
  verified_name?: string;
}

export interface NuevaPlantillaEnMeta {
  nombre: string;
  idioma: string;
  categoria: string;
  componentes: unknown[];
}

export interface ClienteMeta {
  enviarTexto(token: string, phoneNumberId: string, a: string, texto: string): Promise<{ wamid: string }>;
  enviarPlantilla(
    token: string,
    phoneNumberId: string,
    a: string,
    p: { nombre: string; idioma: string; variables: string[] },
  ): Promise<{ wamid: string }>;
  /** Donde bajar un media que llego por webhook (la URL vence en minutos). */
  urlDeMedia(token: string, mediaId: string): Promise<{ url: string; mime: string }>;
  bajarMedia(token: string, url: string): Promise<Buffer>;
  crearPlantilla(token: string, wabaId: string, p: NuevaPlantillaEnMeta): Promise<{ id: string; estado: string; categoria: string }>;
  datosDelNumero(token: string, phoneNumberId: string): Promise<DatosDelNumero>;
}

/** Meta contesto con error o no contesto. El detalle ya viene tapado. */
export class ErrorDeMeta extends Error {
  constructor(detalle: string) {
    super(taparTokens(detalle));
    this.name = 'ErrorDeMeta';
  }
}

const TECHO_MS = 20_000;
// Una foto de factura entra holgada; un video de 100 MB no tiene por que.
const MEDIA_MAXIMO = 20 * 1024 * 1024;

export function clienteMeta(version: string, base = 'https://graph.facebook.com'): ClienteMeta {
  const raiz = `${base}/${version}`;

  async function pedir(token: string, metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${raiz}/${ruta}`, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(TECHO_MS),
      });
    } catch (e) {
      throw new ErrorDeMeta(`sin respuesta de Meta: ${e instanceof Error ? e.message : String(e)}`);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Sin JSON queda el status.
    }
    if (!res.ok) {
      const error = (json.error ?? {}) as { message?: string; code?: number; error_user_msg?: string };
      throw new ErrorDeMeta(`${res.status} ${error.code ?? ''} ${error.error_user_msg ?? error.message ?? 'sin detalle'}`.replace(/\s+/g, ' '));
    }
    return json;
  }

  function wamidDe(json: Record<string, unknown>): { wamid: string } {
    const msgs = json.messages as { id?: string }[] | undefined;
    const wamid = msgs?.[0]?.id;
    if (!wamid) throw new ErrorDeMeta('Meta no devolvio el id del mensaje');
    return { wamid };
  }

  return {
    async enviarTexto(token, phoneNumberId, a, texto) {
      return wamidDe(
        await pedir(token, 'POST', `${phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: a,
          type: 'text',
          text: { body: texto, preview_url: false },
        }),
      );
    },
    async enviarPlantilla(token, phoneNumberId, a, p) {
      return wamidDe(
        await pedir(token, 'POST', `${phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: a,
          type: 'template',
          template: {
            name: p.nombre,
            language: { code: p.idioma },
            ...(p.variables.length
              ? { components: [{ type: 'body', parameters: p.variables.map((text) => ({ type: 'text', text })) }] }
              : {}),
          },
        }),
      );
    },
    async urlDeMedia(token, mediaId) {
      const json = await pedir(token, 'GET', encodeURIComponent(mediaId));
      if (typeof json.url !== 'string') throw new ErrorDeMeta('Meta no devolvio la URL del archivo');
      return { url: json.url, mime: typeof json.mime_type === 'string' ? json.mime_type : 'application/octet-stream' };
    },
    async bajarMedia(token, url) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TECHO_MS) });
      } catch (e) {
        throw new ErrorDeMeta(`no se pudo bajar el archivo: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new ErrorDeMeta(`no se pudo bajar el archivo: ${res.status}`);
      // Se corta mientras baja y no despues: Meta acepta videos de 100 MB, y
      // juntarlos enteros en memoria antes de mirar el tamaño tumba el proceso.
      const largo = Number(res.headers.get('content-length') ?? 0);
      if (largo > MEDIA_MAXIMO || !res.body) {
        await res.body?.cancel();
        throw new ErrorDeMeta(res.body ? 'el archivo es demasiado grande' : 'el archivo vino vacio');
      }
      const partes: Buffer[] = [];
      let total = 0;
      for await (const parte of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += parte.length;
        if (total > MEDIA_MAXIMO) throw new ErrorDeMeta('el archivo es demasiado grande');
        partes.push(Buffer.from(parte));
      }
      return Buffer.concat(partes);
    },
    async crearPlantilla(token, wabaId, p) {
      const json = await pedir(token, 'POST', `${wabaId}/message_templates`, {
        name: p.nombre,
        language: p.idioma,
        category: p.categoria,
        components: p.componentes,
      });
      return {
        id: String(json.id ?? ''),
        estado: typeof json.status === 'string' ? json.status : 'PENDING',
        categoria: typeof json.category === 'string' ? json.category : p.categoria,
      };
    },
    async datosDelNumero(token, phoneNumberId) {
      return (await pedir(
        token,
        'GET',
        `${phoneNumberId}?fields=quality_rating,messaging_limit_tier,status,verified_name`,
      )) as DatosDelNumero;
    },
  };
}

/** `TIER_250` → 250, `TIER_1K` → 1000, `TIER_UNLIMITED` → null (sin tope). */
export function topeDeTier(tier: string | undefined): number | null | undefined {
  if (!tier) return undefined;
  if (tier === 'TIER_UNLIMITED') return null;
  const m = /^TIER_(\d+)(K?)$/.exec(tier);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}
