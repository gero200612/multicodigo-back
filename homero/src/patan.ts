import { z } from 'zod';
import { extraerJson } from './prompts.js';
import { rubroPorId } from './rubros.js';
import type { Demo, Lead, Store } from './store.js';
import type { DepsDeVentas } from './ventas.js';

/**
 * Patán arma el presupuesto de una app despues de la reunion: un precio por
 * armarla y un abono mensual de mantenimiento con horas de soporte.
 *
 * Vive adentro de Homero (misma base, misma cola, misma cuenta de Claude sin
 * herramientas). En la web es su propia seccion, /patan.
 *
 * El precio sale del VALOR para el cliente: Claude estima cuantas horas por
 * mes le ahorra la app y cuanto cuesta esa hora, y la regla de Gero lo
 * convierte en numeros. Esa cuenta queda en `justificacion`, que ve solo Gero:
 * el PDF dice unicamente lo que se cobra.
 */

// ---------------------------------------------------------------- la regla

export const Regla = z.object({
  /** El armado vale este tanto de meses del ahorro: el cliente lo recupera en ese tiempo. */
  mesesDeAhorro: z.number().min(0.5).max(24),
  /** Nunca menos que esto por armar una app (USD). */
  pisoArmado: z.number().min(0),
  /** El abono es esta parte del ahorro mensual. */
  porcentajeAbono: z.number().min(0).max(1),
  /** Nunca menos que esto por mes: cubre hosting y soporte (USD). */
  pisoAbono: z.number().min(0),
  /** Horas de soporte por mes incluidas en el abono. */
  horasSoporte: z.number().int().min(0).max(200),
  /** Parte del armado que se paga al aprobar (el resto, a la entrega). */
  anticipo: z.number().min(0).max(1),
  validezDias: z.number().int().min(1).max(365),
});
export type Regla = z.infer<typeof Regla>;

export const REGLA_INICIAL: Regla = {
  mesesDeAhorro: 4,
  pisoArmado: 1000,
  porcentajeAbono: 0.12,
  pisoAbono: 60,
  horasSoporte: 4,
  anticipo: 0.5,
  validezDias: 15,
};

const CLAVE_DE_REGLA = 'patan:regla';

export async function reglaActual(store: Store): Promise<Regla> {
  const guardada = Regla.safeParse(await store.leerEstado(CLAVE_DE_REGLA));
  return guardada.success ? guardada.data : REGLA_INICIAL;
}

export async function guardarRegla(store: Store, regla: Regla): Promise<void> {
  await store.guardarEstado(CLAVE_DE_REGLA, regla);
}

/** Redondeo comercial: 1.237 -> 1.250, 83 -> 85. */
const redondear = (n: number) => (n >= 500 ? Math.round(n / 50) * 50 : Math.round(n / 5) * 5);

export function precios(ahorroMensual: number, r: Regla): { armado: number; abono: number } {
  return {
    armado: redondear(Math.max(r.pisoArmado, ahorroMensual * r.mesesDeAhorro)),
    abono: redondear(Math.max(r.pisoAbono, ahorroMensual * r.porcentajeAbono)),
  };
}

// ---------------------------------------------------------------- el presupuesto

const Texto = z.string().trim().min(1);

/** Lo que va en el PDF. Gero lo puede editar entero antes de bajarlo. */
export const Contenido = z.object({
  titulo: Texto.max(160),
  resumen: Texto.max(1200),
  incluye: z.array(Texto.max(400)).min(1).max(30),
  noIncluye: z.array(Texto.max(400)).max(20),
  plazoSemanas: z.number().int().min(1).max(104),
  armado: z.object({ precio: z.number().min(0), formaDePago: Texto.max(400) }),
  abono: z.object({
    precio: z.number().min(0),
    incluye: z.array(Texto.max(300)).min(1).max(15),
    horasSoporte: z.number().int().min(0).max(200),
  }),
  condiciones: z.array(Texto.max(400)).max(15),
  validezDias: z.number().int().min(1).max(365),
});
export type Contenido = z.infer<typeof Contenido>;

/** De donde sale el precio. Solo para Gero. */
export interface Justificacion {
  personas?: number;
  usuarios?: string;
  horasAhorradasMes: number;
  costoHora: number;
  ahorroMensual: number;
  razonamiento: string;
  armadoSugerido: number;
  abonoSugerido: number;
}

/** Lo que devuelve Claude. Los precios NO: esos los pone la regla. */
const RespuestaDeIa = z.object({
  personas: z.coerce.number().int().min(1).optional(),
  usuarios: z.string().optional(),
  horas_ahorradas_mes: z.coerce.number().min(0).max(5000),
  costo_hora_usd: z.coerce.number().min(0).max(200),
  razonamiento: z.string(),
  titulo: z.string().min(1),
  resumen: z.string().min(1),
  incluye: z.array(z.string().min(1)).min(1),
  no_incluye: z.array(z.string()).default([]),
  plazo_semanas: z.coerce.number().int().min(1).max(52),
  abono_incluye: z.array(z.string().min(1)).min(1),
});

