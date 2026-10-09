import { z } from 'zod';
import { diaArgentino } from './agenda.js';
import type { Cliente, CuentaClaude, Fijo, Moneda, Pago, Store } from './store.js';

/**
 * Los números de la empresa, para el Administrador: lo que se gasta (cuentas
 * de Claude, publicidad, fijos), lo que entra y el resultado del mes, en USD.
 *
 * - Claude: CUÁNTAS cuentas hay lo dice Punchi (los slots con cuenta cargada);
 *   cada una paga su plan, por defecto la Pro de USD 20. Se cuenta por día con
 *   la foto de ese día, así una cuenta que entra a mitad de mes paga su parte.
 * - Publicidad: lo que Homero ya guarda de Meta, en pesos, pasado a dólares con
 *   el dólar tarjeta de ESE día (la cotización se guarda: un mes cerrado no
 *   cambia cuando se mueve el dólar).
 * - Lo que entra: los pagos de los clientes, cargados a mano.
 */

export const PLAN_POR_DEFECTO = { plan: 'Pro', precio: 20, esGasto: true } as const;
/** Gratis y sin clave. El dólar tarjeta es el que se paga de verdad por Meta. */
export const URL_DEL_DOLAR = 'https://dolarapi.com/v1/dolares/tarjeta';

export interface ClienteDeCuentas {
  /** Los slots con una cuenta de Claude cargada, con una huella de la cuenta (no el mail) si se sabe. */
  cuentas(): Promise<{ slot: string; cuenta?: string }[]>;
}

/** Clave en homero.estado: qué slots usan cada cuenta, para mostrarlo ("c1, c4"). */
export const AGENTES_POR_CUENTA = 'finanzas:agentes_por_cuenta';

/**
 * Las suscripciones, no los agentes: varios slots pueden usar la misma cuenta
 * de Claude (el 2026-10-09 había 6 slots sobre 3 cuentas Pro). Se agrupan por
 * la huella de la cuenta; un slot sin huella cuenta solo, con su nombre. Cada
 * cuenta se nombra por su primer slot, que es lo que Gero reconoce.
 */
export function suscripciones(slots: readonly { slot: string; cuenta?: string }[]): { id: string; slots: string[] }[] {
  const porCuenta = new Map<string, string[]>();
  for (const s of slots) {
    const clave = s.cuenta?.trim() || s.slot;
    porCuenta.set(clave, [...(porCuenta.get(clave) ?? []), s.slot]);
  }
  const orden = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  return [...porCuenta.values()]
    .map((ss) => ss.sort(orden))
    .map((ss) => ({ id: ss[0]!, slots: ss }))
    .sort((a, b) => orden(a.id, b.id));
}

export interface DepsDeFinanzas {
  store: Store;
  ahora: () => Date;
  /** Sin esto (faltan BRIDGE_URL o el token) no se sabe cuántas cuentas hay. */
  punchi?: ClienteDeCuentas;
  /** El dólar tarjeta de hoy (pesos por dólar). Por defecto, de dolarapi.com. */
  pedirDolar?: () => Promise<number>;
}

export async function dolarDeDolarApi(pedir: typeof fetch = fetch): Promise<number> {
  const r = await pedir(URL_DEL_DOLAR, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`dolarapi contestó ${r.status}`);
  const venta = Number(((await r.json()) as { venta?: unknown }).venta);
  if (!Number.isFinite(venta) || venta <= 0) throw new Error('dolarapi no trajo el valor de venta');
  return venta;
}

/**
 * Una vez por día: la cotización y la foto de las cuentas. Cada una por su
 * lado: si el dólar no contesta, la foto igual se guarda, y al revés.
 */
export async function finanzasDelDia(deps: DepsDeFinanzas): Promise<{ dolar?: number; cuentas?: string[] }> {
  const hoy = diaArgentino(deps.ahora());
  const r: { dolar?: number; cuentas?: string[] } = {};
  try {
    r.dolar = await (deps.pedirDolar ?? (() => dolarDeDolarApi()))();
    await deps.store.guardarCotizacion(hoy, r.dolar);
  } catch (err) {
    console.error('[homero] no pude leer el dólar:', err);
  }
  if (deps.punchi) {
    try {
      const s = suscripciones(await deps.punchi.cuentas());
      r.cuentas = s.map((c) => c.id);
      await deps.store.guardarCuentasDelDia(hoy, r.cuentas);
      await deps.store.guardarEstado(AGENTES_POR_CUENTA, Object.fromEntries(s.map((c) => [c.id, c.slots])));
    } catch (err) {
      console.error('[homero] no pude leer las cuentas de Punchi:', err);
    }
  }
  return r;
}

/** Con el planificador: una vez por día, la cotización y la foto de las cuentas. */
export async function planificarFinanzas(deps: Pick<DepsDeFinanzas, 'store' | 'ahora'>): Promise<void> {
  const dia = diaArgentino(deps.ahora());
  await deps.store.encolar({ tipo: 'finanzas_del_dia', payload: {}, requiereIa: false, clave: `finanzas:${dia}` });
}

