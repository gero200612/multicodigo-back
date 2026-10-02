import { PAUSA_IA, PAUSA_MANUAL } from './cola.js';
import type { DepsDeDemos } from './demos.js';
import { cupoDelDia } from './envio.js';
import { inicioDelDia } from './horas.js';
import { CIUDADES, rubroPorId, RUBROS, zonaPorNombre } from './rubros.js';
import type { Store } from './store.js';
import {
  apagarEnsayo,
  ENSAYO,
  ensayoActivo,
  lugaresHoy,
  mandarMuestras,
  MODO,
  modoActual,
  reproponerBorradores,
  type Modo,
} from './ventas.js';

/**
 * Lo que se puede pedir por comando de Telegram Y desde la web. Vive aca para
 * que los dos lados hagan exactamente lo mismo: cada uno solo formatea.
 */

export interface EstadoDeHomero {
  pausaManual: boolean;
  pausaIa?: { hasta: string; motivo: string };
  /** A donde van las muestras; ausente = ensayo apagado, lo aprobado sale a clientes. */
  ensayo?: string;
  modo: Modo;
  fuente: 'google' | 'osm';
  tareas: { pendientes: number; fallidas: number };
  pipeline: { borradores: number; aprobados: number };
  lugares: { quedan: number; cupo: number; ventanaAbierta: boolean };
  casillas: { email: string; hoy: number; cupo: number; frenadaHasta?: string }[];
  demos: boolean;
}

export async function estadoDeHomero(deps: DepsDeDemos & { placesKey?: string }): Promise<EstadoDeHomero> {
  const ahora = deps.ahora();
  const casillas = [];
  for (const c of deps.casillas) {
    const pausa = await deps.store.leerEstado<{ hasta: string }>(`casilla_pausada:${c.email}`);
    casillas.push({
      email: c.email,
      hoy: await deps.store.enviosDesde(c.email, inicioDelDia(ahora)),
      cupo: cupoDelDia(await deps.store.primerEnvio(c.email), ahora),
      ...(pausa && new Date(pausa.hasta).getTime() > ahora.getTime() ? { frenadaHasta: pausa.hasta } : {}),
    });
  }
  const pausaIa = await deps.store.leerEstado<{ hasta: string; motivo: string }>(PAUSA_IA);
  const ensayo = await ensayoActivo(deps);
  return {
    pausaManual: Boolean(await deps.store.leerEstado(PAUSA_MANUAL)),
    ...(pausaIa ? { pausaIa } : {}),
    ...(ensayo ? { ensayo } : {}),
    modo: await modoActual(deps.store),
    fuente: deps.placesKey ? 'google' : 'osm',
    tareas: await deps.store.contarTareas(),
    pipeline: await deps.store.pipeline(),
    lugares: await lugaresHoy(deps),
    casillas,
    demos: Boolean(deps.punchi),
  };
}

export type Busqueda =
  | { ok: true; rubro?: string; ciudad?: string; fueraDeZona: boolean }
  | { ok: false; motivo: string };

/** Encola una busqueda. Sin rubro, elige el que mejor viene respondiendo. */
export async function pedirBusqueda(
  store: Store,
  rubroPedido?: string,
  zonaPedida?: string,
  cantidad = 3,
): Promise<Busqueda> {
  const rubro = rubroPedido ? rubroPorId(rubroPedido) : undefined;
  if (rubroPedido && !rubro) {
    return { ok: false, motivo: `No conozco ese rubro. Opciones: ${RUBROS.map((r) => r.id).join(', ')}` };
  }
  const ciudad = zonaPedida ? (zonaPorNombre(zonaPedida)?.nombre ?? zonaPedida) : undefined;
  await store.encolar({ tipo: 'prospectar', payload: { cantidad, rubro: rubro?.id, ciudad }, requiereIa: false });
  return {
    ok: true,
    ...(rubro ? { rubro: rubro.nombre } : {}),
    ...(ciudad ? { ciudad } : {}),
    fueraDeZona: Boolean(ciudad && !CIUDADES.includes(ciudad)),
  };
}

export async function ponerModo(store: Store, modo: Modo): Promise<void> {
  await store.guardarEstado(MODO, modo);
}

export async function pausar(store: Store, ahora: Date): Promise<void> {
  await store.guardarEstado(PAUSA_MANUAL, { desde: ahora.toISOString() });
}

export async function seguir(store: Store): Promise<void> {
  await store.guardarEstado(PAUSA_MANUAL, null);
}

export async function cortarBusquedas(store: Store): Promise<number> {
  return store.cancelarTareas(['prospectar', 'investigar']);
}

export type CambioDeEnsayo =
  | { apagado: true; liberados: number; repropuestos: number }
  | { apagado: false; a?: string; muestras: number };

/**
 * `off` lo apaga y vuelve a proponer los borradores con Aprobar. Un mail lo
 * prende hacia ahi. Sin nada, lo prende hacia el ultimo mail (o el de Gero).
 */
export async function cambiarEnsayo(deps: DepsDeDemos, pedido: 'off' | string | undefined): Promise<CambioDeEnsayo> {
  if (pedido === 'off') {
    const liberados = await apagarEnsayo(deps);
    const repropuestos = await reproponerBorradores(deps);
    return { apagado: true, liberados, repropuestos };
  }
  if (pedido) await deps.store.guardarEstado(ENSAYO, { a: pedido.toLowerCase() });
  else if ((await deps.store.leerEstado<{ apagado?: boolean }>(ENSAYO))?.apagado) await deps.store.guardarEstado(ENSAYO, null);
  const a = await ensayoActivo(deps);
  if (!a) return { apagado: false, muestras: 0 };
  return { apagado: false, a, muestras: await mandarMuestras(a, deps) };
}
