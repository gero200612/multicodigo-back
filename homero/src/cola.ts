import { z } from 'zod';
import { redactarPliego, type DepsDeDemos } from './demos.js';
import { enviarMail } from './envio.js';
import { horaArgentina } from './horas.js';
import { finanzasDelDia } from './finanzas.js';
import { presupuestar } from './precios.js';
import { cuandoReintentar, ErrorDeCuenta, ErrorDeLimite } from './ia.js';
import { agenteAtender, agenteBuscar, agentePublicitar, agenteReel, agenteRevisar, agenteVender, agenteWhatsApp, type DepsDeAgentes } from './agentes.js';
import { agenteReelDeEstudio, pasoDelExperimento, renderizarReel } from './experimento.js';
import { leerReels, publicarReel } from './publicar-reel.js';
import { pedirMeet } from './meet.js';
import { escribirALeadMeta, leerInsights, publicarAnuncio, renovarFormulario, resumenDeAnuncios, seguimientoDeLeadMeta } from './anuncios.js';
import { SinLugar } from './gateway.js';
import type { Recibido, Tarea, TipoDeTarea } from './store.js';
import { enviarSaliente, recordatorio, resumenDiario } from './ventas.js';
import { entrarFormularioWeb } from './primer-whatsapp.js';

export { direccion } from './ventas.js';

/** Clave en homero.estado de la pausa de la IA. */
export const PAUSA_IA = 'ia_pausada';
/** Clave en homero.estado de la pausa manual (/pausa). */
export const PAUSA_MANUAL = 'pausa_manual';

interface PausaDeIa {
  /** Hasta cuando no se toma nada de IA: el proximo intento, no el reset. */
  hasta: string;
  motivo: 'limite' | 'cuenta';
  /** Cuando vuelve una cuenta segun el gateway (lo que se le dijo a Gero). */
  vuelve?: string;
  /** Ya se le aviso a Gero: no se repite hasta que la IA vuelva a andar. */
  avisada?: boolean;
}

/**
 * Sin uso en las cuentas que pudo tomar NO es sin uso en todas: las que usaba
 * Punchi se liberan antes del reset. Se vuelve a probar cada tanto; el gateway
 * ya sabe cuales estan agotadas, asi que probar no gasta nada (2026-10-13: una
 * cuenta agotada frenaba toda la IA 24 h con otras libres).
 */
export const REPROBAR_IA_MS = 15 * 60_000;

export type DepsDeCola = DepsDeDemos & DepsDeAgentes;

/** Sin cuenta libre (Punchi las esta usando): se reintenta en un rato, sin gastar intento. */
const ESPERA_SIN_LUGAR_MS = 10 * 60_000;
/** WhatsApp tiene a alguien esperando: se reintenta enseguida. */
export const ESPERA_SIN_LUGAR_WA_MS = 30_000;

/** Lo que corre el bucle rapido: no espera atras de las corridas largas. */
// `formulario_web` no usa IA, pero hay alguien que acaba de pedir que le escribamos.
// `agente_reel`: Gero mando un video y espera la tarjeta; no hace fila atras de una busqueda.
export const TIPOS_URGENTES: TipoDeTarea[] = ['agente_whatsapp', 'formulario_web', 'agente_reel'];

/** Despues de tantos fallos que no son de la IA, la tarea se da por perdida. */
const TOPE_DE_INTENTOS = 5;

const PayloadDeEnvio = z.object({
  casilla: z.string(),
  para: z.string().email(),
  asunto: z.string().min(1),
  texto: z.string().min(1),
  enRespuestaA: z.string().optional(),
  prueba: z.boolean().optional(),
});

/**
 * `true` si la IA se puede usar ahora. Si la pausa ya vencio la levanta y
 * avisa que se retoma.
 *
 * La pausa vive en la base: si la Toshiba se reinicia a mitad de una espera,
 * al volver sigue esperando lo que faltaba en vez de empezar de cero.
 */
