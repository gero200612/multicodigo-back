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
 *
 * Ahorro y calidad: hasta 10 consultas por llamada (una tanda), con el modelo chico (HOMERO_MODELO_CHICO), y con
 * ejemplos de lo que ya califico el dueño (los mas parecidos, priorizando donde corrigio a la automatica).
 */

/** Cuantas consultas se clasifican por vuelta (y por llamada): el planificador pasa cada 5 minutos. */
export const POR_VUELTA = 10;
/** Hasta cuantos dias atras se clasifica lo que quedo sin calificar (sin gateway, sin cuentas libres). */
export const DIAS_PARA_CLASIFICAR = 3;

const CRITERIO = `${SISTEMA}

Ahora clasificás consultas que llegaron por un formulario. Criterio:
- "sirve": es un negocio, pyme, comercio, estudio o empresa (taller, local, clínica, estudio contable, distribuidora, etc.) que tiene algo para automatizar o un sistema que necesita (facturas, stock, turnos, cobranzas, atención por WhatsApp, un sistema a medida).
- "no_sirve": un particular sin negocio ("ama de casa", "personal", "mi casa"), un nombre propio puesto como empresa sin rubro ni necesidad concreta, spam, pruebas, o cosas sin relación con lo que hace Sincro.
- Si hay duda razonable de que sea un negocio real, es "sirve".
Si te paso ejemplos que calificó el dueño, seguí su criterio por encima del de arriba.
El motivo describe el negocio o la razón en general ("taller mecánico que quiere ordenar turnos", "particular sin negocio"): NUNCA nombres de personas ni de la empresa, mails, teléfonos ni números.`;

export const SISTEMA_DE_CALIDAD = `${CRITERIO}
Contestás SOLO un JSON: {"calidad": "sirve" | "no_sirve", "motivo": "hasta 100 caracteres"}.`;

export const SISTEMA_DE_CALIDAD_TANDA = `${CRITERIO}
Te paso varias consultas numeradas. Contestás SOLO un JSON array con un objeto por consulta, en cualquier orden: [{"n": 1, "calidad": "sirve" | "no_sirve", "motivo": "hasta 100 caracteres"}, ...]. Usá el mismo "n" que la consulta.`;

const Respuesta = z.object({ calidad: z.enum(['sirve', 'no_sirve']), motivo: z.string().optional() });
const ItemDeTanda = z.object({ n: z.number().int(), calidad: z.enum(['sirve', 'no_sirve']), motivo: z.string().optional() });

export interface Clasificacion {
  calidad: CalidadDeLead;
  motivo?: string;
}

const corto = (t: string, max: number) => neutralizar(t.replace(/\s+/g, ' ').trim().slice(0, max));

/**
 * Lo que se le muestra al modelo de una consulta: empresa, rubro y respuestas del formulario. Sin mail ni telefono.
 * `conContacto: false` (los ejemplos) tampoco lleva el nombre de la persona.
 */
