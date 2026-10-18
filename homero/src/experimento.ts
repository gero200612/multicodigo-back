import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { diaArgentino } from './agenda.js';
import {
  cambiarPresupuesto,
  FORMULARIO_VERSION,
  GRACIAS,
  INTERESES_OBSOLETOS,
  interesesObsoletosDelError,
  mesDe,
  minimoDelError,
  MINIMO_DE_META,
  minimoDiario,
  pesos,
  PRIVACIDAD,
  PUBLICADO_EN,
  preguntasDelFormulario,
  presupuestoDelMes,
  WEB,
  type DepsDeAnuncios,
} from './anuncios.js';
import { correr, type DepsDeAgentes } from './agentes.js';
import { GuionInvalido, RenderFallido } from './estudio.js';
import {
  EXPERIMENTO,
  leerExperimento,
  type EstadoDeExperimento,
  type PiezaDeExperimento,
} from './experimento-estado.js';
import { relojArgentino } from './horas.js';
import type { Pregunta } from './meta.js';
import {
  herramientasDelReelDeEstudio,
  renderizarEnElEstudio,
  ROL_REEL_ESTUDIO,
  textoDeFallas,
} from './reels-estudio.js';
import { rutaDePortada, type DepsDeReels } from './publicar-reel.js';

/**
 * El experimento de los 5 reels (spec 2026-10-18): Homero arma 5 reels con el
 * estudio, Gero los aprueba por Telegram, y despues Homero gasta ~$80.000 en
 * ~10 dias con una sola campaña de un solo conjunto y los 5 anuncios adentro.
 *
 * Lo que se puede hacer con la plata lo decide este archivo, no el agente:
 * - nada gasta hasta que Gero manda /experimento_iniciar (la campaña se crea
 *   PAUSADA y se avisa el paso exacto); el limite de gasto de la cuenta en Meta
 *   no se toca, es de Gero;
 * - el experimento nunca gasta mas que su `total`: antes de cada dia se mira
 *   lo gastado y se baja el diario (o se corta) para no pasarse;
 * - los dias 1 a 3 corren los 5; desde el 4 se pausan los peores y el gasto
 *   se concentra en los otros;
 * - los leads se cuentan solo por action_type "lead" (meta.ts: Meta repite el
 *   mismo lead con otros cuatro nombres).
 */

export const POR_DEFECTO = {
  /** Reels publicados que hacen falta para armar la campaña. */
  cantidad: 5,
  total: 80_000,
  diario: 8_000,
  /** Dias en que corren todos antes de juzgar. */
  diasParaJuzgar: 3,
  /** Con menos leads que esto entre todos no se juzga por costo por lead. */
  leadsParaJuzgarPorCosto: 3,
  /** Los anuncios que se dejan andando como minimo. */
  minimoQueSigue: 2,
  /** Un anuncio sin impresiones suficientes no se puede comparar por CTR. */
  impresionesParaComparar: 300,
  /** Meta puede gastar hasta un 25% mas que el diario en un dia. */
  margenDeMeta: 1.25,
};

/** Un dolor distinto por reel: cada uno es un experimento (que gancho frena el scroll). */
export const ANGULOS = [
  'las facturas y comprobantes que se cargan a mano (llegan por WhatsApp o por mail)',
  'las cobranzas: clientes que deben y nadie les recuerda el pago',
  'los pedidos que entran por WhatsApp y se copian a mano',
  'el stock que se termina sin avisar',
  'los turnos y reservas que se pierden o se cruzan',
  'los reportes del negocio que se arman a mano en planillas',
];

/** Cuantas veces se rehace un reel que el estudio no pudo armar o no paso su revision tecnica. */
export const INTENTOS_POR_REEL = 2;

export type DepsDeExperimento = DepsDeReels;

// ------------------------------------------------------------ guardar y leer

async function guardar(e: EstadoDeExperimento, deps: Pick<DepsDeAnuncios, 'store'>): Promise<void> {
  await deps.store.guardarEstado(EXPERIMENTO, e);
}

/** Avisa una sola vez por motivo mientras dure el experimento. */
async function avisarUnaVez(e: EstadoDeExperimento, motivo: string, texto: string, deps: Pick<DepsDeAnuncios, 'store' | 'avisar'>): Promise<void> {
  if (e.avisado?.includes(motivo)) return;
  e.avisado = [...(e.avisado ?? []), motivo];
  await guardar(e, deps);
  await deps.avisar(texto);
}

const POR_ESTILO = (n: number) => ANGULOS[(n - 1) % ANGULOS.length]!;

// ------------------------------------------------------------ 1. los reels