export async function iaDisponible(deps: DepsDeCola): Promise<boolean> {
  const pausa = await deps.store.leerEstado<PausaDeIa>(PAUSA_IA);
  // Vencida la espera se vuelve a probar; la pausa se levanta recien cuando
  // una tarea de IA anda (`iaVolvio`), asi un nuevo "sin uso" no repite el aviso.
  return !pausa || new Date(pausa.hasta).getTime() <= deps.ahora().getTime();
}

/** Una tarea de IA anduvo: si estaba en pausa, se levanta y se avisa (si se habia avisado). */
async function iaVolvio(deps: DepsDeCola): Promise<void> {
  const pausa = await deps.store.leerEstado<PausaDeIa>(PAUSA_IA);
  if (!pausa) return;
  await deps.store.guardarEstado(PAUSA_IA, null);
  if (pausa.avisada) await deps.avisar('▶️ Vuelvo a usar Claude. Sigo donde quedé.');
}

/**
 * Corre UNA tarea, si hay alguna lista. Devuelve si corrio algo, para que el
 * bucle sepa si seguir de largo o dormir. Con `tipos`, solo de esos (el bucle
 * rapido de WhatsApp).
 */
export async function correrSiguiente(deps: DepsDeCola, tipos?: TipoDeTarea[]): Promise<boolean> {
  if (await deps.store.leerEstado(PAUSA_MANUAL)) return false;
  const tarea = await deps.store.tomarSiguiente(deps.ahora(), await iaDisponible(deps), tipos);
  if (!tarea) return false;

  try {
    const r = await ejecutar(tarea, deps);
    if (r) {
      await deps.store.reprogramar(tarea.id, r.reprogramarPara, { contarIntento: false });
    } else {
      await deps.store.terminar(tarea.id);
    }
    if (tarea.requiereIa) await iaVolvio(deps);
  } catch (err) {
    await manejarError(tarea, err, deps);
  }
  return true;
}

async function manejarError(tarea: Tarea, err: unknown, deps: DepsDeCola) {
  if (err instanceof SinLugar) {
    const espera = TIPOS_URGENTES.includes(tarea.tipo) ? ESPERA_SIN_LUGAR_WA_MS : ESPERA_SIN_LUGAR_MS;
    await deps.store.reprogramar(tarea.id, new Date(deps.ahora().getTime() + espera), {
      contarIntento: false,
      error: 'sin cuenta libre',
    });
    return;
  }
  if (err instanceof ErrorDeLimite || err instanceof ErrorDeCuenta) {
    // Nunca se corta: la tarea vuelve a la cola para cuando vuelva la cuenta,
    // sin gastar un intento. El limite no es culpa de la tarea.
    const ahora = deps.ahora();
    const vuelve = cuandoReintentar(err, ahora);
    const hasta = new Date(Math.min(vuelve.getTime(), ahora.getTime() + REPROBAR_IA_MS));
    const motivo = err instanceof ErrorDeLimite ? 'limite' : 'cuenta';
    await deps.store.reprogramar(tarea.id, hasta, { contarIntento: false, error: err.message });
    // Un solo aviso por pausa: si ya se aviso, los reintentos no lo repiten.
    const yaAvisada = (await deps.store.leerEstado<PausaDeIa>(PAUSA_IA))?.avisada === true;
    await deps.store.guardarEstado(PAUSA_IA, { hasta: hasta.toISOString(), motivo, vuelve: vuelve.toISOString(), avisada: true });
    if (!yaAvisada) {
      const reprueba = vuelve.getTime() > hasta.getTime() ? ', pero pruebo cada 15 minutos por si se libera otra cuenta' : '';
      await deps.avisar(
        motivo === 'limite'
          ? `⏸ Me quedé sin uso de Claude. La cuenta vuelve ${horaArgentina(vuelve)}${reprueba}. Mientras tanto sigo mandando lo que ya estaba escrito.`
          : `⚠️ La cuenta de Claude de Homero se desconectó. Cargala de nuevo desde el panel. Reintento solo a las ${horaArgentina(hasta)}.`,
      );
    }
    return;
  }

  const mensaje = err instanceof Error ? err.message : String(err);
  if (tarea.intentos + 1 >= TOPE_DE_INTENTOS) {
    await deps.store.fallar(tarea.id, mensaje);
    await deps.avisar(
      `❌ No pude hacer una tarea (${tarea.tipo}) después de ${TOPE_DE_INTENTOS} intentos: ${mensaje.slice(0, 300)}`,
    );
    return;
  }
  // Espera creciente: 1, 2, 4, 8 minutos.
  const espera = 60_000 * 2 ** tarea.intentos;
  await deps.store.reprogramar(tarea.id, new Date(deps.ahora().getTime() + espera), {
    contarIntento: true,
    error: mensaje,
  });
}

