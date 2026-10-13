/**
 * El vigia de lo publicado: despues de desplegar un proyecto, Punchi revisa
 * solo la app publicada y, si algo falla, abre una corrida para arreglarlo.
 *
 * Por que: en un proyecto existente la corrida trabaja en revision (lo suyo
 * queda en una rama y la persona lo aprueba), asi que mientras trabaja no
 * puede mirar produccion, que todavia no tiene sus cambios. Faltaba quien
 * mirara DESPUES de aprobar y desplegar. TallerPro (2026-10-13): se aprobo, se
 * desplego, y seis pantallas seguian en 500 sin que nadie lo dijera.
 *
 * El ciclo no corre solo para siempre: cada arreglo vuelve a pasar por la
 * aprobacion de la persona, y hay un tope de una corrida automatica por
 * proyecto cada 6 horas.
 */

export interface Problema {
  resumen: string;
  tarea: string;
}

export interface DepsDelVigia {
  /** Espera a que terminen los despliegues del proyecto. `listo: false` si se paso el techo. */
  esperarDespliegues: (proyectoId: string, desde: Date) => Promise<{ listo: boolean; fallados: string[] }>;
  /** Las mismas revisiones de la corrida: log de arranque, prueba con login y recorrido de pantallas. */
  verificar: (proyectoId: string, proyecto: string) => Promise<Problema[]>;
  avisar: (usuarioId: string, html: string) => Promise<void>;
  /** Abre la corrida de arreglo (en revision, como cualquier desarrollo en un proyecto existente). */
  abrirArreglo: (usuarioId: string, proyectoId: string, pliego: string) => Promise<{ ok: boolean; motivo?: string }>;
  ahora?: () => number;
  /** Lo que tarda la app en arrancar despues de armarse, antes de mirarla. */
  esperarArranqueMs?: number;
  dormir?: (ms: number) => Promise<void>;
}

/** Una corrida automatica por proyecto cada tanto: si el arreglo no anda, que no se encadenen. */
export const ENTRE_ARREGLOS_MS = 6 * 3_600_000;

const enCurso = new Set<string>();
const ultimoArreglo = new Map<string, number>();

/** Solo para tests. */
export function reiniciarVigia(): void {
  enCurso.clear();
  ultimoArreglo.clear();
}

const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function pliegoDeArreglo(proyecto: string, problemas: Problema[]): string {
  return [
    `# Arreglar ${proyecto} publicado`,
    '',
    'Despues del ultimo despliegue, la revision automatica de la app publicada (con el usuario de prueba)',
    'encontro esto:',
    '',
    ...problemas.map((p) => `- ${p.resumen}`),
    '',
    'Arregla la CAUSA de cada uno, no un parche por pantalla: si varias pantallas fallan por lo mismo',
    '(por ejemplo, tablas que no existen porque las migraciones no corren), arregla eso una vez.',
    '',
    '## Detalle de cada problema',
    '',
    ...problemas.map((p, i) => `### ${i + 1}. ${p.resumen}\n\n${p.tarea}\n`),
  ].join('\n');
}

/**
 * Despues de desplegar: espera, mira y avisa. Si encuentra problemas, abre la
 * corrida de arreglo. Nunca tira: es de fondo.
 */
export async function verificarPublicado(
  p: { usuarioId: string; proyectoId: string; proyecto: string; desde: Date },
  deps: DepsDelVigia,
): Promise<'ok' | 'problemas' | 'sin_terminar' | 'ya_en_curso'> {
  if (enCurso.has(p.proyectoId)) return 'ya_en_curso';
  enCurso.add(p.proyectoId);
  const ahora = deps.ahora ?? Date.now;
  const dormir = deps.dormir ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  try {
    const e = await deps.esperarDespliegues(p.proyectoId, p.desde);
    if (!e.listo) {
      await deps.avisar(p.usuarioId, `⏳ ${escapar(p.proyecto)}: el despliegue sigue armándose después de 20 minutos. Lo reviso cuando lo vuelvas a desplegar.`);
      return 'sin_terminar';
    }
    await dormir(deps.esperarArranqueMs ?? 60_000);
    const problemas = await deps.verificar(p.proyectoId, p.proyecto);
    if (problemas.length === 0) {
      await deps.avisar(
        p.usuarioId,
        `✅ Revisé <b>${escapar(p.proyecto)}</b> publicado: arranca bien y las pantallas cargan con el usuario de prueba.`,
      );
      return 'ok';
    }
    const lista = problemas.map((x) => ` · ${escapar(x.resumen)}`).join('\n');
    const ultimo = ultimoArreglo.get(p.proyectoId);
    if (ultimo !== undefined && ahora() - ultimo < ENTRE_ARREGLOS_MS) {
      await deps.avisar(
        p.usuarioId,
        `🔎 Revisé <b>${escapar(p.proyecto)}</b> publicado y sigue habiendo problemas:\n${lista}\n\n` +
          'Ya abrí una corrida de arreglo hace menos de 6 horas: no abro otra sola. Si querés, lanzala vos desde Desarrollo.',
      );
      return 'problemas';
    }
    const r = await deps.abrirArreglo(p.usuarioId, p.proyectoId, pliegoDeArreglo(p.proyecto, problemas));
    if (r.ok) ultimoArreglo.set(p.proyectoId, ahora());
    await deps.avisar(
      p.usuarioId,
      `🔎 Revisé <b>${escapar(p.proyecto)}</b> publicado y encontré ${problemas.length} problema(s):\n${lista}\n\n` +
        (r.ok
          ? 'Abrí una corrida para arreglarlos. Cuando termine, aprobala en Actividad y volvé a desplegar: lo reviso de nuevo.'
          : `No pude abrir la corrida de arreglo (${escapar(r.motivo ?? 'sin motivo')}). Lanzala vos desde Desarrollo.`),
    );
    return 'problemas';
  } catch (err) {
    console.error(`[bridge] vigia de ${p.proyecto}:`, err);
    return 'sin_terminar';
  } finally {
    enCurso.delete(p.proyectoId);
  }
}