export function fichaDeLead(l: Lead, conContacto = true): string {
  const formulario = (l.investigacion?.formulario ?? []).map((f) => `${corto(f.pregunta, 200)}: ${corto(f.respuesta, 600)}`);
  return [
    '<no_confiable>',
    `Empresa o nombre: ${corto(l.nombre, 120)}`,
    `Rubro: ${corto(l.rubro, 80)}`,
    ...(conContacto && l.investigacion?.contacto ? [`Persona que llenó: ${corto(l.investigacion.contacto, 80)}`] : []),
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

/**
 * La respuesta de una tanda: n (1..cuantas) -> clasificacion. Tolerante: un item que no se entiende (n fuera de rango,
 * calidad rara, repetido) se ignora y esa consulta queda sin calificar. Devuelve `undefined` si no hay array o no se
 * entendio ni un solo item: ahi se cae a una por una.
 */
export function parsearTanda(texto: string, cuantas: number): Map<number, Clasificacion> | undefined {
  const inicio = texto.indexOf('[');
  const fin = texto.lastIndexOf(']');
  if (inicio < 0 || fin <= inicio) return undefined;
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto.slice(inicio, fin + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(crudo)) return undefined;
  const hechas = new Map<number, Clasificacion>();
  for (const item of crudo) {
    const r = ItemDeTanda.safeParse(item);
    if (!r.success || r.data.n < 1 || r.data.n > cuantas || hechas.has(r.data.n)) continue;
    const motivo = motivoSeguro(r.data.motivo);
    hechas.set(r.data.n, { calidad: r.data.calidad, ...(motivo ? { motivo } : {}) });
  }
  return hechas.size > 0 ? hechas : undefined;
}

// ---------------------------------------------------------------- ejemplos del dueño

/** Cuantos ejemplos del dueño van al prompt. */
export const MAX_EJEMPLOS = 4;
/** Cuantas calificaciones del dueño se miran para elegir los ejemplos. */
const CANDIDATOS = 300;
/** Las palabras de menos de 4 letras no cuentan. */
const LARGO_MINIMO = 4;

/** Palabras de empresa, rubro y respuestas, en minuscula y sin tildes, sin las cortas. */
export function palabrasDe(l: Lead): Set<string> {
  const texto = [l.nombre, l.rubro, ...(l.investigacion?.formulario ?? []).map((f) => f.respuesta)].join(' ');
  const limpio = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return new Set(limpio.split(/[^a-z0-9]+/).filter((p) => p.length >= LARGO_MINIMO));
}

const esCorreccion = (l: Lead) => l.calidadAuto !== undefined && l.calidadAuto !== l.calidad;
const cuando = (l: Lead) => (l.calidadEn ?? l.creado)?.getTime() ?? 0;

type Puntuado = { c: Lead; puntos: number };
const mejor = (a: Puntuado, b: Puntuado) => b.puntos - a.puntos || cuando(b.c) - cuando(a.c) || b.c.id - a.c.id;

/**
 * Los ejemplos mas parecidos a las consultas que se van a clasificar entre lo que califico el dueño: puntaje por palabras
 * en comun (sumado sobre las consultas de la tanda), desempate por el mas reciente. Si hay una correccion (la automatica
 * dijo una cosa y el dueño otra) con algo en comun, entra siempre. Sin nada en comun no se inventa: solo las correcciones
 * mas recientes (hasta 2), que son lo que mas enseña.
 */
export function elegirEjemplos(leads: Lead[], candidatos: Lead[], max = MAX_EJEMPLOS): Lead[] {
  const ids = new Set(leads.map((l) => l.id));
  const buscadas = leads.map(palabrasDe);
  const puntuados: Puntuado[] = candidatos
    .filter((c) => c.calidad && !ids.has(c.id))
    .map((c) => {
      const mias = palabrasDe(c);
      return { c, puntos: buscadas.reduce((suma, b) => suma + [...b].filter((p) => mias.has(p)).length, 0) };
    });
  const parecidos = puntuados.filter((p) => p.puntos > 0).sort(mejor);
  if (parecidos.length === 0) {
    return puntuados
      .filter((p) => esCorreccion(p.c))
      .sort(mejor)
      .slice(0, Math.min(2, max))
      .map((p) => p.c);
  }
  const elegidos = parecidos.slice(0, max);
  if (!elegidos.some((p) => esCorreccion(p.c))) {
    const correccion = parecidos.find((p) => esCorreccion(p.c));
    if (correccion) elegidos[elegidos.length - 1] = correccion;
  }
  return elegidos.sort(mejor).map((p) => p.c);
}

/** El bloque de ejemplos para el prompt: solo empresa, rubro y respuestas + lo que dijo el dueño. Sin nombres de personas, mails ni telefonos. */
export function bloqueDeEjemplos(ejemplos: Lead[]): string {
  if (ejemplos.length === 0) return '';
  const items = ejemplos.map((e, i) => `Ejemplo ${i + 1}, el dueño calificó "${e.calidad}":\n${fichaDeLead(e, false)}`);
  return `Ejemplos de consultas que calificó el dueño (seguí su criterio):\n\n${items.join('\n\n')}\n\n`;
}

// ---------------------------------------------------------------- clasificar

export interface DepsDeCalidad {
  store: Pick<Store, 'leadsSinCalidad' | 'guardarCalidadAuto'> & Partial<Pick<Store, 'leadsCalificadosPorElDueño'>>;
  /** El mismo camino de modelo que usa Homero para pensar: el gateway (ver `pedirTexto`). Sin gateway tira y no se clasifica. */
  pedirIa: (prompt: string, sistema: string) => Promise<string>;
  ahora: () => Date;
  log?: (t: string) => void;
}

function promptDeTanda(leads: Lead[], ejemplos: string): string {
  const fichas = leads.map((l, i) => `Consulta ${i + 1}:\n${fichaDeLead(l)}`).join('\n\n');
  return `${ejemplos}Clasificá estas ${leads.length} consultas.\n\n${fichas}`;
}

/**
 * Clasifica las consultas que siguen sin calificar. Se dispara desde el planificador (cada 5 minutos) y despues de leer
 * los formularios de Meta. Hasta 10 por llamada (una tanda); si la respuesta de la tanda no se entiende, cae a una por
 * una. Sin gateway o sin cuentas libres corta la vuelta y deja todo sin calificar: la proxima lo reintenta (nunca frena
 * el flujo de leads). Devuelve cuantas clasifico.
 */
export async function clasificarPendientes(deps: DepsDeCalidad): Promise<number> {
  const log = deps.log ?? console.warn;
  const desde = new Date(deps.ahora().getTime() - DIAS_PARA_CLASIFICAR * 24 * 3_600_000);
  const leads = await deps.store.leadsSinCalidad(POR_VUELTA, desde);
  if (leads.length === 0) return 0;
  const ejemplos = bloqueDeEjemplos(elegirEjemplos(leads, (await deps.store.leadsCalificadosPorElDueño?.(CANDIDATOS)) ?? []));
  let hechas = 0;
  // Solo si sigue sin calificar: si Gero la marco mientras tanto, no se pisa.
  const guardar = async (lead: Lead, c: Clasificacion) => {
    if (await deps.store.guardarCalidadAuto(lead.id, c.calidad, c.motivo)) hechas++;
  };
  try {
    const tanda = leads.length > 1 ? parsearTanda(await deps.pedirIa(promptDeTanda(leads, ejemplos), SISTEMA_DE_CALIDAD_TANDA), leads.length) : undefined;
    if (tanda) {
      // Lo que el modelo no devolvio (o devolvio mal) queda sin calificar para la proxima vuelta.
      for (const [n, c] of tanda) await guardar(leads[n - 1]!, c);
      return hechas;
    }
    for (const lead of leads) {
      // Una respuesta que no se entiende deja ESA consulta sin calificar y sigue con las otras.
      const c = parsearClasificacion(await deps.pedirIa(`${ejemplos}Clasificá esta consulta.\n\n${fichaDeLead(lead)}`, SISTEMA_DE_CALIDAD));
      if (c) await guardar(lead, c);
    }
  } catch (err) {
    // Sin gateway, sin uso o sin cuenta: el resto tampoco va a poder; se reintenta en la vuelta que sigue.
    const esperable = err instanceof ErrorDeLimite || err instanceof ErrorDeCuenta;
    log(`[homero] no pude clasificar las consultas (${esperable ? 'sin cuenta libre' : err instanceof Error ? err.message : String(err)}): queda para la próxima vuelta`);
  }
  return hechas;
}

// ---------------------------------------------------------------- acierto

export interface CorreccionDelDueño {
  leadId: number;
  empresa: string;
  auto: CalidadDeLead;
  dueño: CalidadDeLead;
  motivo?: string;
  en?: Date;
}

export interface AciertoDeCalidad {
  /** Consultas con calificacion automatica que el dueño corrigio o confirmo. */
  comparados: number;
  coinciden: number;
  /** 0 a 100, entero; 0 si todavia no hay con que comparar. */
  porcentaje: number;
  /** Las mas recientes donde el dueño no estuvo de acuerdo con la automatica. */
  ultimas_correcciones: CorreccionDelDueño[];
}

/** Cuanto acierta la clasificacion automatica, contra lo que dijo el dueño (corrigiendo o confirmando con el boton). */
export async function aciertoDeCalidad(store: Pick<Store, 'leadsCalificadosPorElDueño'>, ultimas = 5): Promise<AciertoDeCalidad> {
  const comparables = (await store.leadsCalificadosPorElDueño(1000)).filter((l) => l.calidad && l.calidadAuto);
  const coinciden = comparables.filter((l) => !esCorreccion(l)).length;
  return {
    comparados: comparables.length,
    coinciden,
    porcentaje: comparables.length ? Math.round((coinciden * 100) / comparables.length) : 0,
    ultimas_correcciones: comparables
      .filter(esCorreccion)
      .sort((a, b) => cuando(b) - cuando(a) || b.id - a.id)
      .slice(0, ultimas)
      .map((l) => ({
        leadId: l.id,
        empresa: l.nombre,
        auto: l.calidadAuto!,
        dueño: l.calidad!,
        ...(l.calidadMotivo ? { motivo: l.calidadMotivo } : {}),
        ...(l.calidadEn ? { en: l.calidadEn } : {}),
      })),
  };
}

const ROTULO: Record<CalidadDeLead, string> = { sirve: 'sirve', no_sirve: 'no sirve' };

/** El texto de /acierto. */
export function textoDeAcierto(a: AciertoDeCalidad): string {
  if (a.comparados === 0) return 'Todavía no tengo con qué comparar: cuando marques con los botones Sirve / No sirve consultas que califiqué yo, te cuento cuánto acerté.';
  const lineas = [`🎯 Acierto al calificar consultas: ${a.porcentaje}% (${a.coinciden} de ${a.comparados} coinciden con lo que marcaste).`];
  if (a.ultimas_correcciones.length > 0) {
    lineas.push('', 'Últimas correcciones tuyas:');
    for (const c of a.ultimas_correcciones) lineas.push(`• ${c.empresa}: yo dije "${ROTULO[c.auto]}", vos "${ROTULO[c.dueño]}"`);
  }
  return lineas.join('\n');
}