/** /experimento [total] [diario]: arranca la tanda de reels. No gasta nada. */
export async function iniciarReels(
  o: { total?: number; diario?: number },
  deps: DepsDeExperimento,
): Promise<{ ok: true; estado: EstadoDeExperimento } | { ok: false; motivo: string }> {
  if (!deps.estudio) return { ok: false, motivo: 'el estudio no está configurado (falta ESTUDIO_URL en mc.env)' };
  if (!deps.meta) return { ok: false, motivo: 'Meta no está configurado (falta META_TOKEN)' };
  const actual = await leerExperimento(deps.store);
  if (actual && actual.fase !== 'terminado' && actual.fase !== 'cancelado') {
    return { ok: false, motivo: `ya hay un experimento (${actual.fase}): /experimento_estado, o /experimento_cancelar para empezar de cero` };
  }
  const total = o.total ?? POR_DEFECTO.total;
  const diario = o.diario ?? POR_DEFECTO.diario;
  if (diario > total) return { ok: false, motivo: `el diario ($${diario}) no puede ser mayor que el total ($${total})` };
  const estado: EstadoDeExperimento = {
    fase: 'reels',
    creadoEn: deps.ahora().toISOString(),
    total,
    diario,
    cantidad: POR_DEFECTO.cantidad,
    reelIds: [],
    hechos: [],
    musicas: [],
    piezas: [],
    pedidos: 0,
  };
  for (let n = 1; n <= POR_DEFECTO.cantidad; n++) await encolarAgente(estado, n, 1, undefined, deps);
  await guardar(estado, deps);
  return { ok: true, estado };
}

/** /experimento_reel: otro reel para la tanda (uno se descarto o salio mal). */
export async function sumarReel(deps: DepsDeExperimento): Promise<{ ok: true; n: number } | { ok: false; motivo: string }> {
  const e = await leerExperimento(deps.store);
  if (e?.fase !== 'reels') return { ok: false, motivo: 'solo se suman reels mientras se arma el experimento (antes de /experimento_iniciar)' };
  const n = e.pedidos + 1;
  await encolarAgente(e, n, 1, undefined, deps);
  // El aviso de "faltan reels" puede volver a darse con la nueva cuenta.
  e.avisado = (e.avisado ?? []).filter((m) => !m.startsWith('faltan:'));
  await guardar(e, deps);
  return { ok: true, n };
}

/** Encola al agente que escribe el reel `n`. Un primer intento cuenta como pedido nuevo. */
async function encolarAgente(e: EstadoDeExperimento, n: number, intento: number, feedback: string | undefined, deps: DepsDeExperimento): Promise<void> {
  if (intento === 1) e.pedidos = Math.max(e.pedidos, n);
  const payload: PayloadDeAgenteDeReel = { n, angulo: POR_ESTILO(n), intento, ...(feedback ? { feedback } : {}) };
  await deps.store.encolar({
    tipo: 'agente_reel_estudio',
    payload,
    requiereIa: true,
    clave: `experimento:${e.creadoEn}:agente:${n}:${intento}`,
  });
}

export const PayloadDeAgenteDeReel = z.object({
  n: z.number().int().min(1),
  /** El dolor de este reel. */
  angulo: z.string().min(2),
  intento: z.number().int().min(1).default(1),
  /** Por que fallo el intento anterior (el estudio o su revision tecnica). */
  feedback: z.string().optional(),
});
export type PayloadDeAgenteDeReel = z.input<typeof PayloadDeAgenteDeReel>;

export const PayloadDeRender = z.object({
  n: z.number().int().min(1),
  angulo: z.string(),
  intento: z.number().int().min(1),
  guion: z.record(z.string(), z.unknown()),
  musica: z.object({ id: z.string(), titulo: z.string() }),
  porQue: z.string().optional(),
  /** Estilo y gancho del reel, para que el siguiente sea distinto. */
  resumen: z.string(),
});
export type PayloadDeRender = z.infer<typeof PayloadDeRender>;

/** El agente escribe el guion de un reel y deja encolado el render. */
export async function agenteReelDeEstudio(payload: unknown, deps: DepsDeAgentes): Promise<void> {
  const p = PayloadDeAgenteDeReel.parse(payload);
  const e = await leerExperimento(deps.store);
  if (e?.fase !== 'reels') return;
  const intento = p.intento ?? 1;
  const objetivo = [
    `Objetivo: escribí el reel ${p.n} del experimento de Sincro. Su dolor: ${p.angulo}.`,
    e.hechos.length ? `Los reels que ya hay (no repitas gancho ni estilo):\n${e.hechos.map((h) => `- ${h}`).join('\n')}` : '',
    p.feedback ? `El intento anterior no salió bien (vuelta ${intento} de ${INTENTOS_POR_REEL}). Corregí esto:\n${p.feedback}` : '',
    'Empezá con ver_bloques, mirá cuadros con ver_cuadro y terminá con crear_reel.',
  ]
    .filter(Boolean)
    .join('\n\n');
  await correr(
    'publicista',
    objetivo,
    (reg) =>
      herramientasDelReelDeEstudio(deps, {
        n: p.n,
        registro: reg,
        recientes: e.musicas,
        async encolar({ guion, musica, porQue, resumen }) {
          const render: PayloadDeRender = { n: p.n, angulo: p.angulo, intento, guion, musica: { id: musica.id, titulo: musica.titulo }, ...(porQue ? { porQue } : {}), resumen };
          await deps.store.encolar({
            tipo: 'renderizar_reel',
            payload: render,
            requiereIa: false,
            clave: `experimento:${e.creadoEn}:render:${p.n}:${intento}`,
          });
        },
      }),
    { web: false, debeCerrar: true, rol: ROL_REEL_ESTUDIO, topes: { maxTurnos: 24, maxMinutos: 12 } },
    deps,
  );
}

