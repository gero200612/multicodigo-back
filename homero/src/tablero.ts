import { horaArgentina, inicioDelDia, relojArgentino } from './horas.js';
import type { Actividad } from './mcp.js';
import type { Agente, Store, TipoDeTarea } from './store.js';

/**
 * El estado de cada agente, para el tablero de la web.
 *
 * Gero no quiere leer corridas: quiere saber, de un vistazo, que esta haciendo
 * cada agente AHORA. Eso sale de tres lugares:
 * - lo que esta haciendo en este momento: cada herramienta que usa pasa por el
 *   MCP de Homero, asi que se ve en vivo (`SesionesMcp.enCurso`);
 * - lo que tiene en la cola y por que espera (sin cuenta libre, sin uso de
 *   Claude, pausa manual, todavia no es la hora);
 * - como le fue en la ultima corrida.
 */

export type EstadoDeAgente = 'trabajando' | 'esperando' | 'pausado' | 'libre' | 'error';

export interface TableroDeAgente {
  estado: EstadoDeAgente;
  /** Una oracion para Gero: "Leyendo imprentasnorte.com.ar", "Esperando una cuenta libre". */
  detalle: string;
  /** La corrida en curso, con lo que va haciendo en vivo. */
  ahora?: Actividad;
  /** Tareas suyas esperando en la cola. */
  enCola: number;
  ultima?: { id: number; estado: 'corriendo' | 'lista' | 'fallida'; fin?: Date; informe?: string; resumen?: string; error?: string };
  /** Lo que hizo hoy, para los contadores grandes. */
  hoy: Record<string, number>;
}

export interface Tablero {
  agentes: Record<Agente, TableroDeAgente>;
  /** Si Claude esta en pausa para todos (sin uso en el fondo comun). */
  iaPausadaHasta?: Date;
  pausaManual: boolean;
}

/** Los tipos de la cola de cada agente; los viejos del guion siguen contando. */
const TIPOS: Record<Agente, TipoDeTarea[]> = {
  buscador: ['agente_buscar', 'prospectar'],
  vendedor: ['agente_vender', 'investigar'],
  atencion: ['agente_atender', 'resumir_respuesta'],
};

/** Que hace una herramienta, dicho para Gero. */
const VERBOS: Record<string, string> = {
  leer_pagina: 'Leyendo',
  ver_rendimiento: 'Mirando qué rubros rinden',
  buscar_en_mapa: 'Buscando en el mapa',
  ya_conocido: 'Chequeando si ya lo conoce',
  anotar_busqueda: 'Anotando una búsqueda',
  anotar_negocio: 'Anotó',
  ver_ficha: 'Leyendo la ficha',
  mails_que_funcionaron: 'Mirando mails que funcionaron',
  verificar_mail: 'Verificando',
  dejar_mail_listo: 'Dejó listo el mail para',
  descartar: 'Descartó el negocio',
  ver_hilo: 'Leyendo la respuesta',
  horarios_libres: 'Mirando tu agenda',
  proponer_respuesta: 'Te pasó una respuesta para aprobar',
  confirmar_horario: 'Reservó un horario',
  anotar_baja: 'Anotó una baja',
  cerrar_sin_responder: 'Cerró sin responder',
  avisar_a_gero: 'Te avisó por Telegram',
  escribir_libreta: 'Anotando lo que aprendió',
};

export function describirPaso(herramienta: string, dato?: string): string {
  const verbo = VERBOS[herramienta] ?? herramienta;
  return dato ? `${verbo} ${dato}` : verbo;
}

const QUE_ESPERA_LIBRE: Record<Agente, (ahora: Date) => string> = {
  buscador: (ahora) => {
    const { hora, diaSemana } = relojArgentino(ahora);
    const habil = diaSemana >= 1 && diaSemana <= 5;
    if (habil && hora < 17) return 'Sale a buscar solo cada 2 horas, de 7 a 17, si falta llenar el cupo del día';
    return 'Sale a buscar el próximo día hábil a las 7';
  },
  vendedor: () => 'Sin negocios para investigar: espera a que el buscador anote',
  atencion: () => 'Esperando respuestas: revisa las bandejas cada 10 minutos',
};

