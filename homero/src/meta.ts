import { createHash } from 'node:crypto';
/**
 * El cliente de Meta (spec 2026-10-08-homero-anuncios-meta, seccion 1): la API
 * de marketing de Facebook e Instagram, con `fetch` a graph.facebook.com.
 *
 * Es una interfaz, como `Correo` en envio.ts: los tests usan una falsa y nunca
 * tocan la red. Lo que se puede hacer con la plata (cuanto, cuando, con el OK
 * de quien) NO esta aca: esta en anuncios.ts. Este archivo solo traduce.
 *
 * El token viaja en el header `Authorization`, nunca en la URL: asi no aparece
 * en un log de error ni en el `paging.next` que devuelve Meta. Y cualquier
 * texto de error que salga de aca pasa por `ocultar`, por si Meta lo repite.
 *
 * Los reels (spec 2026-10-08-homero-reels) se suman despues con `subirVideo` y
 * un creativo de video; el resto (conjunto, anuncio, insights) es el mismo.
 */

export interface ConfigDeMeta {
  token: string;
  /** La cuenta publicitaria, con o sin `act_`. */
  cuenta: string;
  pagina: string;
  app?: string;
  /** El conjunto de datos de conversiones de leads. Sin esto no se le cuenta nada a Meta. */
  dataset?: string;
  /** `v23.0`. Fija: un cambio de version de la API se prueba antes con meta-humo. */
  version: string;
}

/** Una pregunta del formulario. Las estandar las completa Meta con el perfil. */
export type Pregunta =
  | { tipo: 'FULL_NAME' | 'EMAIL' | 'PHONE' | 'COMPANY_NAME' | 'CITY' }
  | { tipo: 'CUSTOM'; clave: string; texto: string; opciones?: { clave: string; texto: string }[] };

export interface FormularioNuevo {
  nombre: string;
  preguntas: Pregunta[];
  privacidad: string;
  web: string;
  /** El texto de la pantalla de gracias. */
  gracias: string;
}

export interface ConjuntoNuevo {
  campana: string;
  nombre: string;
  /** En pesos. La conversion a centavos la hace el cliente. */
  diario: number;
  /** Ids de intereses de Meta (de `buscarIntereses`). Vacio = sin intereses. */
  intereses: { id: string; name: string }[];
}

export interface CreativoNuevo {
  nombre: string;
  imagenHash: string;
  titulo: string;
  texto: string;
  formulario: string;
  web: string;
}

/** Una fila de insights: un anuncio en un dia. Gasto en pesos, no en centavos. */
export interface FilaDeInsights {
  anuncio: string;
  /** El conjunto del anuncio: con esto se atribuye un anuncio que Homero no creo (duplicado a mano). */
  conjunto?: string;
  /** La campaña: lo de otras campañas de la cuenta no es de Homero. */
  campana?: string;
  dia: string;
  gasto: number;
  impresiones: number;
  consultas: number;
}

export interface LeadDeMeta {
  /** El `leadgen_id`: lo que hace que el mismo lead no entre dos veces. */
  id: string;
  creado: Date;
  anuncio?: string;
  formulario: string;
  /** Las respuestas, por el nombre del campo (`full_name`, `email`, la clave de una propia). */
  campos: Record<string, string>;
}

export interface CuentaDeMeta {
  nombre: string;
  moneda: string;
  estado: number;
  /** Lo gastado desde siempre, en pesos. */
  gastado: number;
  /** El limite de gasto de la cuenta en pesos; 0 = sin limite. */
  limite: number;
  /** El diario minimo que acepta Meta para esta cuenta, en pesos (si lo informa). */
  minimoDiario?: number;
}

export type EstadoEnMeta = 'ACTIVE' | 'PAUSED';

/** Lo que paso con una consulta de un formulario, para que Meta aprenda a quien mostrarle. */
export interface EtapaDeLead {
  /** El leadgen_id de Meta. */
  leadgenId: string;
  /** `Lead` es la etapa inicial: Meta pide mandar todas, la primera incluida. */
  etapa: 'Lead' | 'Calificado' | 'Descalificado' | 'Reunion';
  cuando: Date;
  /** Para que Meta reconozca mejor a la persona. Van cifrados (SHA-256), nunca en claro. */
  email?: string;
  /** Solo digitos, con codigo de pais (549...). */
  telefono?: string;
}