/** El estudio no pudo con el reel: una vuelta mas del agente con lo que dijo, o se le avisa a Gero. */
async function rehacer(p: PayloadDeRender, motivo: string, e: EstadoDeExperimento, deps: DepsDeExperimento): Promise<void> {
  if (p.intento < INTENTOS_POR_REEL) {
    await encolarAgente(e, p.n, p.intento + 1, motivo, deps);
    return;
  }
  await deps.avisar(
    `⚠️ No pude armar el reel ${p.n} del experimento después de ${INTENTOS_POR_REEL} intentos: ${motivo.slice(0, 400)}\n` +
      'Si querés otro en su lugar: /experimento_reel',
  );
}

/** Renderiza el guion en el estudio (sin IA) y deja el reel en el flujo de siempre: el publicista escribe el texto y Gero aprueba. */
export async function renderizarReel(payload: unknown, deps: DepsDeExperimento): Promise<void> {
  const p = PayloadDeRender.parse(payload);
  const e = await leerExperimento(deps.store);
  if (e?.fase !== 'reels') return;
  const estudio = deps.estudio;
  if (!estudio) throw new Error('el estudio no está configurado (falta ESTUDIO_URL)');
  // Caido: la cola reintenta (1, 2, 4, 8 minutos) y a los 5 intentos le avisa a Gero.
  if (!(await estudio.salud())) throw new Error('el estudio no contesta');
  let r;
  try {
    r = await renderizarEnElEstudio(p.guion, `homero-${e.creadoEn}-${p.n}-${p.intento}`, deps);
  } catch (err) {
    if (err instanceof RenderFallido || err instanceof GuionInvalido) return rehacer(p, err.message, e, deps);
    throw err;
  }
  if (r.revision && !r.revision.ok) {
    await rm(r.archivo, { force: true });
    return rehacer(p, `La revisión técnica del estudio encontró fallas:\n${textoDeFallas(r.revision.fallas)}`, e, deps);
  }
  const id = await deps.store.crearReel({ origen: 'homero', archivo: r.archivo, duracion: r.duracion, peso: r.peso });
  await deps.store.encolar({ tipo: 'agente_reel', payload: { reelId: id }, requiereIa: true, clave: `reel:escribir:${id}:0` });
  const ahora = (await leerExperimento(deps.store)) ?? e;
  ahora.reelIds = [...ahora.reelIds, id];
  ahora.hechos = [...ahora.hechos, `Reel ${p.n} (#${id}): ${p.resumen}`];
  ahora.musicas = [...ahora.musicas, p.musica.id];
  await guardar(ahora, deps);
  await deps.avisar(`🎬 Armé el reel ${p.n} del experimento (#${id}, ${Math.round(r.duracion)} s, música: ${p.musica.titulo}). Ahora el publicista le escribe el texto y te llega para aprobar.`);
}

// ------------------------------------------------------------ 2. la campaña (pausada)

async function intereses(deps: DepsDeExperimento): Promise<{ id: string; name: string }[]> {
  const obsoletos = new Set((await deps.store.leerEstado<string[]>(INTERESES_OBSOLETOS)) ?? []);
  try {
    return (await deps.meta!.buscarIntereses('Pequeña y mediana empresa')).filter((i) => !obsoletos.has(i.id)).slice(0, 1);
  } catch {
    // Sin intereses el conjunto sale igual, a toda Argentina de 25 a 65.
    return [];
  }
}

