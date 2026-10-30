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
  display_phone_number?: string;
}

/** Lo que dice Meta de un token de cliente (debug_token). */
export interface RevisionDeToken {
  valido: boolean;
  appId: string | null;
  /** Las WABA a las que el token llega con whatsapp_business_management (target_ids). */
  wabas: string[];
  /** Los business (business_management) y las cuentas publicitarias (ads_management) a los que el token llega. */
  negocios: string[];
  cuentasPublicitarias: string[];
}

/** Una cuenta publicitaria (`act_…`). */
export interface CuentaPublicitaria {
  id: string;
  nombre: string;
  moneda: string | null;
}

/** Una pagina de Facebook a la que llega el token, con su token propio y el Instagram vinculado (si tiene). */
export interface PaginaDeMeta {
  id: string;
  nombre: string;
  /** El token de la pagina: con el se contesta por Messenger e Instagram. */
  token: string;
  instagram: { id: string; usuario: string | null } | null;
}

/** Las dos sincronizaciones que pide la coexistencia, dentro de las 24 h de conectar. */
export type Sincronizacion = 'smb_app_state_sync' | 'history';

export interface NuevaPlantillaEnMeta {
  nombre: string;
  idioma: string;
  categoria: string;
  componentes: unknown[];
}

/** Botones de respuesta (hasta 3) o un boton con link: Meta no deja los dos en el mismo mensaje. */
export type Interactivo = { botones: string[] } | { link: { texto: string; url: string } };

export interface ReelDeInstagram {
  id: string;
  texto: string | null;
  enlace: string | null;
  fecha: string | null;
  duracion_s: number | null;
  mediaUrl: string | null;
  /** La cuenta de Instagram duena del reel (owner.id): una clave compartida no puede leer reels de otra cuenta. */
  ownerId: string | null;
  me_gusta: number | null;
  comentarios: number | null;
}

export interface ClienteMeta {
  enviarTexto(token: string, phoneNumberId: string, a: string, texto: string): Promise<{ wamid: string }>;
  enviarInteractivo(token: string, phoneNumberId: string, a: string, texto: string, i: Interactivo): Promise<{ wamid: string }>;
  enviarPlantilla(
    token: string,
    phoneNumberId: string,
    a: string,
    p: { nombre: string; idioma: string; variables: string[] },
  ): Promise<{ wamid: string }>;
  /**
   * Marca leido su mensaje y le muestra "escribiendo..." hasta que salga la
   * respuesta (o 25 s, lo que pase primero). Va contra el mensaje que entro.
   */
  escribiendo(token: string, phoneNumberId: string, wamid: string): Promise<void>;
  /** Donde bajar un media que llego por webhook (la URL vence en minutos). */
  urlDeMedia(token: string, mediaId: string): Promise<{ url: string; mime: string }>;
  bajarMedia(token: string, url: string): Promise<Buffer>;
  crearPlantilla(token: string, wabaId: string, p: NuevaPlantillaEnMeta): Promise<{ id: string; estado: string; categoria: string }>;
  datosDelNumero(token: string, phoneNumberId: string): Promise<DatosDelNumero>;

  // Instagram y Messenger (la cuenta es `cuentaId`: el ig_user_id o el id de la pagina).
  /** Un mensaje privado dentro de las 24 h. Devuelve el id del mensaje (`mid`). */
  enviarMensajeria(token: string, cuentaId: string, a: string, texto: string): Promise<{ wamid: string }>;
  /** Contesta un comentario en publico. */
  responderComentario(token: string, canal: 'instagram' | 'messenger', comentarioId: string, texto: string): Promise<{ id: string }>;
  /** La respuesta privada a un comentario: una sola, dentro de los 7 dias. */
  respuestaPrivada(token: string, cuentaId: string, comentarioId: string, texto: string): Promise<{ wamid: string }>;
  ocultarComentario(token: string, canal: 'instagram' | 'messenger', comentarioId: string): Promise<void>;
  /** Los reels publicados de la cuenta de Instagram, con lo que Graph da de cada uno (sin metricas). */
  reelsDeLaCuenta(token: string, igId: string, limite: number): Promise<ReelDeInstagram[]>;
  /** Alcance, reproducciones, interacciones, guardados y compartidos de un reel. */
  metricasDelReel(token: string, mediaId: string): Promise<Record<string, number>>;
  /** Un reel por id (null si no existe o no es un reel). */
  reel(token: string, mediaId: string): Promise<ReelDeInstagram | null>;
  /** Prueba que el token ande para esa cuenta (el 190 salta aca aunque nadie este escribiendo). */
  probarCuenta(token: string, cuentaId: string): Promise<void>;

