import { z } from 'zod';

/**
 * La libreta de un agente como checklist: lo que tiene en cuenta y lo que no
 * va. Gero la lee de un vistazo en la web (✓ / ✗) en vez de un texto largo, y
 * el agente la escribe en el mismo formato.
 *
 * En la base sigue siendo texto (`homero.libretas.contenido`), con el JSON
 * adentro: no hace falta migrar, y una libreta vieja de texto libre se lee
 * como una lista de "tiene en cuenta", una linea por item.
 */

export const ITEMS_POR_LISTA = 25;
export const LARGO_DE_ITEM = 200;

export const Libreta = z.object({
  tenerEnCuenta: z.array(z.string().trim().min(1).max(LARGO_DE_ITEM)).max(ITEMS_POR_LISTA),
  evitar: z.array(z.string().trim().min(1).max(LARGO_DE_ITEM)).max(ITEMS_POR_LISTA),
});
export type Libreta = z.infer<typeof Libreta>;

export function leerLibreta(contenido: string): Libreta {
  const t = contenido.trim();
  if (!t) return { tenerEnCuenta: [], evitar: [] };
  try {
    const r = Libreta.safeParse(JSON.parse(t));
    if (r.success) return r.data;
  } catch {
    // texto libre de antes: abajo
  }
  const lineas = t
    .split('\n')
    .map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && !/^#/.test(l))
    .map((l) => l.slice(0, LARGO_DE_ITEM));
  return { tenerEnCuenta: lineas.slice(0, ITEMS_POR_LISTA), evitar: [] };
}

export function escribirLibreta(l: Libreta): string {
  return JSON.stringify({ tenerEnCuenta: l.tenerEnCuenta, evitar: l.evitar });
}

/** Como la ve el agente en su objetivo: dos listas. */
export function libretaComoTexto(l: Libreta): string {
  if (l.tenerEnCuenta.length === 0 && l.evitar.length === 0) return '(vacia: es tu primera corrida)';
  return [
    'Tener en cuenta:',
    ...(l.tenerEnCuenta.length ? l.tenerEnCuenta.map((i) => `- ${i}`) : ['- (nada)']),
    'No va / evitar:',
    ...(l.evitar.length ? l.evitar.map((i) => `- ${i}`) : ['- (nada)']),
  ].join('\n');
}
