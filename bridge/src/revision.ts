import { PEDIDO_DE_ANALISIS } from './ticket.js';

/**
 * El cierre de un pliego EN REVISION (migracion 044): en vez de mergear y
 * publicar, abre un chat en Actividad.
 *
 * El chat es un job comun con la marca de ticket (`[TICKET · …]` o
 * `[DESARROLLO NUEVO]`), que es lo que lee la cola de tickets del panel: ahi
 * aparece el titulo arriba, la descripcion como primer mensaje, la respuesta
 * del agente (el resumen), el PDF del analisis funcional —que queda atado a
 * ESTE job— y el boton "Publicar", que es el que pasa la rama a main.
 */

/** Titulo, descripcion y tipo del pliego que arma el panel (ver pedido.ts del front). */
export function partesDelPliego(md: string): { titulo: string; descripcion: string; desarrollo: boolean } {
  const lineas = md.split('\n');
  const titulo = (lineas[0] ?? '').replace(/^#\s*/, '').trim() || 'Pliego';
  const desarrollo = /aplicaci[oó]n desde cero/i.test(md);
  // Los parrafos entre el titulo y la primera seccion `## `, sin los que
  // escribe el panel ("Es una funcionalidad nueva…", "Es una aplicación…").
  const cuerpo: string[] = [];
  for (const l of lineas.slice(1)) {
    if (/^##\s/.test(l)) break;
    cuerpo.push(l);
  }
  const descripcion = cuerpo
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^Es una (funcionalidad nueva|aplicaci[oó]n desde cero)/i.test(p))
    .join('\n\n');
  return { titulo, descripcion, desarrollo };
}

export interface CierreDeRevision {
  md: string;
  proyecto: string;
  /** El slot que va a cerrar: el ultimo que construyo. */
  agente: string;
  /** Los otros que trabajaron (por un relevo): su rama hay que traerla. */
  otros: string[];
  hechas: number;
  sinResolver: string[];
  completo: boolean;
}

/** Lo que se le pide al agente al cerrar: juntar, analizar y resumir. Sin tocar main. */
export function promptDeRevision(c: CierreDeRevision): string {
  const { titulo, descripcion, desarrollo } = partesDelPliego(c.md);
  const conAnalisis = /an[aá]lisis funcional/i.test(c.md);
  const lineas = [
    desarrollo ? `[DESARROLLO NUEVO] ${titulo}` : `[TICKET · Nueva funcionalidad] ${titulo}`,
    `Proyecto: ${c.proyecto}`,
    '',
    desarrollo ? 'QUÉ TIENE QUE HACER:' : 'DESCRIPCIÓN:',
    descripcion || titulo,
    '',
    'CIERRE DEL PLIEGO (esto es para vos; no lo repitas en tu respuesta):',
    `El pliego terminó${c.completo ? '' : ' sin completarse'}: ${c.hechas} ${c.hechas === 1 ? 'tarea hecha' : 'tareas hechas'}.`,
    'Todo quedó en ramas: NADA está en main, y NO lo pases a main vos. Eso lo hace la persona con el botón "Publicar" de este chat.',
    `1. Asegurate de que TODO el trabajo esté en tu rama claude/${c.agente}/trabajo, commiteado y pusheado.` +
      (c.otros.length
        ? ` Parte la hicieron otros agentes (${c.otros.join(', ')}): traé sus ramas claude/<agente>/trabajo a la tuya.`
        : ''),
    ...(c.sinResolver.length
      ? ['2. Quedó sin resolver (contalo en tu resumen, no lo hagas ahora):', ...c.sinResolver.map((t) => `   - ${t}`)]
      : []),
    ...(conAnalisis ? ['', PEDIDO_DE_ANALISIS] : []),
    '',
    'Tu respuesta es lo que lee la persona en el chat: qué se hizo, cómo probarlo, qué quedó pendiente, y que para pasarlo a main toque "Publicar" en este chat.',
  ];
  return lineas.join('\n');
}