/** El primer renglon del caption sin hashtags, para nombrar el anuncio. */
function tituloDelCaption(caption: string): string {
  const linea = (caption.split('\n').find((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').trim()) ?? 'Reel de Sincro').replace(/#[\p{L}\p{N}_]+/gu, '').trim();
  return linea.length > 40 ? `${linea.slice(0, 39).trimEnd()}…` : linea;
}

/** Los reels que van: los primeros publicados (en orden de publicacion), hasta `cantidad`. */
async function reelsParaLaCampana(e: EstadoDeExperimento, deps: DepsDeExperimento) {
  const reels = [];
  for (const id of e.reelIds) {
    const r = await deps.store.reel(id);
    if (r?.estado === 'publicado' && r.igMedia) reels.push(r);
  }
  return reels.sort((a, b) => (a.publicadoEn?.getTime() ?? 0) - (b.publicadoEn?.getTime() ?? 0));
}

/**
 * Cuando estan publicados los 5, crea TODO en Meta pero en PAUSA: una
 * campaña, un conjunto con el diario compartido y un anuncio por reel (con su
 * formulario, para saber de cual vino cada consulta). Cada pieza se anota apenas
 * existe: si Meta falla a mitad, la proxima vuelta sigue desde ahi.
 */
export async function armarCampana(deps: DepsDeExperimento): Promise<void> {
  const e = await leerExperimento(deps.store);
  if (e?.fase !== 'reels' || !deps.meta) return;
  const meta = deps.meta;
  const reels = await reelsParaLaCampana(e, deps);
  if (reels.length < e.cantidad) {
    const pendientes = (await Promise.all(e.reelIds.map((id) => deps.store.reel(id)))).filter((r) => r && r.estado !== 'publicado' && r.estado !== 'descartado').length;
    if (reels.length + pendientes < e.cantidad) {
      await avisarUnaVez(
        e,
        `faltan:${reels.length}:${pendientes}`,
        `📌 Para el experimento hacen falta ${e.cantidad} reels publicados y hay ${reels.length} publicados + ${pendientes} esperando tu OK. Pedí otro con /experimento_reel.`,
        deps,
      );
    }
    return;
  }
  const elegidos = reels.slice(0, e.cantidad);

  // Meta tiene que dejar promocionarlos (por ejemplo, no con musica con derechos).
  const noSirven: string[] = [];
  for (const r of elegidos) {
    const ok = await meta.promocionable(r.igMedia!);
    if (!ok.ok) noSirven.push(`#${r.id}: ${ok.motivo}`);
  }
  if (noSirven.length) {
    await avisarUnaVez(
      e,
      `no_promocionables:${noSirven.length}`,
      `⚠️ Meta no deja promocionar ${noSirven.length === 1 ? 'un reel' : `${noSirven.length} reels`} del experimento:\n${noSirven.map((n) => `• ${n}`).join('\n')}\nDescartá o reemplazá ${noSirven.length === 1 ? 'ese' : 'esos'} con /experimento_reel.`,
      deps,
    );
    return;
  }

  const minimo = await minimoDiario(deps);
  const diario = Math.max(e.diario, minimo);
  if (!e.campana) {
    e.campana = await meta.crearCampana('Sincro · experimento de reels (Homero)', { pausada: true });
    await guardar(e, deps);
  }
  if (!e.conjunto) {
    const lista = await intereses(deps);
    const crear = (i: { id: string; name: string }[]) => meta.crearConjunto({ campana: e.campana!, nombre: `Experimento · ${elegidos.length} reels`, diario, intereses: i, pausado: true });
    try {
      e.conjunto = await crear(lista);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      const aprendido = minimoDelError(mensaje);
      if (aprendido) await deps.store.guardarEstado(MINIMO_DE_META, aprendido);
      const rechazados = interesesObsoletosDelError(mensaje);
      if (rechazados.length === 0) throw err;
      const obsoletos = new Set((await deps.store.leerEstado<string[]>(INTERESES_OBSOLETOS)) ?? []);
      await deps.store.guardarEstado(INTERESES_OBSOLETOS, [...new Set([...obsoletos, ...rechazados])]);
      e.conjunto = await crear(lista.filter((i) => !rechazados.includes(i.id)));
    }
    e.diario = diario;
    await guardar(e, deps);
  }

  const reparto = Math.round(diario / elegidos.length);
  for (const r of elegidos) {
    let pieza = e.piezas.find((x) => x.reelId === r.id);
    if (!pieza) {
      pieza = { reelId: r.id, activo: true };
      e.piezas.push(pieza);
    }
    const titulo = tituloDelCaption(r.caption);
    if (pieza.anuncioId === undefined) {
      const imagen = await readFile(rutaDePortada(r.id, deps)).catch(() => Buffer.alloc(0));
      pieza.anuncioId = await deps.store.crearAnuncio({
        rubro: 'experimento',
        titulo,
        texto: r.caption,
        frase: titulo,
        preguntas: [],
        porQue: r.porQue || `Reel #${r.id} del experimento de reels.`,
        diario: reparto,
        imagen,
        reelId: r.id,
      });
      // `pausado`: lee sus consultas (leerLeadsDeMeta mira los aprobados, activos y pausados) pero no cuenta como gasto del mes hasta arrancar.
      await deps.store.actualizarAnuncio(pieza.anuncioId, { estado: 'pausado', motivo: 'experimento de reels: esperando que Gero lo arranque', aprobadoEn: deps.ahora() });
      await guardar(e, deps);
    }
    if (!pieza.formulario) {
      const preguntas: Pregunta[] = preguntasDelFormulario([]);
      pieza.formulario = await meta.crearFormulario({ nombre: `Sincro · experimento · reel #${r.id}`, preguntas, privacidad: PRIVACIDAD, web: WEB, gracias: GRACIAS });
      await guardar(e, deps);
    }
    if (!pieza.creativo) {
      pieza.creativo = await meta.crearCreativoDeReel({ nombre: `experimento · reel #${r.id}`, media: r.igMedia!, formulario: pieza.formulario, web: WEB });
      await guardar(e, deps);
    }
    if (!pieza.anuncio) {
      pieza.anuncio = await meta.crearAnuncio({ nombre: `experimento · reel #${r.id} · ${titulo}`, conjunto: e.conjunto, creativo: pieza.creativo, pausado: true });
      await guardar(e, deps);
    }
    await deps.store.actualizarAnuncio(pieza.anuncioId, {
      metaIds: { formulario: pieza.formulario, formularioVersion: FORMULARIO_VERSION, conjunto: e.conjunto, creativo: pieza.creativo, anuncio: pieza.anuncio },
    });
  }
  e.fase = 'listo';
  await guardar(e, deps);
  await deps.avisar(textoListoParaArrancar(e, minimo));
}

export function textoListoParaArrancar(e: EstadoDeExperimento, minimoDiarioDeMeta: number): string {
  const dias = Math.ceil(e.total / e.diario);
  return [
    `✅ El experimento está LISTO PARA ARRANCAR: ${e.piezas.length} reels publicados y la campaña creada en Meta, en PAUSA. No gasté nada.`,
    '',
    `Plan: ${pesos(e.total)} en unos ${dias} días, ${pesos(e.diario)} por día compartidos entre los ${e.piezas.length} anuncios (Meta pide al menos ${pesos(minimoDiarioDeMeta)}). Los días 1 a 3 corren todos; desde el 4 pauso los peores por costo por consulta y concentro el gasto. Nunca paso de ${pesos(e.total)}.`,
    '',
    'Para arrancar:',
    '1. Cargá plata en Meta y subí el límite de gasto de la cuenta (yo no lo toco): https://business.facebook.com/billing_hub/payment_settings',
    `2. Mandame /experimento_iniciar. Reviso que el límite alcance para ${pesos(e.total)} y prendo todo.`,
    '',
    'Si no querés seguir: /experimento_cancelar.',
  ].join('\n');
}

// ------------------------------------------------------------ 3. arrancar

export type Resultado = { ok: true; texto: string } | { ok: false; motivo: string };

/** /experimento_iniciar: prende la campaña. Solo si el limite de la cuenta alcanza para el total. */
export async function iniciarExperimento(deps: DepsDeExperimento): Promise<Resultado> {
  const e = await leerExperimento(deps.store);
  if (!e) return { ok: false, motivo: 'no hay ningún experimento: arrancalo con /experimento' };
  if (e.fase === 'corriendo') return { ok: false, motivo: 'ya está corriendo: /experimento_estado' };
  if (e.fase !== 'listo' || !deps.meta || !e.campana || !e.conjunto) {
    return { ok: false, motivo: e.fase === 'reels' ? 'todavía faltan reels publicados: /experimento_estado' : `no se puede arrancar desde ${e.fase}` };
  }
  const cuenta = await deps.meta.cuenta();
  if (cuenta.limite > 0) {
    const queda = cuenta.limite - cuenta.gastado;
    if (queda < e.total) {
      return {
        ok: false,
        motivo:
          `el límite de gasto de la cuenta en Meta es ${pesos(cuenta.limite)} y ya se gastó ${pesos(cuenta.gastado)}: quedan ${pesos(queda)} y el experimento necesita ${pesos(e.total)}. ` +
          'Subí el límite (y cargá plata) en https://business.facebook.com/billing_hub/payment_settings y mandá /experimento_iniciar de nuevo. No lo toco yo.',
      };
    }
  }
  // El presupuesto del mes de Homero tiene que dejar pasar el experimento: si no, el control de siempre lo pausaria.
  const mes = mesDe(deps.ahora());
  const gastadoDelMes = (await deps.store.gastos(mes.primerDia)).reduce((n, g) => n + g.gasto, 0);
  const antes = await presupuestoDelMes(deps.store);
  const necesita = Math.ceil(gastadoDelMes + e.total);
  let aviso = '';
  if (antes < necesita) {
    await cambiarPresupuesto(necesita, deps);
    aviso = `\nEl presupuesto del mes de Homero lo subí de ${pesos(antes)} a ${pesos(necesita)} para que el control de siempre no corte el experimento; después bajalo con /presupuesto si querés.`;
  }
  const meta = deps.meta;
  for (const p of e.piezas) if (p.anuncio) await meta.cambiarEstado(p.anuncio, 'ACTIVE');
  await meta.cambiarEstado(e.conjunto, 'ACTIVE');
  await meta.cambiarEstado(e.campana, 'ACTIVE');
  const ahora = deps.ahora();
  for (const p of e.piezas) {
    if (p.anuncioId === undefined) continue;
    p.activo = true;
    await deps.store.actualizarAnuncio(p.anuncioId, { estado: 'activo', motivo: 'experimento de reels: corriendo' });
    await deps.store.guardarEstado(PUBLICADO_EN(p.anuncioId), ahora.toISOString());
  }
  e.fase = 'corriendo';
  e.inicio = ahora.toISOString();
  await guardar(e, deps);
  const texto =
    `▶️ Arrancó el experimento: ${pesos(e.diario)} por día entre ${e.piezas.length} anuncios, tope ${pesos(e.total)}. Meta revisa los anuncios antes de mostrarlos. ` +
    `Te mando un resumen cada noche y un aviso cada vez que pause algo.${aviso}`;
  await deps.avisar(texto);
  return { ok: true, texto };
}

// ------------------------------------------------------------ 4. el control

export interface MedidaDePieza {
  /** El anuncio en Meta. */
  anuncio: string;
  gasto: number;
  impresiones: number;
  clics: number;
  /** Solo action_type "lead". */
  leads: number;
}

const cpl = (m: MedidaDePieza) => (m.leads > 0 ? m.gasto / m.leads : Infinity);
const ctr = (m: MedidaDePieza) => (m.impresiones > 0 ? m.clics / m.impresiones : 0);
const cpm = (m: MedidaDePieza) => (m.impresiones > 0 ? (m.gasto / m.impresiones) * 1000 : 0);

export interface Decision {
  pausar: string[];
  criterio: 'costo por lead' | 'CTR y CPM' | 'nada';
  /** Del peor al mejor. */
  ranking: string[];
}

/**
 * Cuales se pausan al concentrar. Con leads de sobra (al menos
 * `leadsParaJuzgarPorCosto` entre todos), por costo por lead: los que no
 * trajeron ninguno son los peores, el que mas gasto sin traer es el peor de
 * ellos. Con pocos leads, por CTR (menos es peor) y, a igual CTR, por CPM
 * (mas caro es peor): lo que se puede comparar sin leads. Se pausan 3 con
 * leads de sobra y 2 sin ellos, y siempre quedan al menos
 * `minimoQueSigue` andando.
 */
export function elegirPeores(medidas: MedidaDePieza[], cfg = POR_DEFECTO): Decision {
  const leads = medidas.reduce((n, m) => n + m.leads, 0);
  const conSuficiente = leads >= cfg.leadsParaJuzgarPorCosto;
  const ordenados = [...medidas].sort((a, b) => {
    if (conSuficiente) {
      const d = cpl(b) - cpl(a);
      // Infinity - Infinity es NaN: entre los que no trajeron nada, el que mas gasto es peor.
      if (Number.isNaN(d)) return b.gasto - a.gasto;
      return d || b.gasto - a.gasto;
    }
    return ctr(a) - ctr(b) || cpm(b) - cpm(a);
  });
  const cuantos = Math.min(conSuficiente ? 3 : 2, Math.max(0, medidas.length - cfg.minimoQueSigue));
  const comparables = medidas.some((m) => m.impresiones >= cfg.impresionesParaComparar);
  if (cuantos === 0 || (!conSuficiente && !comparables)) {
    return { pausar: [], criterio: 'nada', ranking: ordenados.map((m) => m.anuncio) };
  }
  return {
    pausar: ordenados.slice(0, cuantos).map((m) => m.anuncio),
    criterio: conSuficiente ? 'costo por lead' : 'CTR y CPM',
    ranking: ordenados.map((m) => m.anuncio),
  };
}

/** Lo que Meta cuenta de cada anuncio del experimento desde que arranco. */
async function medir(e: EstadoDeExperimento, deps: DepsDeExperimento): Promise<Map<string, MedidaDePieza>> {
  const desde = diaArgentino(new Date(e.inicio!));
  const filas = await deps.meta!.insights(desde, diaArgentino(deps.ahora()));
  const porAnuncio = new Map<string, MedidaDePieza>();
  for (const p of e.piezas) if (p.anuncio) porAnuncio.set(p.anuncio, { anuncio: p.anuncio, gasto: 0, impresiones: 0, clics: 0, leads: 0 });
  for (const f of filas) {
    const m = porAnuncio.get(f.anuncio);
    if (!m) continue;
    m.gasto += f.gasto;
    m.impresiones += f.impresiones;
    m.clics += f.clics ?? 0;
    m.leads += f.consultas;
  }
  return porAnuncio;
}

/** Dias desde que arranco, contando el primero como 1. */
export function diaDelExperimento(inicio: string, ahora: Date): number {
  const [a, m, d] = diaArgentino(new Date(inicio)).split('-').map(Number) as [number, number, number];
  const [a2, m2, d2] = diaArgentino(ahora).split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a, m - 1, d)) / 86_400_000) + 1;
}