export function promptDePresupuesto(o: { lead: Lead; demo: Demo; notas: string; regla: Regla }): string {
  const { lead, demo, notas, regla } = o;
  const inv = lead.investigacion;
  return `Sos Patán, el que arma los presupuestos de Gero (Geronimo Enrici, de Sincro). Gero arma aplicaciones a medida para pymes argentinas: automatizan procesos (facturas, cobranzas, stock, turnos, pedidos), con IA y un bot de WhatsApp cuando suma.

Ya hubo una reunión con este cliente y Punchi armó una demo. Tu trabajo: definir qué se va a armar y estimar cuánto le ahorra al cliente por mes. El PRECIO no lo ponés vos: sale de tu estimación del ahorro.

EMPRESA
Nombre: ${lead.nombre}
Rubro: ${rubroPorId(lead.rubro)?.nombre ?? lead.rubro} · ${lead.ciudad}
${inv ? `Qué hacen: ${inv.resumen_empresa}
Qué les falta: ${inv.dolor}
La propuesta del primer mail: ${inv.idea}` : ''}
${inv?.personas ? `Personas estimadas: ${inv.personas}` : ''}
${inv?.usuarios ? `Quién la usaría: ${inv.usuarios}` : ''}

LO QUE PIDIÓ LA DEMO (el pliego que se le pasó a Punchi)
${demo.pliego ?? '(sin pliego)'}

NOTAS DE GERO DE LA REUNIÓN (lo más importante: si contradicen lo de arriba, mandan las notas)
${notas.trim() || '(Gero no dejó notas)'}

CÓMO ESTIMAR EL AHORRO
- Cuántas personas usan hoy ese proceso a mano y cuántas horas por mes le dedican entre todas. Lo que ahorra la app son las horas que deja de llevar ese trabajo, no todas.
- Costo de la hora en USD de un empleado administrativo de una pyme argentina del rubro (sueldo + cargas, dividido las horas del mes). Si las notas dan un sueldo, usalo.
- Sé conservador: si dudás, estimá de menos. Un presupuesto que se cae porque el ahorro no es creíble es peor que uno barato.

QUÉ VA A DECIR EL PRESUPUESTO (lo lee el cliente)
- Título: qué es la aplicación, para quién. Ej: "Sistema de turnos y cobros para Clínica Levín".
- Resumen: 2 o 3 oraciones, qué resuelve, en el idioma del cliente (nada técnico).
- Incluye: las funcionalidades concretas, una por línea, verificables ("Carga de facturas recibidas por WhatsApp", no "módulo de IA").
- No incluye: lo que razonablemente podría esperar y no entra (integraciones que no se hablaron, migración de datos viejos, app nativa), para que no haya sorpresas.
- Plazo en semanas: realista para una persona con agentes de IA. Una app chica, 2 a 4 semanas.
- Qué cubre el abono mensual: hosting, backups, actualizaciones, ${regla.horasSoporte} horas de soporte y cambios chicos por mes, etc.

Contestá SOLO con este JSON:
{
  "personas": 12,
  "usuarios": "administración (2) y vendedores (4)",
  "horas_ahorradas_mes": 60,
  "costo_hora_usd": 6,
  "razonamiento": "de dónde salen esas horas y ese costo, en 2 o 3 oraciones, para Gero",
  "titulo": "...",
  "resumen": "...",
  "incluye": ["...", "..."],
  "no_incluye": ["...", "..."],
  "plazo_semanas": 3,
  "abono_incluye": ["...", "..."]
}`;
}

