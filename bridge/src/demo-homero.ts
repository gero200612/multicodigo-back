import type { Corrida } from './corrida.js';
import { SIN_RESPUESTA } from './corrida.js';
import { escaparHtml, partirParaTelegram } from './codigo.js';
import { handleIncoming, planificarCorrida } from './pipeline.js';
import { arrancarCola, renderOutcome, textoDePlan, type BridgeDeps } from './telegram.js';

/**
 * Las demos que pide Homero: una corrida entera que arranca sola.
 *
 * Homero es otro servicio (otro bot, otra cuenta de Claude) y le pasa a Punchi
 * un pliego armado con lo que sabe de una empresa que tiene reunion. Gero ya
 * reviso ese pliego en Homero y toco "Enviar a Punchi": pedirle ademas que
 * confirme el plan aca seria el mismo OK dos veces, y la demo tiene que estar
 * lista para la reunion. Por eso el plan se arma sin preguntas
 * (`SIN_RESPUESTA`) y la cola arranca sin boton.
 *
 * Todo lo demas es el camino de siempre: el comando largo de `/corrida` arma el
 * proyecto y abre la corrida, asi que las reglas (una corrida abierta por chat,
 * nombre sano, org unica) son las mismas que escribiendo a mano.
 */

export interface PedidoDeDemo {
  chatId: number;
  proyecto: string;
  pliego: string;
}

export type ResultadoDeDemo = { ok: true; corridaId: string } | { ok: false; motivo: string };

export interface EstadoDeDemo {
  estado: 'abierta' | 'cerrada';
  motivoDeCierre?: string;
  /** La URL publicada del front, si ya se desplego. */
  url?: string;
}

/** El texto de un outcome es HTML de Telegram; a Homero le sirve plano. */
function plano(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

export async function abrirDemo(
  p: PedidoDeDemo,
  deps: BridgeDeps,
  avisar: (html: string) => Promise<void>,
): Promise<ResultadoDeDemo> {
  // Con un `/corrida` a medias en el chat, el pliego se leeria como la
  // respuesta a ese paso y abriria algo que nadie pidio.
  if (await deps.store.borradorDeChat(p.chatId)) {
    return { ok: false, motivo: 'en Punchi hay un /corrida a medias: terminalo o cancelalo con /cancelar' };
  }
  const usuarioId = await deps.store.usuarioDeChat(p.chatId);
  if (!usuarioId) return { ok: false, motivo: 'ese chat no esta vinculado a una cuenta del panel' };

  const out = await handleIncoming(
    { chatId: p.chatId, messageId: 0, text: `/corrida proyecto=${p.proyecto} publico=si\n${p.pliego}` },
    deps,
  );
  if (out.kind !== 'corrida' || !out.recienAbierta || !out.corrida) {
    if (out.kind === 'corrida' && out.yaHabia && out.corrida) {
      return { ok: false, motivo: `Punchi esta ocupado con la corrida de ${out.corrida.proyecto}` };
    }
    return { ok: false, motivo: plano(renderOutcome(out)) || 'no se pudo abrir la corrida' };
  }

  const corrida = out.corrida;
  await avisar(
    `🤝 Homero me pidio una demo: <b>${escaparHtml(corrida.proyecto)}</b>. Armo el plan y arranco solo, sin esperar tu OK.`,
  ).catch(() => undefined);

  // Sin await: planificar es un turno de minutos y la cola puede durar horas.
  // Homero se entera del avance preguntando por el estado.
  void planificarYArrancar(corrida, usuarioId, deps, avisar);
  return { ok: true, corridaId: corrida.id };
}

async function planificarYArrancar(
  corrida: Corrida,
  usuarioId: string,
  deps: BridgeDeps,
  avisar: (html: string) => Promise<void>,
): Promise<void> {
  try {
    const plan = await planificarCorrida(corrida, usuarioId, deps, SIN_RESPUESTA);
    if (!plan.ok) {
      await deps.store.cerrarCorrida(corrida.id, 'cancelada');
      const motivo = 'motivo' in plan ? plan.motivo : 'el planificador pregunto en vez de planificar';
      await avisar(`No pude armar el plan de la demo: ${escaparHtml(motivo)}. Cerre la corrida.`);
      return;
    }
    for (const parte of partirParaTelegram(textoDePlan(corrida.proyecto, plan.tareas))) await avisar(parte);
    await arrancarCola(corrida.chatId, deps, avisar);
  } catch (err) {
    console.error('[bridge] la demo de Homero se corto:', err);
    await avisar('Se me corto la demo de Homero por un error mio. Mandame /cola para ver que quedo.').catch(
      () => undefined,
    );
  }
}

/**
 * Como va una demo: si la corrida sigue abierta, y la URL del front cuando ya
 * esta publicado.
 */
export async function estadoDeDemo(
  chatId: number,
  corridaId: string,
  deps: Pick<BridgeDeps, 'store'>,
): Promise<EstadoDeDemo | undefined> {
  const usuarioId = await deps.store.usuarioDeChat(chatId);
  if (!usuarioId) return undefined;
  const corrida = (await deps.store.corridasDeUsuario(usuarioId, 30)).find((c) => c.id === corridaId);
  if (!corrida) return undefined;
  const proyecto = (await deps.store.proyectosDeUsuario(usuarioId)).find(
    (x) => x.nombre.toLowerCase() === corrida.proyecto.toLowerCase(),
  );
  const repos = proyecto ? await deps.store.reposDeProyecto(proyecto.id) : [];
  // El front es lo que se muestra en la reunion; el back solo si no hay front.
  const front = repos.find((r) => r.nombre.endsWith('-front') && r.render_url);
  const url = front?.render_url ?? repos.find((r) => r.render_url)?.render_url ?? undefined;
  return {
    estado: corrida.estado,
    ...(corrida.motivoDeCierre ? { motivoDeCierre: corrida.motivoDeCierre } : {}),
    ...(url ? { url } : {}),
  };
}