const nombreDe = (e: EstadoDeExperimento, anuncio: string) => {
  const i = e.piezas.findIndex((p) => p.anuncio === anuncio);
  return i >= 0 ? `reel #${e.piezas[i]!.reelId}` : anuncio;
};

function lineaDe(e: EstadoDeExperimento, m: MedidaDePieza, activo: boolean): string {
  const costo = m.leads > 0 ? `${pesos(cpl(m))} por lead` : 'sin leads';
  return `• ${nombreDe(e, m.anuncio)}${activo ? '' : ' (pausado)'}: ${pesos(m.gasto)}, ${m.leads} lead(s) (${costo}), CTR ${(ctr(m) * 100).toFixed(2).replace('.', ',')} %, ${m.impresiones} impresiones`;
}

export function textoDelResumen(e: EstadoDeExperimento, medidas: Map<string, MedidaDePieza>, dia: number): string {
  const gastado = [...medidas.values()].reduce((n, m) => n + m.gasto, 0);
  const leads = [...medidas.values()].reduce((n, m) => n + m.leads, 0);
  return [
    `📊 Experimento de reels, día ${dia}: ${pesos(gastado)} de ${pesos(e.total)} gastados, ${leads} lead(s)${leads > 0 ? ` (${pesos(gastado / leads)} cada uno)` : ''}.`,
    ...e.piezas.map((p) => (p.anuncio && medidas.get(p.anuncio) ? lineaDe(e, medidas.get(p.anuncio)!, p.activo) : '')).filter(Boolean),
  ].join('\n');
}