  // Embedded Signup: la empresa conecta su numero.
  /** Cambia el codigo que devolvio el Embedded Signup por el token del cliente (business integration token). */
  canjearCodigo(app: { id: string; secreto: string }, codigo: string): Promise<string>;
  revisarToken(app: { id: string; secreto: string }, token: string): Promise<RevisionDeToken>;
  /** Los phone_number_id de la WABA. */
  numerosDeLaWaba(token: string, wabaId: string): Promise<string[]>;
  /** Suscribe la app a la WABA: sin esto no llegan los webhooks de ese numero. */
  suscribirApp(token: string, wabaId: string): Promise<void>;
  /** Las paginas a las que llega el token (con token de usuario del sistema, las que la empresa eligio al conectar). */
  paginasDelToken(token: string): Promise<PaginaDeMeta[]>;
  /** Suscribe la pagina (y su Instagram) a los webhooks de la app: mensajes, comentarios y feed. */
  suscribirPagina(tokenDePagina: string, paginaId: string): Promise<void>;
  /** Las cuentas publicitarias a las que llega el token (`me/adaccounts`; si no da, las `owned_ad_accounts` de cada business). */
  cuentasPublicitarias(token: string, negocios: string[]): Promise<CuentaPublicitaria[]>;
  /** Los pixeles de una cuenta publicitaria (`act_…`). */
  pixeles(token: string, cuentaId: string): Promise<{ id: string; nombre: string }[]>;
  /** Registra el numero en la Cloud API con un PIN de dos pasos. No va con coexistencia. */
  registrarNumero(token: string, phoneNumberId: string, pin: string): Promise<void>;
  /** Coexistencia: pide a Meta los contactos y el historial del celu (llegan por webhook). */
  sincronizar(token: string, phoneNumberId: string, tipo: Sincronizacion): Promise<void>;
}

/** Meta contesto con error o no contesto. El detalle ya viene tapado. */
export class ErrorDeMeta extends Error {
  /** El código de error de Graph (190: token vencido o revocado), si vino. */
  constructor(
    detalle: string,
    readonly codigo?: number,
  ) {
    super(taparTokens(detalle));
    this.name = 'ErrorDeMeta';
  }
}

/** Meta invalidó el token: no sirve para nada hasta que se reconecte. */
export const esTokenCaido = (e: unknown): boolean => e instanceof ErrorDeMeta && e.codigo === 190;

/** Lo que la app recibe de una pagina: mensajes de Messenger e Instagram, el feed (comentarios de la pagina) y los leads. Los comentarios de Instagram llegan por la suscripcion de la app al objeto Instagram, no por la pagina. */
export const CAMPOS_DE_PAGINA = 'messages,messaging_postbacks,message_reads,message_deliveries,feed,leadgen';

const TECHO_MS = 20_000;
const CAMPOS_REEL = 'id,caption,permalink,timestamp,media_product_type,media_url,owner{id},like_count,comments_count';

const aReel = (f: Record<string, unknown>): ReelDeInstagram => ({
  id: String(f.id ?? ''),
  texto: typeof f.caption === 'string' ? f.caption : null,
  enlace: typeof f.permalink === 'string' ? f.permalink : null,
  fecha: typeof f.timestamp === 'string' ? f.timestamp : null,
  duracion_s: null,
  mediaUrl: typeof f.media_url === 'string' ? f.media_url : null,
  ownerId: typeof (f.owner as { id?: unknown } | undefined)?.id === 'string' ? String((f.owner as { id: string }).id) : null,
  me_gusta: typeof f.like_count === 'number' ? f.like_count : null,
  comentarios: typeof f.comments_count === 'number' ? f.comments_count : null,
});
// Una foto de factura entra holgada; un video de 100 MB no tiene por que.
const MEDIA_MAXIMO = 20 * 1024 * 1024;