export async function armarTablero(
  deps: { store: Store; ahora: () => Date; enCurso: () => Actividad[] },
): Promise<Tablero> {
  const ahora = deps.ahora();
  const [cola, pausaIa, pausaManual, corridas, metricas] = await Promise.all([
    deps.store.colaPorTipo(),
    deps.store.leerEstado<{ hasta: string }>('ia_pausada'),
    deps.store.leerEstado('pausa_manual'),
    deps.store.corridas({ limite: 200 }),
    deps.store.metricasDesde(inicioDelDia(ahora)),
  ]);
  const iaPausadaHasta =
    pausaIa && new Date(pausaIa.hasta).getTime() > ahora.getTime() ? new Date(pausaIa.hasta) : undefined;
  const enCurso = deps.enCurso();
  const desdeHoy = inicioDelDia(ahora).getTime();
  const deHoy = (a: Agente) => corridas.filter((c) => c.agente === a && c.inicio.getTime() >= desdeHoy);

  const uno = (agente: Agente): TableroDeAgente => {
    const suyas = cola.filter((c) => TIPOS[agente].includes(c.tipo));
    const enCola = suyas.reduce((n, c) => n + c.pendientes, 0);
    const actividad = enCurso.find((a) => a.agente === agente);
    const ultimaC = corridas.find((c) => c.agente === agente && c.estado !== 'corriendo');
    const ultima = ultimaC
      ? { id: ultimaC.id, estado: ultimaC.estado, fin: ultimaC.fin, informe: ultimaC.informe, resumen: ultimaC.resumen, error: ultimaC.error }
      : undefined;
    const hoyC = deHoy(agente);
    const hoy: Record<string, number> =
      agente === 'buscador'
        ? { corridas: hoyC.length, negocios: metricas.leads }
        : agente === 'vendedor'
          ? { corridas: hoyC.length, enviados: metricas.enviados }
          : { respuestas: metricas.respuestas, reuniones: metricas.reuniones };
    const base = { enCola, ultima, hoy };

    if (actividad) {
      const ultimoPaso = actividad.pasos.at(-1);
      return {
        ...base,
        estado: 'trabajando',
        ahora: actividad,
        detalle: ultimoPaso ? describirPaso(ultimoPaso.herramienta, ultimoPaso.dato) : `Pensando${actividad.lead ? ` sobre ${actividad.lead}` : ''}`,
      };
    }
    if (pausaManual) return { ...base, estado: 'pausado', detalle: 'En pausa (la pusiste vos). Tocá Seguir para retomar.' };
    if (iaPausadaHasta && enCola > 0) {
      return { ...base, estado: 'pausado', detalle: `Sin uso de Claude en las cuentas: vuelve ${horaArgentina(iaPausadaHasta)}` };
    }
    if (enCola > 0) {
      const sinLugar = suyas.some((c) => c.ultimoError === 'sin cuenta libre');
      const proxima = suyas
        .map((c) => c.proxima)
        .filter((p): p is Date => !!p)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (sinLugar) return { ...base, estado: 'esperando', detalle: 'Esperando una cuenta de Claude libre (Punchi las está usando)' };
      if (proxima && proxima.getTime() > ahora.getTime()) {
        return { ...base, estado: 'esperando', detalle: `${enCola} en cola; la próxima arranca ${horaArgentina(proxima)}` };
      }
      return { ...base, estado: 'esperando', detalle: `${enCola} en cola, arranca en un momento` };
    }
    if (ultima?.estado === 'fallida' && ultimaC && ultimaC.inicio.getTime() >= desdeHoy) {
      return { ...base, estado: 'error', detalle: `La última falló: ${ultima.error ?? 'sin detalle'}` };
    }
    return { ...base, estado: 'libre', detalle: QUE_ESPERA_LIBRE[agente](ahora) };
  };

  return {
    agentes: { buscador: uno('buscador'), vendedor: uno('vendedor'), atencion: uno('atencion') },
    iaPausadaHasta,
    pausaManual: !!pausaManual,
  };
}