/** SHA-256 en hex, como pide Meta para los datos de contacto. */
export function cifrarParaMeta(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/** Lo que identifica a la persona en el evento: el lead_id y, si hay, mail y telefono cifrados. */
export function datosDeLaPersona(e: EtapaDeLead): Record<string, unknown> {
  const id = Number(e.leadgenId);
  return {
    // Hasta 16 digitos entra exacto como numero; si no, va como texto.
    lead_id: Number.isSafeInteger(id) ? id : e.leadgenId,
    ...(e.email ? { em: [cifrarParaMeta(e.email.trim().toLowerCase())] } : {}),
    ...(e.telefono ? { ph: [cifrarParaMeta(e.telefono.replace(/\D/g, ''))] } : {}),
  };
}

export interface ConjuntoEnMeta {
  id: string;
  /** Sin diario propio (presupuesto de campaña) viene sin esto. */
  diario?: number;
  /** effective_status: ACTIVE, PAUSED, CAMPAIGN_PAUSED, DELETED, ARCHIVED, ... */
  estado: string;
}

export interface Meta {
  cuenta(): Promise<CuentaDeMeta>;
  crearCampana(nombre: string): Promise<string>;
  subirImagen(png: Buffer, nombre: string): Promise<string>;
  crearFormulario(f: FormularioNuevo): Promise<string>;
  buscarIntereses(texto: string): Promise<{ id: string; name: string }[]>;
  crearConjunto(c: ConjuntoNuevo): Promise<string>;
  crearCreativo(c: CreativoNuevo): Promise<string>;
  crearAnuncio(a: { nombre: string; conjunto: string; creativo: string }): Promise<string>;
  /** Campaña, conjunto o anuncio. */
  cambiarEstado(id: string, estado: EstadoEnMeta): Promise<void>;
  /** Le pone otro creativo a un anuncio que ya existe (Meta lo vuelve a revisar). */
  cambiarCreativo(anuncio: string, creativo: string): Promise<void>;
  /** El diario de un conjunto, en pesos. */
  cambiarDiario(conjunto: string, diario: number): Promise<void>;
  /** Por anuncio y por dia, entre dos dias (AAAA-MM-DD) inclusive. */
  insights(desde: string, hasta: string): Promise<FilaDeInsights[]>;
  /** Los conjuntos de una campaña como estan en Meta: diario (pesos) y estado efectivo. Incluye los borrados. */
  conjuntos(campana: string): Promise<ConjuntoEnMeta[]>;
  /** Los leads de un formulario desde un instante. */
  leads(formulario: string, desde: Date): Promise<LeadDeMeta[]>;
  /** Hay conjunto de datos para contarle a Meta que paso con las consultas. */
  conConversiones(): boolean;
  /** Las etapas de las consultas (conversiones de leads). Devuelve cuantas recibio Meta. */
  enviarEtapas(etapas: EtapaDeLead[]): Promise<number>;

  // ---- Reels (spec 2026-10-13-homero-subir-reels)
  /**
   * Crea el contenedor de un reel de IG y le sube el video directo (resumable):
   * sin URL publica. Con `prueba`, es un reel de prueba que Instagram pasa a
   * los seguidores solo si rinde. Devuelve el id del contenedor.
   */
  subirReelInstagram(video: Buffer, o: { caption: string; prueba: boolean }): Promise<string>;
  /** `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED` o `PUBLISHED`, y el detalle que da Meta. */
  estadoDelContenedor(contenedor: string): Promise<{ estado: string; detalle?: string }>;
  /** Publica un contenedor ya `FINISHED`. Devuelve el id del media. */
  publicarEnInstagram(contenedor: string): Promise<string>;
  /** Sube y publica el reel en la pagina de Facebook. Devuelve el id del video. */
  subirReelFacebook(video: Buffer, descripcion: string): Promise<string>;
  metricasDeReel(media: string): Promise<MetricasDeReel>;
  /** Si Meta deja promocionar ese media (p. ej. no, con musica con derechos). */
  promocionable(media: string): Promise<{ ok: true } | { ok: false; motivo: string }>;
  /** Un creativo que usa el reel publicado tal cual, con el boton al formulario. */
  crearCreativoDeReel(c: { nombre: string; media: string; formulario: string; web: string }): Promise<string>;
}

/** Lo que se lee de un reel de IG. El promedio de reproduccion, en milisegundos. */
export interface MetricasDeReel {
  alcance: number;
  vistas: number;
  guardados: number;
  compartidos: number;
  likes: number;
  comentarios: number;
  promedioMs: number;
}

/** Los nombres de las metricas de Meta, en el orden en que se piden. */
const METRICAS_DE_REEL: Record<string, keyof MetricasDeReel> = {
  reach: 'alcance',
  views: 'vistas',
  saved: 'guardados',
  shares: 'compartidos',
  likes: 'likes',
  comments: 'comentarios',
  ig_reels_avg_watch_time: 'promedioMs',
};

/**
 * Meta cuenta los presupuestos en la unidad minima de la moneda: para ARS,
 * centavos (`daily_budget: 150000` son $1.500). Los gastos de insights, en
 * cambio, vienen en pesos con decimales. Se convierte en un solo lugar.
 */
export const CENTAVOS_POR_PESO = 100;
export const aCentavos = (pesos: number): number => Math.round(pesos * CENTAVOS_POR_PESO);
export const dePesos = (centavos: number): number => centavos / CENTAVOS_POR_PESO;

/** Saca el token de un texto, por si Meta lo repite en un error. */
export function ocultar(texto: string, token: string): string {
  return token ? texto.split(token).join('[token]') : texto;
}

export class ErrorDeMeta extends Error {
  constructor(
    mensaje: string,
    readonly codigo?: number,
  ) {
    super(mensaje);
    this.name = 'ErrorDeMeta';
  }
}

/** Las acciones de insights que cuentan como una consulta (un formulario enviado). */
const ACCIONES_DE_LEAD = new Set(['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped']);

type Pedir = typeof fetch;

/** Las preguntas como las pide la API de formularios. */
function preguntasDeMeta(ps: Pregunta[]) {
  return ps.map((p) =>
    p.tipo === 'CUSTOM'
      ? {
          type: 'CUSTOM',
          key: p.clave,
          label: p.texto,
          // Con opciones es de eleccion multiple: Meta muestra los botones.
          ...(p.opciones ? { options: p.opciones.map((o) => ({ key: o.clave, value: o.texto })) } : {}),
        }
      : { type: p.tipo },
  );
}

export function consultasDe(acciones: unknown): number {
  if (!Array.isArray(acciones)) return 0;
  // Meta repite el mismo lead en varias acciones (`lead` y el agrupado): se
  // toma la mayor, no la suma.
  let n = 0;
  for (const a of acciones as { action_type?: string; value?: string }[]) {
    if (a.action_type && ACCIONES_DE_LEAD.has(a.action_type)) n = Math.max(n, Number(a.value) || 0);
  }
  return n;
}

export function clienteDeMeta(cfg: ConfigDeMeta, pedir: Pedir = fetch): Meta {
  const cuenta = cfg.cuenta.startsWith('act_') ? cfg.cuenta : `act_${cfg.cuenta}`;
  const base = `https://graph.facebook.com/${cfg.version}`;
  // Los formularios y los leads son de la pagina: piden el token de la pagina,
  // que se saca una vez con el del usuario del sistema.
  let tokenDePagina: string | undefined;
  let instagram: string | null | undefined;

  async function llamar(
    metodo: 'GET' | 'POST',
    ruta: string,
    params: Record<string, unknown> = {},
    token = cfg.token,
  ): Promise<Record<string, unknown>> {
    const cuerpo = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      cuerpo.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const url = ruta.startsWith('https://') ? ruta : `${base}/${ruta.replace(/^\//, '')}`;
    const conQuery = metodo === 'GET' && cuerpo.size > 0 ? `${url}${url.includes('?') ? '&' : '?'}${cuerpo}` : url;
    let r: Response;
    try {
      r = await pedir(conQuery, {
        method: metodo,
        headers: {
          authorization: `Bearer ${token}`,
          ...(metodo === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: metodo === 'POST' ? cuerpo.toString() : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ErrorDeMeta(ocultar(ocultar(`no pude hablar con Meta: ${err instanceof Error ? err.message : String(err)}`, cfg.token), token));
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await r.json()) as Record<string, unknown>;
    } catch {
      // Sin JSON: alcanza con el status.
    }
    if (!r.ok || json.error) {
      const e = (json.error ?? {}) as { message?: string; code?: number; error_user_msg?: string };
      const detalle = [e.message, e.error_user_msg].filter(Boolean).join(' · ') || `HTTP ${r.status}`;
      // Con el token de la pagina, ese tambien se tapa.
      throw new ErrorDeMeta(ocultar(ocultar(`Meta: ${detalle}`, cfg.token), token), e.code);
    }
    return json;
  }

  /** Todas las paginas de un listado. `paging.next` ya trae la query (sin el token). */
  async function todo(ruta: string, params: Record<string, unknown>, token = cfg.token): Promise<Record<string, unknown>[]> {
    const filas: Record<string, unknown>[] = [];
    let r = await llamar('GET', ruta, params, token);
    for (let vueltas = 0; vueltas < 50; vueltas++) {
      filas.push(...((r.data as Record<string, unknown>[] | undefined) ?? []));
      const siguiente = (r.paging as { next?: string } | undefined)?.next;
      if (!siguiente) break;
      r = await llamar('GET', siguiente, {}, token);
    }
    return filas;
  }

  async function deLaPagina(): Promise<string> {
    if (tokenDePagina) return tokenDePagina;
    const r = await llamar('GET', cfg.pagina, { fields: 'access_token' });
    // Sin permiso para el token de la pagina, se prueba con el del sistema.
    tokenDePagina = typeof r.access_token === 'string' ? r.access_token : cfg.token;
    return tokenDePagina;
  }

  async function cuentaDeInstagram(): Promise<string | undefined> {
    if (instagram === undefined) {
      try {
        const r = await llamar('GET', cfg.pagina, { fields: 'instagram_business_account' });
        instagram = (r.instagram_business_account as { id?: string } | undefined)?.id ?? null;
      } catch {
        instagram = null;
      }
    }
    return instagram ?? undefined;
  }

  const id = (r: Record<string, unknown>) => {
    if (typeof r.id !== 'string') throw new ErrorDeMeta('Meta no devolvio un id');
    return r.id;
  };

  async function instagramONada(): Promise<string> {
    const ig = await cuentaDeInstagram();
    if (!ig) throw new ErrorDeMeta('la página no tiene una cuenta de Instagram conectada');
    return ig;
  }

  /**
   * Los bytes de un video a rupload.facebook.com (la subida resumable de IG y
   * de los reels de la pagina). Ahi el token va como `OAuth`, no `Bearer`.
   */
  async function subirBytes(url: string, video: Buffer, token: string): Promise<void> {
    let r: Response;
    try {
      r = await pedir(url, {
        method: 'POST',
        headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(video.length) },
        body: new Uint8Array(video),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      throw new ErrorDeMeta(ocultar(ocultar(`no pude subir el video: ${err instanceof Error ? err.message : String(err)}`, cfg.token), token));
    }
    if (r.ok) return;
    const texto = await r.text().catch(() => '');
    throw new ErrorDeMeta(ocultar(ocultar(`Meta rechazó la subida del video (HTTP ${r.status}): ${texto.slice(0, 300)}`, cfg.token), token));
  }

  return {
    async cuenta() {
      const r = await llamar('GET', cuenta, { fields: 'name,currency,account_status,amount_spent,spend_cap,min_daily_budget' });
      return {
        nombre: String(r.name ?? ''),
        moneda: String(r.currency ?? ''),
        estado: Number(r.account_status ?? 0),
        // `amount_spent` y `spend_cap` vienen como texto en centavos.
        gastado: dePesos(Number(r.amount_spent ?? 0)),
        limite: dePesos(Number(r.spend_cap ?? 0)),
        // Tambien en centavos.
        minimoDiario: r.min_daily_budget ? dePesos(Number(r.min_daily_budget)) : undefined,
      };
    },

    async crearCampana(nombre) {
      return id(
        await llamar('POST', `${cuenta}/campaigns`, {
          name: nombre,
          objective: 'OUTCOME_LEADS',
          status: 'ACTIVE',
          special_ad_categories: [],
          // El presupuesto va en cada conjunto (uno por anuncio), no en la campaña.
          is_adset_budget_sharing_enabled: false,
        }),
      );
    },

    async subirImagen(png, nombre) {
      const r = await llamar('POST', `${cuenta}/adimages`, { bytes: png.toString('base64'), name: nombre });
      const imagenes = Object.values((r.images ?? {}) as Record<string, { hash?: string }>);
      const hash = imagenes[0]?.hash;
      if (!hash) throw new ErrorDeMeta('Meta no devolvio el hash de la imagen');
      return hash;
    },

    async crearFormulario(f) {
      return id(
        await llamar(
          'POST',
          `${cfg.pagina}/leadgen_forms`,
          {
            name: f.nombre,
            locale: 'es_LA',
            questions: preguntasDeMeta(f.preguntas),
            privacy_policy: { url: f.privacidad, link_text: 'Política de privacidad' },
            // "Mayor intencion": una pantalla para revisar los datos antes de
            // enviar. Llegan menos consultas, pero de gente que de verdad quiere.
            is_optimized_for_quality: true,
            follow_up_action_url: f.web,
            thank_you_page: {
              title: '¡Gracias!',
              body: f.gracias,
              button_type: 'VIEW_WEBSITE',
              button_text: 'Ver Sincro',
              website_url: f.web,
            },
          },
          await deLaPagina(),
        ),
      );
    },

    async buscarIntereses(texto) {
      const r = await llamar('GET', 'search', { type: 'adinterest', q: texto, limit: 5, locale: 'es_LA' });
      return ((r.data as { id?: string; name?: string }[] | undefined) ?? [])
        .filter((x) => x.id && x.name)
        .map((x) => ({ id: String(x.id), name: String(x.name) }));
    },

    async crearConjunto(c) {
      return id(
        await llamar('POST', `${cuenta}/adsets`, {
          name: c.nombre,
          campaign_id: c.campana,
          daily_budget: aCentavos(c.diario),
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LEAD_GENERATION',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          destination_type: 'ON_AD',
          promoted_object: { page_id: cfg.pagina },
          targeting: {
            geo_locations: { countries: ['AR'] },
            age_min: 25,
            age_max: 65,
            ...(c.intereses.length ? { flexible_spec: [{ interests: c.intereses }] } : {}),
            // Publico Advantage+: los intereses quedan como sugerencia y Meta
            // busca a quien convierte. Con presupuestos chicos rinde mas que un
            // publico fijo (2026-10-13). Pais y edad minima siguen siendo limites.
            targeting_automation: { advantage_audience: 1 },
          },
          status: 'ACTIVE',
        }),
      );
    },

    async crearCreativo(c) {
      const ig = await cuentaDeInstagram();
      return id(
        await llamar('POST', `${cuenta}/adcreatives`, {
          name: c.nombre,
          object_story_spec: {
            page_id: cfg.pagina,
            ...(ig ? { instagram_user_id: ig } : {}),
            link_data: {
              image_hash: c.imagenHash,
              link: c.web,
              message: c.texto,
              name: c.titulo,
              call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: c.formulario } },
            },
          },
        }),
      );
    },

    async crearAnuncio(a) {
      return id(
        await llamar('POST', `${cuenta}/ads`, {
          name: a.nombre,
          adset_id: a.conjunto,
          creative: { creative_id: a.creativo },
          status: 'ACTIVE',
        }),
      );
    },

    async cambiarEstado(objeto, estado) {
      await llamar('POST', objeto, { status: estado });
    },

    async cambiarCreativo(anuncio, creativo) {
      await llamar('POST', anuncio, { creative: { creative_id: creativo } });
    },

    async cambiarDiario(conjunto, diario) {
      await llamar('POST', conjunto, { daily_budget: aCentavos(diario) });
    },

    async insights(desde, hasta) {
      const filas = await todo(`${cuenta}/insights`, {
        level: 'ad',
        fields: 'ad_id,adset_id,campaign_id,spend,impressions,actions',
        time_range: { since: desde, until: hasta },
        time_increment: 1,
        limit: 500,
      });
      return filas.map((f) => ({
        anuncio: String(f.ad_id ?? ''),
        ...(f.adset_id ? { conjunto: String(f.adset_id) } : {}),
        ...(f.campaign_id ? { campana: String(f.campaign_id) } : {}),
        dia: String(f.date_start ?? ''),
        // El gasto de insights viene en pesos ("1234.56"), no en centavos.
        gasto: Number(f.spend ?? 0),
        impresiones: Number(f.impressions ?? 0),
        consultas: consultasDe(f.actions),
      }));
    },

    async conjuntos(campana) {
      const filas = await todo(`${campana}/adsets`, {
        fields: 'id,daily_budget,effective_status',
        // Por defecto Meta no devuelve los borrados: se piden para enterarse.
        filtering: [
          {
            field: 'effective_status',
            operator: 'IN',
            value: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'],
          },
        ],
        limit: 100,
      });
      return filas.map((f) => ({
        id: String(f.id ?? ''),
        ...(f.daily_budget !== undefined ? { diario: Number(f.daily_budget) / CENTAVOS_POR_PESO } : {}),
        estado: String(f.effective_status ?? ''),
      }));
    },

    async subirReelInstagram(video, o) {
      const ig = await instagramONada();
      const contenedor = id(
        await llamar('POST', `${ig}/media`, {
          media_type: 'REELS',
          upload_type: 'resumable',
          caption: o.caption,
          share_to_feed: 'true',
          trial_params: o.prueba ? { graduation_strategy: 'SS_PERFORMANCE' } : undefined,
        }),
      );
      await subirBytes(`https://rupload.facebook.com/ig-api-upload/${cfg.version}/${contenedor}`, video, cfg.token);
      return contenedor;
    },

    async estadoDelContenedor(contenedor) {
      const r = await llamar('GET', contenedor, { fields: 'status_code,status' });
      return { estado: String(r.status_code ?? ''), ...(r.status ? { detalle: String(r.status) } : {}) };
    },

    async publicarEnInstagram(contenedor) {
      return id(await llamar('POST', `${await instagramONada()}/media_publish`, { creation_id: contenedor }));
    },

    async subirReelFacebook(video, descripcion) {
      const token = await deLaPagina();
      const inicio = await llamar('POST', `${cfg.pagina}/video_reels`, { upload_phase: 'start' }, token);
      const videoId = typeof inicio.video_id === 'string' ? inicio.video_id : undefined;
      if (!videoId) throw new ErrorDeMeta('Meta no devolvio el id del video');
      await subirBytes(`https://rupload.facebook.com/video-upload/${cfg.version}/${videoId}`, video, token);
      await llamar(
        'POST',
        `${cfg.pagina}/video_reels`,
        { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: descripcion },
        token,
      );
      return videoId;
    },

    async metricasDeReel(media) {
      const r = await llamar('GET', `${media}/insights`, { metric: Object.keys(METRICAS_DE_REEL).join(',') });
      const m: MetricasDeReel = { alcance: 0, vistas: 0, guardados: 0, compartidos: 0, likes: 0, comentarios: 0, promedioMs: 0 };
      for (const fila of (r.data as { name?: string; values?: { value?: unknown }[] }[] | undefined) ?? []) {
        const clave = fila.name ? METRICAS_DE_REEL[fila.name] : undefined;
        if (clave) m[clave] = Number(fila.values?.[0]?.value ?? 0) || 0;
      }
      return m;
    },

    async promocionable(media) {
      const r = await llamar('GET', media, { fields: 'boost_eligibility_info' });
      const info = (r.boost_eligibility_info ?? {}) as { eligible_to_boost?: boolean; boost_ineligible_reason?: string };
      return info.eligible_to_boost ? { ok: true } : { ok: false, motivo: info.boost_ineligible_reason ?? 'Meta no lo deja promocionar' };
    },

    async crearCreativoDeReel(c) {
      return id(
        await llamar('POST', `${cuenta}/adcreatives`, {
          name: c.nombre,
          object_id: cfg.pagina,
          instagram_user_id: await instagramONada(),
          source_instagram_media_id: c.media,
          // Meta pide `link` aunque el boton abra el formulario: sin el, "The
          // link field is required" (anuncio #5, 2026-10-14).
          call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: c.formulario, link: c.web } },
        }),
      );
    },

    conConversiones: () => Boolean(cfg.dataset),

    async enviarEtapas(etapas) {
      if (!cfg.dataset || etapas.length === 0) return 0;
      // Conversiones de leads (integracion con CRM): el lead se identifica con
      // su leadgen_id y la etapa va como nombre del evento.
      const r = await llamar('POST', `${cfg.dataset}/events`, {
        data: etapas.map((e) => ({
          event_name: e.etapa,
          event_time: Math.floor(e.cuando.getTime() / 1000),
          action_source: 'system_generated',
          user_data: datosDeLaPersona(e),
          custom_data: { event_source: 'crm', lead_event_source: 'Homero' },
        })),
      });
      return Number(r.events_received ?? 0);
    },

    async leads(formulario, desde) {
      const filas = await todo(
        `${formulario}/leads`,
        {
          fields: 'id,created_time,ad_id,form_id,field_data',
          filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(desde.getTime() / 1000) }],
          limit: 100,
        },
        await deLaPagina(),
      );
      return filas.map((f) => {
        const campos: Record<string, string> = {};
        for (const c of (f.field_data as { name?: string; values?: string[] }[] | undefined) ?? []) {
          if (c.name) campos[c.name] = (c.values ?? []).join(', ');
        }
        return {
          id: String(f.id),
          creado: new Date(String(f.created_time ?? '')),
          anuncio: typeof f.ad_id === 'string' ? f.ad_id : undefined,
          formulario: typeof f.form_id === 'string' ? f.form_id : formulario,
          campos,
        };
      });
    },
  };
}
