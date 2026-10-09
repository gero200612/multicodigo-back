import { z } from 'zod';
import { horarioEnCastellano } from './agenda.js';
import { promptDePliego } from './prompts.js';
import { rubroPorId } from './rubros.js';
import type { Demo } from './store.js';
import type { Boton, DepsDeVentas } from './ventas.js';

/**
 * Las demos: Homero le pasa a Punchi lo que sabe de una empresa con reunion y
 * Punchi arma una corrida entera, desplegada, para mostrar en la llamada.
 *
 * El camino es siempre el mismo, se toque desde Telegram o desde la web:
 * "Armar demo" -> Claude escribe el pliego -> Gero lo revisa -> "Enviar a
 * Punchi" -> el bridge abre la corrida y la arranca sola -> Homero pregunta
 * cada tanto como va y avisa cuando esta publicada.
 */

/** Lo que Homero necesita del bridge de Punchi. */
export interface ClienteDePunchi {
  /** `reunionEl`: con eso Punchi apaga la demo del VPS a los 14 días de la reunión. */
  abrir(proyecto: string, pliego: string, reunionEl?: string): Promise<{ ok: true; corridaId: string } | { ok: false; motivo: string }>;
  estado(corridaId: string): Promise<{ estado: 'abierta' | 'cerrada'; motivoDeCierre?: string; url?: string } | undefined>;
  /** Los slots con cuenta de Claude: cada uno es una suscripción (ver finanzas.ts). */
  cuentas(): Promise<{ slot: string; cuenta?: string }[]>;
}

export interface DepsDeDemos extends DepsDeVentas {
  /** Sin esto (faltan BRIDGE_URL o el token) no hay demos. */
  punchi?: ClienteDePunchi;
}

export type Resultado = { ok: true; demo: Demo } | { ok: false; motivo: string };