async function ejecutar(tarea: Tarea, deps: DepsDeCola): Promise<{ reprogramarPara: Date } | void> {
  switch (tarea.tipo) {
    case 'enviar_mail': {
      // Solo /probar_mail: los mails a leads van por `enviar_saliente`.
      const p = PayloadDeEnvio.parse(tarea.payload);
      const casilla = deps.casillas.find((c) => c.email === p.casilla);
      if (!casilla) throw new Error(`la casilla ${p.casilla} no esta configurada`);
      const r = await enviarMail(deps, casilla, p, { prueba: p.prueba });
      if (r.tipo === 'esperar') return { reprogramarPara: r.hasta };
      if (r.tipo === 'baja') await deps.avisar(`🚫 No le mandé a ${p.para}: pidió la baja.`);
      if (r.tipo === 'enviado' && p.prueba) {
        await deps.avisar(`✉️ Mail de prueba enviado a ${p.para} desde ${casilla.email}.`);
      }
      return;
    }
    // `resumir_respuesta`, `prospectar` e `investigar` son los tipos del guion
    // viejo: los que quedaron encolados los atienden los agentes.
    case 'agente_atender':
    case 'resumir_respuesta':
      return agenteAtender(tarea.payload as Recibido, deps);
    case 'agente_whatsapp':
      return agenteWhatsApp(tarea.payload, deps);
    case 'agente_buscar':
      return agenteBuscar(tarea.payload, deps);
    case 'prospectar':
      return agenteBuscar({ cantidad: (tarea.payload as { cantidad?: number }).cantidad ?? 5 }, deps);
    case 'agente_vender':
    case 'investigar':
      return agenteVender(tarea.payload, deps);
    case 'enviar_saliente':
      return enviarSaliente(tarea.payload, deps);
    case 'recordatorio':
      return recordatorio(tarea.payload, deps);
    case 'resumen_diario':
      return resumenDiario(deps);
    case 'pliego_demo':
      return redactarPliego(tarea.payload, deps);
    case 'presupuestar':
      return presupuestar(tarea.payload, deps);
    case 'agente_publicitar':
      return agentePublicitar(tarea.payload, deps);
    case 'agente_revisar':
      return agenteRevisar(tarea.payload, deps);
    case 'publicar_anuncio':
      return publicarAnuncio(tarea.payload, deps);
    case 'leer_insights':
      return leerInsights(deps);
    case 'escribir_a_lead_meta':
      return escribirALeadMeta(tarea.payload, deps);
    case 'formulario_web':
      return entrarFormularioWeb(tarea.payload, deps);
    case 'seguimiento_lead_meta':
      return seguimientoDeLeadMeta(tarea.payload, deps);
    case 'renovar_formulario':
      return renovarFormulario(tarea.payload, deps);
    case 'resumen_anuncios':
      return resumenDeAnuncios(deps);
    case 'finanzas_del_dia':
      await finanzasDelDia(deps);
      return;
    case 'agente_reel':
      return agenteReel(tarea.payload, deps);
    case 'publicar_reel':
      return publicarReel(tarea.payload, deps);
    case 'leer_reels':
      return leerReels(deps);
    case 'agente_reel_estudio':
      return agenteReelDeEstudio(tarea.payload, deps);
    case 'renderizar_reel':
      return renderizarReel(tarea.payload, deps);
    case 'experimento_paso':
      return pasoDelExperimento(deps);
    case 'pedir_meet':
      return pedirMeet(tarea.payload, deps);
  }
}
