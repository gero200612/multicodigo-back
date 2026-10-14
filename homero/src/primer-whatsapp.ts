import { z } from 'zod';
import type { Store } from './store.js';
import { botonesDeCalidad, encolarSeguimiento } from './anuncios.js';
import type { Boton } from './ventas.js';
import { ErrorDeWhatsApp, type ClienteWa } from './whatsapp.js';

/**
 * El primer WhatsApp a quien pidio que lo contacten: el formulario de la web
 * o el de un anuncio, si tildo que le escribamos por WhatsApp.
 *
 * Fuera de la ventana de 24 h Meta solo deja mandar una plantilla aprobada.
 * Esta es de UTILIDAD (responde a un pedido de contacto, sin promocion), y la
 * da de alta Homero mismo por el bot la primera vez que hace falta. Cuando la
 * persona contesta se abre la ventana y sigue el agente de WhatsApp de siempre.
 */

export interface PlantillaDeTexto {
  nombre: string;
  idioma: string;
  categoria: string;
  texto: string;
  ejemplo: string[];
  /** Botones de respuesta rapida: lo que tocan vuelve como su mensaje. */
  botones?: string[];
}

/**
 * Con la misma cara que lo que manda el agente (pedido de Gero, 2026-10-14):
 * emojis, "reunión" y sin mandarse de cabeza a agendar; los dos botones
 * llevan al agente por un camino o el otro. Meta no deja editar el texto de
 * una aprobada sin pasar otra revision, por eso es una plantilla nueva.
 */
export const PLANTILLA_CONSULTA: PlantillaDeTexto = {
  nombre: 'consulta_web',
  idioma: 'es_AR',
  categoria: 'UTILITY',
  texto:
    'Hola {{1}}! 👋 Somos Sincro.\n\n✅ Recibimos tu consulta sobre {{2}}.\n\n¿Tenés alguna duda que te podamos responder por acá, o preferís que agendemos una reunión de 30 minutos por videollamada?',
  ejemplo: ['Laura', 'stock que avisa'],
  botones: ['Tengo una duda', 'Agendar reunión'],
};

/** La de antes: sale solo mientras Meta no aprobó la nueva, para no dejar a nadie sin respuesta. */
export const PLANTILLA_CONSULTA_VIEJA = { nombre: 'consulta_recibida', idioma: 'es_AR' };

/** Lo que dice la plantilla si no se sabe el tema. */
const TEMA_GENERAL = 'lo que necesitás para tu negocio';

export type ResultadoDelPrimero =
  | { ok: true }
  | { ok: false; motivo: string; reintentar?: boolean };

