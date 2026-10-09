import { z } from 'zod';
import { redactarPliego, type DepsDeDemos } from './demos.js';
import { enviarMail } from './envio.js';
import { horaArgentina } from './horas.js';
import { finanzasDelDia } from './finanzas.js';
import { presupuestar } from './precios.js';
import { cuandoReintentar, ErrorDeCuenta, ErrorDeLimite } from './ia.js';
import { agenteAtender, agenteBuscar, agentePublicitar, agenteRevisar, agenteVender, type DepsDeAgentes } from './agentes.js';
import { escribirALeadMeta, leerInsights, publicarAnuncio, resumenDeAnuncios } from './anuncios.js';
import { SinLugar } from './gateway.js';
import type { Recibido, Tarea } from './store.js';
import { enviarSaliente, recordatorio, resumenDiario } from './ventas.js';

export { direccion } from './ventas.js';

/** Clave en homero.estado de la pausa de la IA. */
export const PAUSA_IA = 'ia_pausada';
/** Clave en homero.estado de la pausa manual (/pausa). */
export const PAUSA_MANUAL = 'pausa_manual';

interface PausaDeIa {
  hasta: string;
  motivo: 'limite' | 'cuenta';
}

export type DepsDeCola = DepsDeDemos & DepsDeAgentes;

/** Sin cuenta libre (Punchi las esta usando): se reintenta en un rato, sin gastar intento. */
const ESPERA_SIN_LUGAR_MS = 10 * 60_000;

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
  if (!pausa) return true;
  if (new Date(pausa.hasta).getTime() > deps.ahora().getTime()) return false;
  await deps.store.guardarEstado(PAUSA_IA, null);
  await deps.avisar('▶️ Vuelvo a usar Claude. Sigo donde quedé.');
  return true;
}

/**
 * Corre UNA tarea, si hay alguna lista. Devuelve si corrio algo, para que el
 * bucle sepa si seguir de largo o dormir.
 */
export async function correrSiguiente(deps: DepsDeCola): Promise<boolean> {
  if (await deps.store.leerEstado(PAUSA_MANUAL)) return false;
  const tarea = await deps.store.tomarSiguiente(deps.ahora(), await iaDisponible(deps));
  if (!tarea) return false;

  try {
    const r = await ejecutar(tarea, deps);
    if (r) {
      await deps.store.reprogramar(tarea.id, r.reprogramarPara, { contarIntento: false });
    } else {
      await deps.store.terminar(tarea.id);
    }
  } catch (err) {
    await manejarError(tarea, err, deps);
  }
  return true;
}

async function manejarError(tarea: Tarea, err: unknown, deps: DepsDeCola) {
  if (err instanceof SinLugar) {
    await deps.store.reprogramar(tarea.id, new Date(deps.ahora().getTime() + ESPERA_SIN_LUGAR_MS), {
      contarIntento: false,
      error: 'sin cuenta libre',
    });
    return;
  }
  if (err instanceof ErrorDeLimite || err instanceof ErrorDeCuenta) {
    // Nunca se corta: la tarea vuelve a la cola para cuando vuelva la cuenta,
    // sin gastar un intento. El limite no es culpa de la tarea.
    const hasta = cuandoReintentar(err, deps.ahora());
    const motivo = err instanceof ErrorDeLimite ? 'limite' : 'cuenta';
    await deps.store.reprogramar(tarea.id, hasta, { contarIntento: false, error: err.message });
    // Un solo aviso por pausa: si ya estaba pausada, no se repite.
    const yaPausada = await deps.store.leerEstado<PausaDeIa>(PAUSA_IA);
    await deps.store.guardarEstado(PAUSA_IA, { hasta: hasta.toISOString(), motivo });
    if (!yaPausada) {
      await deps.avisar(
        motivo === 'limite'
          ? `⏸ Me quedé sin uso de Claude. Vuelvo ${horaArgentina(hasta)} y sigo donde quedé. Mientras tanto sigo mandando lo que ya estaba escrito.`
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
    case 'resumen_anuncios':
      return resumenDeAnuncios(deps);
    case 'finanzas_del_dia':
      await finanzasDelDia(deps);
      return;
  }
}
