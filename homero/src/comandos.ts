import { PAUSA_IA, PAUSA_MANUAL } from './cola.js';
import type { DepsDeDemos } from './demos.js';
import { cupoDelDia } from './envio.js';
import { inicioDelDia } from './horas.js';
import { CIUDADES, rubroPorId, zonaPorNombre } from './rubros.js';
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
  // Todo en paralelo: son una docena de consultas a la base, y en serie cada
  // ida y vuelta se sumaba (3 a 5 s por /estado desde el panel).
  const casillas = Promise.all(
    deps.casillas.map(async (c) => {
      const [pausa, hoy, primero] = await Promise.all([
        deps.store.leerEstado<{ hasta: string }>(`casilla_pausada:${c.email}`),
        deps.store.enviosDesde(c.email, inicioDelDia(ahora)),
        deps.store.primerEnvio(c.email),
      ]);
      return {
        email: c.email,
        hoy,
        cupo: cupoDelDia(primero, ahora),
        ...(pausa && new Date(pausa.hasta).getTime() > ahora.getTime() ? { frenadaHasta: pausa.hasta } : {}),
      };
    }),
  );
  const [pausaIa, ensayo, pausaManual, modo, tareas, pipeline, lugares] = await Promise.all([
    deps.store.leerEstado<{ hasta: string; motivo: string }>(PAUSA_IA),
    ensayoActivo(deps),
    deps.store.leerEstado(PAUSA_MANUAL),
    modoActual(deps.store),
    deps.store.contarTareas(),
    deps.store.pipeline(),
    lugaresHoy(deps),
  ]);
  return {
    pausaManual: Boolean(pausaManual),
    ...(pausaIa ? { pausaIa } : {}),
    ...(ensayo ? { ensayo } : {}),
    modo,
    fuente: deps.placesKey ? 'google' : 'osm',
    tareas,
    pipeline,
    lugares,
    casillas: await casillas,
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
  // Cualquier rubro: el buscador ya no depende de la lista de `rubros.ts`.
  const rubro = rubroPedido?.trim() ? (rubroPorId(rubroPedido)?.nombre ?? rubroPedido.trim()) : undefined;
  const ciudad = zonaPedida ? (zonaPorNombre(zonaPedida)?.nombre ?? zonaPedida) : undefined;
  await store.encolar({ tipo: 'agente_buscar', payload: { cantidad, rubro, zona: ciudad }, requiereIa: true });
  return {
    ok: true,
    ...(rubro ? { rubro } : {}),
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
  return store.cancelarTareas(['agente_buscar', 'agente_vender', 'prospectar', 'investigar']);
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