export function clienteMeta(version: string, base = 'https://graph.facebook.com'): ClienteMeta {
  const raiz = `${base}/${version}`;

  async function pedir(token: string, metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${raiz}/${ruta}`, {
        method: metodo,
        // Sin token: el canje del codigo, que va con el id y el secreto de la app en la URL.
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
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
      throw new ErrorDeMeta(`${res.status} ${error.code ?? ''} ${error.error_user_msg ?? error.message ?? 'sin detalle'}`.replace(/\s+/g, ' '), error.code);
    }
    return json;
  }

  function wamidDe(json: Record<string, unknown>): { wamid: string } {
    const msgs = json.messages as { id?: string }[] | undefined;
    const wamid = msgs?.[0]?.id;
    if (!wamid) throw new ErrorDeMeta('Meta no devolvio el id del mensaje');
    return { wamid };
  }

  function midDe(json: Record<string, unknown>): { wamid: string } {
    const mid = json.message_id;
    if (typeof mid !== 'string' || !mid) throw new ErrorDeMeta('Meta no devolvio el id del mensaje');
    return { wamid: mid };
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
    async enviarInteractivo(token, phoneNumberId, a, texto, i) {
      const interactive =
        'botones' in i
          ? {
              type: 'button',
              body: { text: texto },
              action: { buttons: i.botones.map((title, n) => ({ type: 'reply', reply: { id: `b${n + 1}`, title } })) },
            }
          : {
              type: 'cta_url',
              body: { text: texto },
              action: { name: 'cta_url', parameters: { display_text: i.link.texto, url: i.link.url } },
            };
      return wamidDe(
        await pedir(token, 'POST', `${phoneNumberId}/messages`, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: a,
          type: 'interactive',
          interactive,
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
    async escribiendo(token, phoneNumberId, wamid) {
      await pedir(token, 'POST', `${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
        typing_indicator: { type: 'text' },
      });
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
    async enviarMensajeria(token, cuentaId, a, texto) {
      const json = await pedir(token, 'POST', `${cuentaId}/messages`, { recipient: { id: a }, messaging_type: 'RESPONSE', message: { text: texto } });
      return midDe(json);
    },
    async responderComentario(token, canal, comentarioId, texto) {
      const json = await pedir(token, 'POST', `${comentarioId}/${canal === 'instagram' ? 'replies' : 'comments'}`, { message: texto });
      return { id: String(json.id ?? '') };
    },
    async respuestaPrivada(token, cuentaId, comentarioId, texto) {
      const json = await pedir(token, 'POST', `${cuentaId}/messages`, { recipient: { comment_id: comentarioId }, message: { text: texto } });
      return midDe(json);
    },
    async ocultarComentario(token, canal, comentarioId) {
      await pedir(token, 'POST', comentarioId, canal === 'instagram' ? { hide: true } : { is_hidden: true });
    },
    async reelsDeLaCuenta(token, igId, limite) {
      const json = await pedir(token, 'GET', `${igId}/media?fields=${CAMPOS_REEL}&limit=${Math.min(Math.max(limite, 1), 100)}`);
      const filas = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
      return filas.filter((f) => f.media_product_type === 'REELS').map(aReel);
    },
    async reel(token, mediaId) {
      const f = await pedir(token, 'GET', `${encodeURIComponent(mediaId)}?fields=${CAMPOS_REEL}`);
      return f.media_product_type === 'REELS' ? aReel(f) : null;
    },
    async metricasDelReel(token, mediaId) {
      const json = await pedir(token, 'GET', `${encodeURIComponent(mediaId)}/insights?metric=reach,views,total_interactions,saved,shares`);
      const out: Record<string, number> = {};
      for (const m of Array.isArray(json.data) ? (json.data as Record<string, any>[]) : []) {
        const v = m.values?.[0]?.value ?? m.total_value?.value;
        if (typeof m.name === 'string' && typeof v === 'number') out[m.name] = v;
      }
      return out;
    },
    async probarCuenta(token, cuentaId) {
      await pedir(token, 'GET', `${cuentaId}?fields=id`);
    },
    async datosDelNumero(token, phoneNumberId) {
      return (await pedir(
        token,
        'GET',
        `${phoneNumberId}?fields=quality_rating,messaging_limit_tier,status,verified_name,display_phone_number`,
      )) as DatosDelNumero;
    },
    async canjearCodigo(app, codigo) {
      const q = new URLSearchParams({ client_id: app.id, client_secret: app.secreto, code: codigo });
      const json = await pedir('', 'GET', `oauth/access_token?${q}`);
      if (typeof json.access_token !== 'string' || !json.access_token) throw new ErrorDeMeta('Meta no devolvio el token');
      return json.access_token;
    },
    async revisarToken(app, token) {
      const json = await pedir(`${app.id}|${app.secreto}`, 'GET', `debug_token?input_token=${encodeURIComponent(token)}`);
      const d = (json.data ?? {}) as { is_valid?: boolean; app_id?: string; granular_scopes?: { scope?: string; target_ids?: string[] }[] };
      const gestion = (d.granular_scopes ?? []).find((g) => g.scope === 'whatsapp_business_management');
      const ids = (scope: string) => (d.granular_scopes ?? []).filter((g) => g.scope === scope).flatMap((g) => (g.target_ids ?? []).map(String));
      return {
        valido: d.is_valid === true,
        appId: d.app_id ? String(d.app_id) : null,
        wabas: (gestion?.target_ids ?? []).map(String),
        negocios: ids('business_management'),
        cuentasPublicitarias: ids('ads_management'),
      };
    },
    async numerosDeLaWaba(token, wabaId) {
      const json = await pedir(token, 'GET', `${wabaId}/phone_numbers?fields=id&limit=100`);
      return (Array.isArray(json.data) ? (json.data as { id?: unknown }[]) : []).map((f) => String(f.id ?? '')).filter(Boolean);
    },
    async suscribirApp(token, wabaId) {
      await pedir(token, 'POST', `${wabaId}/subscribed_apps`);
    },
    async paginasDelToken(token) {
      const json = await pedir(token, 'GET', 'me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100');
      const filas = Array.isArray(json.data) ? (json.data as Record<string, any>[]) : [];
      return filas
        .filter((f) => f.id && typeof f.access_token === 'string' && f.access_token)
        .map((f) => ({
          id: String(f.id),
          nombre: String(f.name ?? ''),
          token: f.access_token as string,
          instagram: f.instagram_business_account?.id
            ? { id: String(f.instagram_business_account.id), usuario: typeof f.instagram_business_account.username === 'string' ? f.instagram_business_account.username : null }
            : null,
        }));
    },
    async suscribirPagina(tokenDePagina, paginaId) {
      await pedir(tokenDePagina, 'POST', `${encodeURIComponent(paginaId)}/subscribed_apps`, { subscribed_fields: CAMPOS_DE_PAGINA });
    },
    async cuentasPublicitarias(token, negocios) {
      const campos = 'id,name,currency,account_id';
      const aCuentas = (json: Record<string, unknown>): CuentaPublicitaria[] =>
        (Array.isArray(json.data) ? (json.data as Record<string, any>[]) : [])
          .filter((f) => f.id)
          .map((f) => ({
            id: String(f.id).startsWith('act_') ? String(f.id) : `act_${f.id}`,
            nombre: String(f.name ?? ''),
            moneda: typeof f.currency === 'string' ? f.currency : null,
          }));
      // Token de usuario (o de usuario del sistema con cuentas asignadas): me/adaccounts. Token de business: las del business.
      let cuentas = aCuentas(await pedir(token, 'GET', `me/adaccounts?fields=${campos}&limit=100`));
      for (const negocio of negocios) {
        if (cuentas.length) break;
        cuentas = aCuentas(await pedir(token, 'GET', `${encodeURIComponent(negocio)}/owned_ad_accounts?fields=${campos}&limit=100`));
      }
      return cuentas;
    },
    async pixeles(token, cuentaId) {
      const json = await pedir(token, 'GET', `${encodeURIComponent(cuentaId)}/adspixels?fields=id,name&limit=100`);
      return (Array.isArray(json.data) ? (json.data as Record<string, any>[]) : []).filter((f) => f.id).map((f) => ({ id: String(f.id), nombre: String(f.name ?? '') }));
    },
    async registrarNumero(token, phoneNumberId, pin) {
      await pedir(token, 'POST', `${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin });
    },
    async sincronizar(token, phoneNumberId, tipo) {
      await pedir(token, 'POST', `${phoneNumberId}/smb_app_data`, { messaging_product: 'whatsapp', sync_type: tipo });
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
