/**
 * El mes y el dia se cuentan en hora argentina: el tope es "por mes" para el
 * cliente, y el 1 a las 00:30 de Buenos Aires todavia es el mes anterior en
 * UTC. Argentina no tiene horario de verano, asi que alcanza con -3 fijo.
 */
const DESFASE_MS = 3 * 3600_000;

/** `2026-10` */
export function mesDe(fecha: Date): string {
  return new Date(fecha.getTime() - DESFASE_MS).toISOString().slice(0, 7);
}

/** `2026-10-10` */
export function diaDe(fecha: Date): string {
  return new Date(fecha.getTime() - DESFASE_MS).toISOString().slice(0, 10);
}

/** Desde (incluido) y hasta (excluido) de un mes `AAAA-MM`. */
export function rangoDelMes(mes: string): { desde: Date; hasta: Date } {
  const [a, m] = mes.split('-').map(Number) as [number, number];
  return {
    desde: new Date(Date.UTC(a, m - 1, 1) + DESFASE_MS),
    hasta: new Date(Date.UTC(a, m, 1) + DESFASE_MS),
  };
}

export const HORA_MS = 3600_000;
export const DIA_MS = 24 * HORA_MS;