/** `Estudio Pérez & Asoc.` -> `estudio-perez-asoc-demo` */
export function proyectoDeDemo(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'empresa'}-demo`;
}

export const botonesDePliego = (id: number): Boton[] => [
  { texto: '🚀 Enviar a Punchi', datos: `dp:${id}` },
  { texto: '🗑 Cancelar', datos: `dc:${id}` },
];

/** Pide el pliego para la demo de una reunion. Si ya hubo una que fallo, la rehace. */
export async function armarDemo(reunionId: number, deps: DepsDeDemos): Promise<Resultado> {
  if (!deps.punchi) return { ok: false, motivo: 'las demos no están configuradas (falta BRIDGE_URL)' };
  const reunion = await deps.store.reunion(reunionId);
  if (!reunion) return { ok: false, motivo: 'esa reunión no existe o se canceló' };
  const lead = await deps.store.lead(reunion.leadId);
  if (!lead) return { ok: false, motivo: 'no encuentro la empresa de esa reunión' };

  let id = await deps.store.crearDemo({ reunionId, leadId: lead.id, proyecto: proyectoDeDemo(lead.nombre) });
  if (!id) {
    const previa = (await deps.store.demoDeReunion(reunionId))!;
    if (previa.estado !== 'fallida') return { ok: false, motivo: `ya hay una demo para esa reunión (${previa.estado})` };
    id = previa.id;
    await deps.store.actualizarDemo(id, { estado: 'redactando', error: '' });
  }
  await deps.store.encolar({ tipo: 'pliego_demo', payload: { demoId: id }, requiereIa: true });
  return { ok: true, demo: (await deps.store.demo(id))! };
}

/** La tarea `pliego_demo`: Claude escribe el pliego y se lo pasa a Gero. */
export async function redactarPliego(payload: unknown, deps: DepsDeDemos): Promise<void> {
  const { demoId } = z.object({ demoId: z.number() }).parse(payload);
  const demo = await deps.store.demo(demoId);
  if (!demo || demo.estado !== 'redactando') return;
  const lead = await deps.store.lead(demo.leadId);
  const reunion = await deps.store.reunion(demo.reunionId);
  if (!lead || !reunion) {
    await deps.store.actualizarDemo(demoId, { estado: 'fallida', error: 'la reunión se canceló' });
    return;
  }
  const hilo = (await deps.store.salientesDeLead(lead.id))
    .filter((s) => s.estado === 'enviado')
    .map((s) => ({ de: 'nosotros' as const, texto: s.cuerpo }));
  const pliego = (
    await deps.pedirIa(promptDePliego({ lead, rubro: rubroPorId(lead.rubro), cuando: reunion.inicio, hilo }))
  ).trim();
  if (pliego.length < 20) throw new Error('la IA no devolvio un pliego');
  await deps.store.actualizarDemo(demoId, { pliego, estado: 'pliego' });

  const msg = await deps.proponer(
    [
      `🧪 PLIEGO DE DEMO: ${lead.nombre} (reunión ${horarioEnCastellano(reunion.inicio)})`,
      `Proyecto en Punchi: ${demo.proyecto}`,
      '',
      pliego,
      '',
      'Para cambiarlo, respondé a este mensaje con el pliego nuevo (o editalo en punchi.dev).',
    ].join('\n'),
    botonesDePliego(demoId),
  );
  if (msg) await deps.store.actualizarDemo(demoId, { telegramMsg: msg });
}

export async function editarPliego(demoId: number, pliego: string, deps: Pick<DepsDeDemos, 'store'>): Promise<Resultado> {
  const demo = await deps.store.demo(demoId);
  if (!demo || (demo.estado !== 'pliego' && demo.estado !== 'fallida')) {
    return { ok: false, motivo: 'ese pliego ya no se puede cambiar' };
  }
  if (pliego.trim().length < 20) return { ok: false, motivo: 'el pliego es demasiado corto' };
  await deps.store.actualizarDemo(demoId, { pliego: pliego.trim(), estado: 'pliego' });
  return { ok: true, demo: (await deps.store.demo(demoId))! };
}

/** Le pasa el pliego a Punchi. Si no puede (ocupado, nombre tomado) queda para reintentar. */
export async function enviarDemo(demoId: number, deps: DepsDeDemos): Promise<Resultado> {
  if (!deps.punchi) return { ok: false, motivo: 'las demos no están configuradas (falta BRIDGE_URL)' };
  const demo = await deps.store.demo(demoId);
  if (!demo?.pliego || demo.estado !== 'pliego') return { ok: false, motivo: 'esa demo no está esperando para enviarse' };
  const reunion = await deps.store.reunion(demo.reunionId).catch(() => undefined);
  const r = await deps.punchi.abrir(demo.proyecto, demo.pliego, reunion ? new Date(reunion.inicio).toISOString() : undefined);
  if (!r.ok) {
    await deps.store.actualizarDemo(demoId, { error: r.motivo });
    return { ok: false, motivo: r.motivo };
  }
  await deps.store.actualizarDemo(demoId, { estado: 'enviada', corridaId: r.corridaId, error: '' });
  return { ok: true, demo: (await deps.store.demo(demoId))! };
}

export async function cancelarDemo(demoId: number, deps: Pick<DepsDeDemos, 'store'>): Promise<Resultado> {
  const demo = await deps.store.demo(demoId);
  if (!demo || (demo.estado !== 'pliego' && demo.estado !== 'redactando')) {
    return { ok: false, motivo: 'esa demo ya no se puede cancelar' };
  }
  await deps.store.actualizarDemo(demoId, { estado: 'fallida', error: 'cancelada' });
  return { ok: true, demo: (await deps.store.demo(demoId))! };
}

/**
 * Pregunta como van las demos que Punchi esta construyendo. Se llama cada
 * pocos minutos; avisa una sola vez, al pasar a lista o a fallida.
 */
export async function seguirDemos(deps: DepsDeDemos): Promise<void> {
  if (!deps.punchi) return;
  for (const d of await deps.store.demosEnviadas()) {
    const e = await deps.punchi.estado(d.corridaId!).catch(() => undefined);
    if (!e || e.estado === 'abierta') continue;
    const lead = await deps.store.lead(d.leadId);
    const reunion = await deps.store.reunion(d.reunionId);
    const cuando = reunion ? ` Reunión: ${horarioEnCastellano(reunion.inicio)}.` : '';
    if (e.url) {
      await deps.store.actualizarDemo(d.id, { estado: 'lista', url: e.url });
      await deps.avisar(`✅ La demo para ${lead?.nombre ?? d.proyecto} está publicada: ${e.url}${cuando}`);
    } else {
      const error = `la corrida cerró (${e.motivoDeCierre ?? 'sin motivo'}) sin publicar la app`;
      await deps.store.actualizarDemo(d.id, { estado: 'fallida', error });
      await deps.avisar(`❌ La demo para ${lead?.nombre ?? d.proyecto} no quedó publicada: ${error}. Mirá el informe en Punchi.${cuando}`);
    }
  }
}

/** El cliente HTTP del bridge, con su token. */
export function clienteDePunchi(o: { url: string; token: string; chatId: number }): ClienteDePunchi {
  const base = o.url.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${o.token}` };
  return {
    async abrir(proyecto, pliego, reunionEl) {
      const r = await fetch(`${base}/interno/corrida/desde-homero`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: o.chatId, proyecto, pliego, ...(reunionEl ? { reunionEl } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const cuerpo = (await r.json().catch(() => ({}))) as { corridaId?: string; message?: string };
      if (r.ok && cuerpo.corridaId) return { ok: true, corridaId: cuerpo.corridaId };
      return { ok: false, motivo: cuerpo.message ?? `Punchi contestó ${r.status}` };
    },
    async estado(corridaId) {
      const r = await fetch(`${base}/interno/corrida/${encodeURIComponent(corridaId)}/estado?chatId=${o.chatId}`, {
        headers: auth,
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return undefined;
      return (await r.json()) as { estado: 'abierta' | 'cerrada'; motivoDeCierre?: string; url?: string };
    },
    async cuentas() {
      const r = await fetch(`${base}/interno/finanzas/cuentas`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`Punchi contestó ${r.status} a las cuentas`);
      return ((await r.json()) as { cuentas?: { slot: string; cuenta?: string }[] }).cuentas ?? [];
    },
  };
}