export function leerPresupuesto(
  texto: string,
  regla: Regla,
): { contenido: Contenido; justificacion: Justificacion } | undefined {
  const r = RespuestaDeIa.safeParse(extraerJson(texto));
  if (!r.success) return undefined;
  const ia = r.data;
  const ahorroMensual = Math.round(ia.horas_ahorradas_mes * ia.costo_hora_usd);
  const p = precios(ahorroMensual, regla);
  const anticipo = Math.round(regla.anticipo * 100);
  const contenido: Contenido = {
    titulo: ia.titulo.trim(),
    resumen: ia.resumen.trim(),
    incluye: ia.incluye.map((x) => x.trim()),
    noIncluye: ia.no_incluye.map((x) => x.trim()).filter(Boolean),
    plazoSemanas: ia.plazo_semanas,
    armado: {
      precio: p.armado,
      formaDePago:
        anticipo >= 100
          ? '100% al aprobar el presupuesto.'
          : anticipo <= 0
            ? '100% a la entrega.'
            : `${anticipo}% al aprobar el presupuesto y ${100 - anticipo}% a la entrega.`,
    },
    abono: { precio: p.abono, incluye: ia.abono_incluye.map((x) => x.trim()), horasSoporte: regla.horasSoporte },
    condiciones: [
      'Precios en dólares estadounidenses. Se pueden pagar en pesos al tipo de cambio del día de pago.',
      'El abono mensual empieza a correr desde la entrega.',
      `Las horas de soporte que no se usan en el mes no se acumulan.`,
      'Los cambios que excedan las horas incluidas se presupuestan aparte.',
    ],
    validezDias: regla.validezDias,
  };
  const valido = Contenido.safeParse(contenido);
  if (!valido.success) return undefined;
  return {
    contenido: valido.data,
    justificacion: {
      personas: ia.personas,
      usuarios: ia.usuarios,
      horasAhorradasMes: ia.horas_ahorradas_mes,
      costoHora: ia.costo_hora_usd,
      ahorroMensual,
      razonamiento: ia.razonamiento.trim(),
      armadoSugerido: p.armado,
      abonoSugerido: p.abono,
    },
  };
}

// ---------------------------------------------------------------- acciones

export type ResultadoDePatan = { ok: true; presupuestoId: number } | { ok: false; motivo: string };

/** Las demos que se pueden presupuestar: ya se mandaron a Punchi. */
const PRESUPUESTABLE = new Set(['enviada', 'lista']);

/** Guarda las notas y le pide el presupuesto a Claude. Rehacerlo pisa el anterior. */
export async function pedirPresupuesto(demoId: number, notas: string, store: Store): Promise<ResultadoDePatan> {
  const demo = await store.demo(demoId);
  if (!demo || !PRESUPUESTABLE.has(demo.estado)) return { ok: false, motivo: 'esa demo todavía no está para presupuestar' };
  const previo = await store.presupuestoDeDemo(demoId);
  if (previo?.estado === 'armando') return { ok: false, motivo: 'Patán ya está armando ese presupuesto' };
  const id = await store.guardarPedidoDePresupuesto({ demoId, leadId: demo.leadId, notas: notas.trim() });
  await store.encolar({ tipo: 'presupuestar', payload: { presupuestoId: id }, requiereIa: true });
  return { ok: true, presupuestoId: id };
}

export async function editarPresupuesto(id: number, contenido: Contenido, store: Store): Promise<ResultadoDePatan> {
  const p = await store.presupuesto(id);
  if (!p || p.estado === 'armando') return { ok: false, motivo: 'ese presupuesto no se puede editar ahora' };
  await store.actualizarPresupuesto(id, { contenido, estado: 'listo', error: '' });
  return { ok: true, presupuestoId: id };
}

/** Si Claude contesta algo ilegible, una vez mas. Si vuelve a pasar, queda `fallido` para reintentar desde la web. */
const INTENTOS_DE_LECTURA = 2;

/** La tarea `presupuestar`. */
export async function presupuestar(payload: unknown, deps: DepsDeVentas): Promise<void> {
  const { presupuestoId } = z.object({ presupuestoId: z.number() }).parse(payload);
  const p = await deps.store.presupuesto(presupuestoId);
  if (!p || p.estado !== 'armando') return;
  const demo = await deps.store.demo(p.demoId);
  const lead = await deps.store.lead(p.leadId);
  if (!demo || !lead) {
    await deps.store.actualizarPresupuesto(presupuestoId, { estado: 'fallido', error: 'no encuentro la demo o la empresa' });
    return;
  }
  const regla = await reglaActual(deps.store);
  const prompt = promptDePresupuesto({ lead, demo, notas: p.notas, regla });
  for (let i = 0; i < INTENTOS_DE_LECTURA; i++) {
    // Los errores de la IA (limite, cuenta) suben: la cola los espera y reintenta.
    const leido = leerPresupuesto(await (deps.pedirIaPatan ?? deps.pedirIa)(prompt), regla);
    if (leido) {
      await deps.store.actualizarPresupuesto(presupuestoId, { ...leido, estado: 'listo', error: '' });
      await deps.avisar(
        `📄 Patán armó el presupuesto de ${lead.nombre}: armado USD ${leido.contenido.armado.precio}, abono USD ${leido.contenido.abono.precio}/mes. Revisalo en punchi.dev/patan.`,
      );
      return;
    }
  }
  await deps.store.actualizarPresupuesto(presupuestoId, {
    estado: 'fallido',
    error: 'Claude no devolvió un presupuesto legible. Probá de nuevo.',
  });
}