/** Corta el experimento: pausa todo y lo dice. */
export async function terminarExperimento(e: EstadoDeExperimento, motivo: string, deps: DepsDeExperimento, medidas?: Map<string, MedidaDePieza>): Promise<void> {
  const meta = deps.meta;
  if (meta && e.campana) await meta.cambiarEstado(e.campana, 'PAUSED');
  if (meta && e.conjunto) await meta.cambiarEstado(e.conjunto, 'PAUSED');
  for (const p of e.piezas) {
    if (p.anuncioId !== undefined) await deps.store.actualizarAnuncio(p.anuncioId, { estado: 'pausado', motivo: `experimento de reels: ${motivo}` });
    p.activo = false;
  }
  e.fase = 'terminado';
  e.fin = { cuando: deps.ahora().toISOString(), motivo };
  await guardar(e, deps);
  const dia = e.inicio ? diaDelExperimento(e.inicio, deps.ahora()) : 0;
  await deps.avisar(
    [
      `🏁 Terminó el experimento de reels: ${motivo}.`,
      medidas ? textoDelResumen(e, medidas, dia) : '',
      'Dejé todo en pausa. El presupuesto del mes de Homero sigue como lo dejé para el experimento: bajalo con /presupuesto si querés. ' +
        'Con los números en la mano, el próximo paso (más plata para el mejor, otros reels) lo decidís vos.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

/** Cada hora mientras corre: tope, concentracion en los mejores y resumen de la noche. */
export async function controlarExperimento(deps: DepsDeExperimento): Promise<void> {
  const e = await leerExperimento(deps.store);
  if (e?.fase !== 'corriendo' || !deps.meta || !e.inicio || !e.conjunto) return;
  const meta = deps.meta;
  const ahora = deps.ahora();
  const hoy = diaArgentino(ahora);
  const dia = diaDelExperimento(e.inicio, ahora);
  const medidas = await medir(e, deps);
  const gastado = [...medidas.values()].reduce((n, m) => n + m.gasto, 0);
  e.gastado = gastado;
  const restante = e.total - gastado;
  const minimo = await minimoDiario(deps);

  // 1. El tope: Meta puede pasarse hasta un 25% del diario en un dia, asi que antes
  // de que el diario no entre en lo que queda se baja (o se corta).
  const diarioMaximo = Math.floor(restante / POR_DEFECTO.margenDeMeta);
  if (restante <= 0 || diarioMaximo < minimo) {
    return terminarExperimento(e, `se gastó el total (${pesos(gastado)} de ${pesos(e.total)})`, deps, medidas);
  }
  if (e.diario > diarioMaximo) {
    await meta.cambiarDiario(e.conjunto, diarioMaximo);
    await deps.avisar(`💸 Bajé el diario del experimento de ${pesos(e.diario)} a ${pesos(diarioMaximo)}: quedan ${pesos(restante)} y no quiero pasarme de ${pesos(e.total)}.`);
    e.diario = diarioMaximo;
    await redistribuirDiarios(e, deps);
  }
  const maxDias = Math.ceil(e.total / POR_DEFECTO.diario) + 3;
  if (dia > maxDias) {
    return terminarExperimento(e, `pasaron ${maxDias} días (gastó ${pesos(gastado)} de ${pesos(e.total)})`, deps, medidas);
  }

  // 2. Desde el dia 4, los peores se pausan y el gasto queda en los otros.
  if (dia > POR_DEFECTO.diasParaJuzgar && !e.concentradoEn) {
    const activos = e.piezas.filter((p) => p.activo && p.anuncio);
    const decision = elegirPeores(activos.map((p) => medidas.get(p.anuncio!)!));
    if (decision.pausar.length === 0) {
      await avisarUnaVez(e, 'sin_datos', `ℹ️ Día ${dia} del experimento: todavía no hay impresiones para comparar los reels, sigo con todos y miro de nuevo en una hora.`, deps);
    } else {
      for (const anuncio of decision.pausar) {
        const p = e.piezas.find((x) => x.anuncio === anuncio)!;
        await meta.cambiarEstado(anuncio, 'PAUSED');
        p.activo = false;
        if (p.anuncioId !== undefined) {
          await deps.store.actualizarAnuncio(p.anuncioId, { estado: 'pausado', motivo: `experimento de reels: de los peores por ${decision.criterio}` });
        }
      }
      e.concentradoEn = hoy;
      await redistribuirDiarios(e, deps);
      const sigue = e.piezas.filter((p) => p.activo);
      await guardar(e, deps);
      await deps.avisar(
        [
          `✂️ Día ${dia}: pausé ${decision.pausar.length} reel(s) por ${decision.criterio}: ${decision.pausar.map((a) => nombreDe(e, a)).join(', ')}.`,
          `Sigo con ${sigue.map((p) => `reel #${p.reelId}`).join(' y ')}, con los mismos ${pesos(e.diario)} por día concentrados.`,
          textoDelResumen(e, medidas, dia),
        ].join('\n\n'),
      );
    }
  }

  // 3. El resumen de la noche.
  if (relojArgentino(ahora).hora >= 20 && e.resumenDe !== hoy) {
    e.resumenDe = hoy;
    await guardar(e, deps);
    await deps.avisar(textoDelResumen(e, medidas, dia));
    return;
  }
  await guardar(e, deps);
}

/** El diario compartido se reparte entre los anuncios que siguen: asi la suma de los diarios que cuenta el control del mes es la de Meta. */
async function redistribuirDiarios(e: EstadoDeExperimento, deps: DepsDeExperimento): Promise<void> {
  const activos = e.piezas.filter((p) => p.activo);
  for (const p of activos) {
    if (p.anuncioId !== undefined) await deps.store.actualizarAnuncio(p.anuncioId, { diario: Math.round(e.diario / activos.length) });
  }
  for (const p of e.piezas.filter((x) => !x.activo)) {
    if (p.anuncioId !== undefined) await deps.store.actualizarAnuncio(p.anuncioId, { diario: 0 });
  }
}

// ------------------------------------------------------------ el paso (cada hora y al publicar un reel)

/** La tarea `experimento_paso`: lo que toque segun la fase. No hace nada sin experimento. */
export async function pasoDelExperimento(deps: DepsDeExperimento): Promise<void> {
  const e = await leerExperimento(deps.store);
  if (!e) return;
  if (e.fase === 'reels') await armarCampana(deps);
  else if (e.fase === 'corriendo') await controlarExperimento(deps);
}

// ------------------------------------------------------------ estado y cancelar

export async function estadoDelExperimento(deps: DepsDeExperimento): Promise<string> {
  const e = await leerExperimento(deps.store);
  if (!e) return 'No hay experimento. Arrancalo con /experimento (opcional: /experimento 80000 8000 = total y diario en pesos).';
  const lineas = [`🧪 Experimento de reels: ${e.fase}. Total ${pesos(e.total)}, diario ${pesos(e.diario)}.`];
  if (e.fase === 'reels') {
    const estados: string[] = [];
    for (const id of e.reelIds) estados.push(`#${id} ${(await deps.store.reel(id))?.estado ?? '?'}`);
    lineas.push(`Reels: ${estados.length ? estados.join(', ') : 'todavía ninguno armado'} (hacen falta ${e.cantidad} publicados).`);
  }
  if (e.fase === 'listo') lineas.push('La campaña está creada y en pausa. Para arrancar: /experimento_iniciar.');
  if (e.fase === 'corriendo' && e.inicio && deps.meta) {
    const medidas = await medir(e, deps).catch(() => undefined);
    if (medidas) lineas.push(textoDelResumen(e, medidas, diaDelExperimento(e.inicio, deps.ahora())));
  }
  if (e.fin) lineas.push(`Terminó: ${e.fin.motivo}.`);
  return lineas.join('\n');
}

/** /experimento_cancelar: pausa lo que exista en Meta y lo deja cancelado. Los reels ya publicados quedan publicados. */
export async function cancelarExperimento(deps: DepsDeExperimento): Promise<Resultado> {
  const e = await leerExperimento(deps.store);
  if (!e || e.fase === 'terminado' || e.fase === 'cancelado') return { ok: false, motivo: 'no hay un experimento activo' };
  const meta = deps.meta;
  if (meta && e.campana) await meta.cambiarEstado(e.campana, 'PAUSED');
  if (meta && e.conjunto) await meta.cambiarEstado(e.conjunto, 'PAUSED');
  for (const p of e.piezas) {
    if (p.anuncioId !== undefined) await deps.store.actualizarAnuncio(p.anuncioId, { estado: 'pausado', motivo: 'experimento de reels cancelado' });
    p.activo = false;
  }
  await deps.store.cancelarTareas(['agente_reel_estudio', 'renderizar_reel']);
  e.fase = 'cancelado';
  e.fin = { cuando: deps.ahora().toISOString(), motivo: 'lo canceló Gero' };
  await guardar(e, deps);
  return { ok: true, texto: '🛑 Experimento cancelado: pausé todo lo que había en Meta. Los reels ya publicados siguen publicados.' };
}