// ------------------------------------------------------------ fechas

/** `AAAA-MM` del instante, en hora argentina. */
export function mesActual(ahora: Date): string {
  return diaArgentino(ahora).slice(0, 7);
}

export function diasDe(mes: string): { primerDia: string; ultimoDia: string; dias: string[] } {
  const [anio, m] = mes.split('-').map(Number) as [number, number];
  const cantidad = new Date(Date.UTC(anio, m, 0)).getUTCDate();
  const dias = Array.from({ length: cantidad }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`);
  return { primerDia: dias[0]!, ultimoDia: dias.at(-1)!, dias };
}

/** `2026-01` -> `2025-12`. */
export function mesAnterior(mes: string): string {
  const [anio, m] = mes.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(anio, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------ el dólar

/**
 * El dólar de un día: el de ese día si se guardó, o el último anterior. Si no
 * hay ninguno anterior (días de antes de que existiera esto), el primero que haya.
 */
export function dolarDel(dia: string, cotizaciones: readonly { dia: string; valor: number }[]): number | undefined {
  let elegido: number | undefined;
  for (const c of cotizaciones) {
    if (c.dia <= dia) elegido = c.valor;
    else break;
  }
  return elegido ?? cotizaciones[0]?.valor;
}

function aUsd(monto: number, moneda: Moneda, dolar: number | undefined): number | undefined {
  if (moneda === 'USD') return monto;
  return dolar ? monto / dolar : undefined;
}

const redondo = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------ el mes

export interface CuentaDelMes extends CuentaClaude {
  /** Los agentes que la usan (la última foto), si se sabe: "c1, c4". */
  agentes?: string[];
  /** Días del mes que estuvo vinculada. */
  dias: number;
  /** Lo que paga este mes: su plan por la parte del mes que estuvo. */
  usd: number;
}

export interface NumerosDeFinanzas {
  mes: string;
  /** El dólar tarjeta con el que se pasaron los pesos: el último del mes. */
  dolar?: { valor: number; dia: string };
  claude: {
    usd: number;
    cuentas: CuentaDelMes[];
    /** No hay ninguna foto de cuentas: Punchi nunca contestó. */
    sinDatos: boolean;
  };
  publicidad: { ars: number; usd?: number; consultas: number };
  fijos: (Fijo & { usd?: number })[];
  /** Todo lo gastado en USD. Sin dólar, lo que esté en pesos no se puede sumar. */
  gastado: number;
  ingresos: { usd: number; pagos: (Pago & { usd?: number; cliente?: string })[] };
  resultado: number;
  /** Cuántos clientes con el abono mínimo hacen falta para cubrir lo gastado. */
  paraCubrir: { clientes: number; abono: number };
  /** Algo en pesos sin dólar con qué pasarlo: el total queda corto. */
  faltaDolar: boolean;
}

/** Un fijo cuenta en el mes si estuvo vigente algún día. El anual, por doceavos. */
function fijoDelMes(f: Fijo, primerDia: string, ultimoDia: string): number {
  if (f.desde > ultimoDia || (f.hasta && f.hasta < primerDia)) return 0;
  return f.periodo === 'anual' ? f.monto / 12 : f.monto;
}

/**
 * Las cuentas de cada día del mes. Un día sin foto usa la anterior; los días
 * antes de la primera foto, y los que todavía no llegaron, la más cercana. Así
 * el mes en curso ya muestra lo que se va a pagar entero.
 */
function cuentasPorDiaDelMes(dias: string[], fotos: { dia: string; slots: string[] }[]): Map<string, string[]> {
  const r = new Map<string, string[]>();
  if (fotos.length === 0) return r;
  let i = 0;
  let actual = fotos[0]!.slots;
  for (const dia of dias) {
    while (i < fotos.length && fotos[i]!.dia <= dia) actual = fotos[i++]!.slots;
    r.set(dia, actual);
  }
  return r;
}

export async function numerosDeFinanzas(
  deps: Pick<DepsDeFinanzas, 'store'>,
  mes: string,
  pisoAbono: number,
): Promise<NumerosDeFinanzas> {
  const { primerDia, ultimoDia, dias } = diasDe(mes);
  const [cotizaciones, fotosTodas, planes, fijos, gastos, pagos, clientes, agentesPorCuenta] = await Promise.all([
    deps.store.cotizaciones(ultimoDia),
    // "Desde siempre": Postgres no acepta el año 0000.
    deps.store.cuentasPorDia('1970-01-01'),
    deps.store.cuentasClaude(),
    deps.store.fijos(),
    deps.store.gastos(primerDia),
    deps.store.pagos(primerDia, ultimoDia),
    deps.store.clientes(),
    deps.store.leerEstado<Record<string, string[]>>(AGENTES_POR_CUENTA),
  ]);

  // La última foto ANTES del mes también cuenta: es la que rige desde el día 1.
  const previa = fotosTodas.filter((f) => f.dia < primerDia).at(-1);
  const delMes = fotosTodas.filter((f) => f.dia >= primerDia && f.dia <= ultimoDia);
  const fotos = previa ? [{ ...previa, dia: primerDia }, ...delMes.filter((f) => f.dia !== primerDia)] : delMes;
  const porDia = cuentasPorDiaDelMes(dias, fotos.length ? fotos : fotosTodas.slice(-1));

  const planDe = (slot: string) => planes.find((p) => p.slot === slot) ?? { slot, ...PLAN_POR_DEFECTO };
  const diasPorSlot = new Map<string, number>();
  for (const slots of porDia.values()) for (const s of slots) diasPorSlot.set(s, (diasPorSlot.get(s) ?? 0) + 1);
  const cuentas: CuentaDelMes[] = [...diasPorSlot.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([slot, d]) => {
      const plan = planDe(slot);
      const agentes = agentesPorCuenta?.[slot];
      // La que no es gasto se lista igual, en cero: Gero tiene que verla para poder prenderla.
      const usd = plan.esGasto ? redondo((plan.precio * d) / dias.length) : 0;
      return { ...plan, ...(agentes ? { agentes } : {}), dias: d, usd };
    });
  const claudeUsd = redondo(cuentas.reduce((n, c) => n + c.usd, 0));

  let faltaDolar = false;
  let publicidadSinDolar = false;
  let publicidadArs = 0;
  let publicidadUsd = 0;
  let consultas = 0;
  for (const g of gastos.filter((x) => x.dia <= ultimoDia)) {
    publicidadArs += g.gasto;
    consultas += g.consultas;
    const usd = aUsd(g.gasto, 'ARS', dolarDel(g.dia, cotizaciones));
    if (usd === undefined) publicidadSinDolar = true;
    else publicidadUsd += usd;
  }

  const dolarDelMes = dolarDel(ultimoDia, cotizaciones);
  const fijosDelMes = fijos
    .map((f) => ({ f, monto: fijoDelMes(f, primerDia, ultimoDia) }))
    .filter((x) => x.monto > 0)
    .map(({ f, monto }) => {
      const usd = aUsd(monto, f.moneda, dolarDelMes);
      if (usd === undefined) faltaDolar = true;
      return { ...f, ...(usd !== undefined ? { usd: redondo(usd) } : {}) };
    });

  const nombreDe = (id: number) => clientes.find((c: Cliente) => c.id === id)?.nombre;
  const pagosDelMes = pagos.map((p) => {
    const usd = aUsd(p.monto, p.moneda, dolarDel(p.dia, cotizaciones));
    if (usd === undefined) faltaDolar = true;
    return { ...p, ...(usd !== undefined ? { usd: redondo(usd) } : {}), cliente: nombreDe(p.clienteId) };
  });
  const ingresos = redondo(pagosDelMes.reduce((n, p) => n + (p.usd ?? 0), 0));

  const gastado = redondo(claudeUsd + publicidadUsd + fijosDelMes.reduce((n, f) => n + (f.usd ?? 0), 0));
  const ultimaCot = [...cotizaciones].reverse().find((c) => c.dia <= ultimoDia);
  return {
    mes,
    ...(ultimaCot ? { dolar: { valor: ultimaCot.valor, dia: ultimaCot.dia } } : {}),
    claude: { usd: claudeUsd, cuentas, sinDatos: fotosTodas.length === 0 },
    // Sin dólar no hay USD de publicidad: mejor vacío que un número que parece cero.
    publicidad: { ars: redondo(publicidadArs), ...(publicidadSinDolar ? {} : { usd: redondo(publicidadUsd) }), consultas },
    fijos: fijosDelMes,
    gastado,
    ingresos: { usd: ingresos, pagos: pagosDelMes },
    resultado: redondo(ingresos - gastado),
    paraCubrir: { clientes: pisoAbono > 0 ? Math.ceil(gastado / pisoAbono) : 0, abono: pisoAbono },
    faltaDolar: faltaDolar || publicidadSinDolar,
  };
}

// ------------------------------------------------------------ lo que se carga a mano

const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Monto = z.number().finite().min(0).max(100_000_000);

export const FijoNuevo = z.object({
  nombre: z.string().trim().min(1).max(120),
  monto: Monto,
  moneda: z.enum(['ARS', 'USD']),
  periodo: z.enum(['mensual', 'anual']),
  desde: Dia,
  hasta: Dia.optional(),
});

export const PlanDeCuenta = z.object({
  plan: z.string().trim().min(1).max(40),
  precio: z.number().finite().min(0).max(10_000),
  esGasto: z.boolean().default(true),
});

export const ClienteNuevo = z.object({
  nombre: z.string().trim().min(1).max(160),
  proyecto: z.string().trim().max(120).optional(),
  armado: Monto,
  abono: Monto,
  desde: Dia,
  estado: z.enum(['activo', 'baja']).default('activo'),
});

export const PagoNuevo = z.object({
  clienteId: z.number().int().positive(),
  dia: Dia,
  monto: z.number().finite().positive().max(100_000_000),
  moneda: z.enum(['ARS', 'USD']),
  concepto: z.enum(['armado', 'abono', 'otro']),
});
