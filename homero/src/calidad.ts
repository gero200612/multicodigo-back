import { z } from 'zod';
import { motivoSeguro } from './anfitrion.js';
import { ErrorDeCuenta, ErrorDeLimite } from './ia.js';
import { extraerJson, neutralizar, SISTEMA } from './prompts.js';
import type { CalidadDeLead, Lead, Store } from './store.js';

/**
 * Clasificacion automatica de cada consulta nueva de un formulario (Meta y web): sirve / no sirve y un motivo corto.
 * El motivo y la calidad son para el host (que mide anuncios y reels por consultas buenas); los datos de la persona se
 * quedan en Homero. El boton de Gero en Telegram pisa siempre lo automatico (`marcarCalidad`), y la automatica solo se
 * guarda si la consulta sigue sin calificar (`guardarCalidadAuto`).
 */

/** Cuantas consultas se clasifican por vuelta: el planificador pasa cada 5 minutos. */
export const POR_VUELTA = 10;
/** Hasta cuantos dias atras se clasifica lo que quedo sin calificar (sin gateway, sin cuentas libres). */
export const DIAS_PARA_CLASIFICAR = 3;

export const SISTEMA_DE_CALIDAD = `${SISTEMA}

Ahora clasificás una consulta que llegó por un formulario. Criterio:
- "sirve": es un negocio, pyme, comercio, estudio o empresa (taller, local, clínica, estudio contable, distribuidora, etc.) que tiene algo para automatizar o un sistema que necesita (facturas, stock, turnos, cobranzas, atención por WhatsApp, un sistema a medida).
- "no_sirve": un particular sin negocio ("ama de casa", "personal", "mi casa"), un nombre propio puesto como empresa sin rubro ni necesidad concreta, spam, pruebas, o cosas sin relación con lo que hace Sincro.
- Si hay duda razonable de que sea un negocio real, es "sirve".
Contestás SOLO un JSON: {"calidad": "sirve" | "no_sirve", "motivo": "hasta 100 caracteres"}. El motivo describe el negocio o la razón en general ("taller mecánico que quiere ordenar turnos", "particular sin negocio"): NUNCA nombres de personas ni de la empresa, mails, teléfonos ni números.`;

const Respuesta = z.object({ calidad: z.enum(['sirve', 'no_sirve']), motivo: z.string().optional() });

export interface Clasificacion {
  calidad: CalidadDeLead;
  motivo?: string;
}

/** Lo que se le muestra al modelo de una consulta: empresa, rubro y respuestas del formulario. Sin mail ni telefono. */
export function fichaDeLead(l: Lead): string {
  const corto = (t: string, max: number) => neutralizar(t.replace(/\s+/g, ' ').trim().slice(0, max));
  const formulario = (l.investigacion?.formulario ?? []).map((f) => `${corto(f.pregunta, 200)}: ${corto(f.respuesta, 600)}`);
  return [
    '<no_confiable>',
    `Empresa o nombre: ${corto(l.nombre, 120)}`,
    `Rubro: ${corto(l.rubro, 80)}`,
    ...(l.investigacion?.contacto ? [`Persona que llenó: ${corto(l.investigacion.contacto, 80)}`] : []),
    ...formulario,
    '</no_confiable>',
  ].join('\n');
}

export function parsearClasificacion(texto: string): Clasificacion | undefined {
  const r = Respuesta.safeParse(extraerJson(texto));
  if (!r.success) return undefined;
  const motivo = motivoSeguro(r.data.motivo);
  return { calidad: r.data.calidad, ...(motivo ? { motivo } : {}) };
}

export interface DepsDeCalidad {
  store: Pick<Store, 'leadsSinCalidad' | 'guardarCalidadAuto'>;
  /** El mismo camino de modelo que usa Homero para pensar: el gateway (ver `pedirTexto`). Sin gateway tira y no se clasifica. */
  pedirIa: (prompt: string, sistema: string) => Promise<string>;
  ahora: () => Date;
  log?: (t: string) => void;
}

/**
 * Clasifica las consultas que siguen sin calificar. Se dispara desde el planificador (cada 5 minutos) y despues de leer
 * los formularios de Meta. Sin gateway o sin cuentas libres corta la vuelta y deja todo sin calificar: la proxima lo
 * reintenta (nunca frena el flujo de leads). Devuelve cuantas clasifico.
 */
export async function clasificarPendientes(deps: DepsDeCalidad): Promise<number> {
  const log = deps.log ?? console.warn;
  const desde = new Date(deps.ahora().getTime() - DIAS_PARA_CLASIFICAR * 24 * 3_600_000);
  let hechas = 0;
  for (const lead of await deps.store.leadsSinCalidad(POR_VUELTA, desde)) {
    let c: Clasificacion | undefined;
    try {
      c = parsearClasificacion(await deps.pedirIa(`Clasificá esta consulta.\n\n${fichaDeLead(lead)}`, SISTEMA_DE_CALIDAD));
    } catch (err) {
      // Sin gateway, sin uso o sin cuenta: el resto tampoco va a poder; se reintenta en la vuelta que sigue.
      const esperable = err instanceof ErrorDeLimite || err instanceof ErrorDeCuenta;
      log(`[homero] no pude clasificar las consultas (${esperable ? 'sin cuenta libre' : err instanceof Error ? err.message : String(err)}): queda para la próxima vuelta`);
      return hechas;
    }
    // Una respuesta que no se entiende deja ESA consulta sin calificar y sigue con las otras.
    if (!c) continue;
    // Solo si sigue sin calificar: si Gero la marco mientras tanto, no se pisa.
    if (await deps.store.guardarCalidadAuto(lead.id, c.calidad, c.motivo)) hechas++;
  }
  return hechas;
}