/** `María José Pérez` -> `María`. Sin nombre queda `Hola qué tal, soy de Sincro...`. */
export function primerNombre(nombre: string | undefined): string {
  const n = (nombre ?? '').replace(/[^\p{L}\s'-]/gu, ' ').trim().split(/\s+/)[0] ?? '';
  return n ? n.charAt(0).toUpperCase() + n.slice(1, 40) : 'qué tal';
}

/** `Stock que avisa` -> `stock que avisa`; `Otra cosa` o nada -> el general. */
export function temaDeLaConsulta(tema: string | undefined): string {
  const t = (tema ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t || /^otra cosa$/i.test(t)) return TEMA_GENERAL;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

const PlantillaWa = z.object({ nombre: z.string(), idioma: z.string(), estado: z.string(), bloqueada: z.boolean().optional() });

/**
 * La deja creada en Meta si todavia no existe. Devuelve su estado:
 * APPROVED, PENDING, REJECTED... o `sin_permiso` si el negocio Sincro no
 * tiene la capacidad `avisos` (la da Gero, ver docs/vps/sincro-wa-desplegar.py).
 */
export async function asegurarPlantilla(
  wa: ClienteWa,
  plantilla: PlantillaDeTexto = PLANTILLA_CONSULTA,
): Promise<string> {
  let lista: z.infer<typeof PlantillaWa>[];
  try {
    lista = z.array(PlantillaWa).parse(await wa.plantillas());
  } catch (e) {
    if (e instanceof ErrorDeWhatsApp && e.status === 404) return 'sin_permiso';
    throw e;
  }
  const ya = lista.find((p) => p.nombre === plantilla.nombre && p.idioma === plantilla.idioma);
  if (ya) return ya.bloqueada ? 'BLOQUEADA' : ya.estado;
  const creada = await wa.crearPlantilla({
    nombre: plantilla.nombre,
    idioma: plantilla.idioma,
    categoria: plantilla.categoria,
    componentes: [
      { type: 'BODY', text: plantilla.texto, example: { body_text: [plantilla.ejemplo] } },
      ...(plantilla.botones?.length
        ? [{ type: 'BUTTONS', buttons: plantilla.botones.map((text) => ({ type: 'QUICK_REPLY', text })) }]
        : []),
    ],
  });
  return creada.bloqueada ? 'BLOQUEADA' : creada.estado;
}

/** Clave en homero.estado: el ultimo estado de la plantilla que se le conto a Gero. */
export const ESTADO_DE_LA_PLANTILLA = 'wa:plantilla_consulta_web';
/** Cada cuanto se mira: es un GET al bot, y Meta tarda de minutos a horas en revisarla. */
export const VIGILAR_PLANTILLA_MS = 30 * 60_000;

const NOVEDADES: Record<string, string> = {
  PENDING: '📨 Registré en Meta la plantilla nueva del primer WhatsApp (consulta_web). Está en revisión: te aviso cuando la aprueben.',
  APPROVED: '✅ Meta aprobó la plantilla nueva del primer WhatsApp (consulta_web): desde ahora sale esa, con los botones "Tengo una duda" y "Agendar reunión".',
  REJECTED: '❌ Meta rechazó la plantilla nueva del primer WhatsApp (consulta_web). Mientras tanto sigue saliendo la vieja (consulta_recibida).',
  BLOQUEADA: '⚠️ Meta pasó la plantilla del primer WhatsApp a Marketing y el bot la bloqueó (Sincro solo tiene avisos). Decidí si le damos promociones.',
  PAUSED: '⏸ Meta pausó la plantilla del primer WhatsApp por mala calidad.',
  DISABLED: '⛔ Meta desactivó la plantilla del primer WhatsApp.',
};

/**
 * La deja registrada apenas el negocio Sincro tiene `avisos` (sin esperar al
 * primer lead) y le cuenta a Gero cada cambio de estado, una sola vez.
 */
export async function vigilarPlantilla(deps: { wa: ClienteWa; store: Store; avisar: (t: string) => Promise<void> }): Promise<string> {
  const estado = await asegurarPlantilla(deps.wa);
  const antes = await deps.store.leerEstado<string>(ESTADO_DE_LA_PLANTILLA);
  if (estado !== antes) {
    await deps.store.guardarEstado(ESTADO_DE_LA_PLANTILLA, estado);
    const novedad = NOVEDADES[estado];
    if (novedad) await deps.avisar(novedad);
  }
  return estado;
}

const MOTIVOS: Record<string, string> = {
  plantilla_no_aprobada: 'la plantilla todavía no está aprobada por Meta',
  baja: 'ese número pidió la baja',
  tope_meta: 'Meta no deja mandar más plantillas hoy desde el número de Sincro',
  tope_alcanzado: 'se llegó al tope de gasto del mes del bot',
  no_existe: 'el negocio Sincro no tiene permiso para mandar plantillas (capacidad avisos)',
};

/** Le manda la plantilla. Nunca tira: devuelve que paso, para avisarle a Gero. */
export async function escribirPrimerWhatsapp(
  wa: ClienteWa,
  p: { a: string; nombre?: string; tema?: string },
): Promise<ResultadoDelPrimero> {
  const variables = [primerNombre(p.nombre), temaDeLaConsulta(p.tema)];
  try {
    await wa.avisar(p.a, PLANTILLA_CONSULTA.nombre, PLANTILLA_CONSULTA.idioma, variables);
    return { ok: true };
  } catch (e) {
    if (e instanceof ErrorDeWhatsApp) {
      if (e.codigo === 'plantilla_no_aprobada') {
        // La nueva todavia en revision: que se cree si falta, y sale la vieja.
        await asegurarPlantilla(wa).catch(() => undefined);
        try {
          await wa.avisar(p.a, PLANTILLA_CONSULTA_VIEJA.nombre, PLANTILLA_CONSULTA_VIEJA.idioma, variables);
          return { ok: true };
        } catch {
          // Tampoco la vieja: sigue abajo con el motivo de la nueva.
        }
      }
      if (e.codigo === 'plantilla_no_aprobada' || e.codigo === 'no_existe') {
        // Si nunca se creo, se crea ahora; Meta la revisa en minutos u horas.
        const estado = await asegurarPlantilla(wa).catch(() => 'desconocido');
        return { ok: false, motivo: `${MOTIVOS[e.codigo]} (estado: ${estado})` };
      }
      return { ok: false, motivo: MOTIVOS[e.codigo] ?? `el bot devolvió ${e.status} ${e.codigo}`, reintentar: e.status >= 500 };
    }
    return { ok: false, motivo: e instanceof Error ? e.message : String(e), reintentar: true };
  }
}

// ------------------------------------------------------------ el formulario de la web

export const FormularioWeb = z.object({
  nombre: z.string().min(1).max(80),
  negocio: z.string().max(120).nullish(),
  whatsapp: z.string().regex(/^\d{8,15}$/).nullish(),
  mail: z.string().max(120).nullish(),
  tema: z.string().max(80).nullish(),
  mensaje: z.string().max(2000).nullish(),
  acepta_whatsapp: z.boolean().default(false),
  /** El id del evento en el bot: frena que el mismo envio entre dos veces. */
  evento: z.number().int(),
});

export interface DepsDelFormulario {
  store: Store;
  wa?: ClienteWa;
  ahora: () => Date;
  /** El aviso a Gero, con los botones de "¿sirve?". */
  proponer: (texto: string, botones: Boton[]) => Promise<number | undefined>;
}

/**
 * Un envio del formulario de sincro.apps.punchi.dev: queda como lead caliente
 * (fuente web), le avisa a Gero por Telegram y, si tildo WhatsApp, le escribe.
 */
export async function entrarFormularioWeb(payload: unknown, deps: DepsDelFormulario): Promise<void> {
  const f = FormularioWeb.parse(payload);
  const corta = (t: string | null | undefined, max: number) => t?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
  const formulario = [
    f.tema ? { pregunta: '¿Qué te gustaría resolver?', respuesta: corta(f.tema, 80)! } : undefined,
    f.mensaje ? { pregunta: 'Contanos un poco más', respuesta: f.mensaje.trim().slice(0, 600) } : undefined,
  ].filter((x): x is { pregunta: string; respuesta: string } => Boolean(x));

  const r = await deps.store.guardarLeadDeMeta({
    nombre: corta(f.negocio, 120) ?? corta(f.nombre, 80)!,
    rubro: corta(f.tema, 80) ?? 'consulta web',
    ciudad: 'Argentina',
    email: f.mail ?? undefined,
    telefono: f.whatsapp ?? undefined,
    fuente: 'web',
    leadgenId: `web:${f.evento}`,
    investigacion: { resumen_empresa: '', dolor: '', idea: '', formulario, contacto: corta(f.nombre, 80) },
  });
  // Ya entro (el bot reentrego el evento): no se avisa ni se escribe de nuevo.
  if (!r) return;

  let whatsapp = f.whatsapp ? 'No tildó que le escribamos por WhatsApp: escribile vos o por mail.' : 'No dejó WhatsApp.';
  if (f.acepta_whatsapp && f.whatsapp) {
    if (!deps.wa) whatsapp = 'Tildó WhatsApp, pero Homero no tiene el bot configurado (SINCRO_WA_URL).';
    else {
      const enviado = await escribirPrimerWhatsapp(deps.wa, { a: f.whatsapp, nombre: f.nombre, tema: f.tema ?? undefined });
      whatsapp = enviado.ok
        ? '✅ Le escribí por WhatsApp con la plantilla; si contesta, sigue el agente.'
        : `⚠️ Tildó WhatsApp pero no le pude escribir: ${enviado.motivo}. Escribile vos: https://wa.me/${f.whatsapp}`;
    }
  }
  await deps.proponer(
    [
      `🌐 Consulta nueva desde la web${r.nuevo ? '' : ' · ya estaba en la base, la marco caliente'}`,
      [corta(f.nombre, 80), corta(f.negocio, 120)].filter(Boolean).join(' · '),
      [f.mail ? `✉️ ${f.mail}` : undefined, f.whatsapp ? `📞 +${f.whatsapp}` : undefined].filter(Boolean).join(' · '),
      ...formulario.map((x) => `${x.pregunta}: ${x.respuesta}`),
      whatsapp,
      '¿Sirve esta consulta?',
    ]
      .filter(Boolean)
      .join('\n'),
    botonesDeCalidad(r.id),
  );
  // El segundo contacto por mail a las 48 h, si no contesta (ver anuncios.ts).
  if (f.mail) await encolarSeguimiento(r.id, `web:${f.evento}`, deps);
}
