/**
 * Lo que esta publicado de un proyecto, dicho para el agente.
 *
 * ## Por que existe
 *
 * El link salia UNA vez, en el informe del cierre, y despues no lo tenia nadie:
 * ni el agente ni la base contaban con el. Si ese mensaje se cortaba, o el
 * deploy salia en un reintento, preguntar "che, no me diste el link" no tenia
 * respuesta posible — el agente contestaba de memoria o lo inventaba.
 *
 * La salida NO es un comando nuevo: preguntar por el link es una duda como
 * cualquier otra, y se escribe hablando. Lo que faltaba era que el agente
 * supiera la respuesta, asi que el estado del despliegue viaja en cada turno,
 * igual que los documentos del proyecto.
 *
 * ## Por que tambien cuando no hay nada
 *
 * Un proyecto sin desplegar produce el bloque igual, diciendo que no hay nada y
 * por que. Sin esa linea el agente no distingue "no se despliega" de "no me lo
 * contaron", y lo segundo se contesta inventando una URL con pinta de real.
 */

/** Lo minimo que hace falta de un repo para saber si esta publicado. */
export interface RepoPublicable {
  nombre: string;
  render_url?: string | null;
  solo_lectura?: boolean;
}

/**
 * El bloque de contexto, o `undefined` si el proyecto no tiene repos propios.
 *
 * Los de REFERENCIA quedan afuera: no se despliegan, y nombrarlos como "sin
 * publicar" se leeria como que falta hacerlo.
 */
export function bloqueDeDespliegue(
  repos: readonly RepoPublicable[] | undefined,
): string | undefined {
  const propios = (repos ?? []).filter((r) => !r.solo_lectura);
  if (propios.length === 0) return undefined;

  const publicados = propios.filter((r) => r.render_url);
  const lineas = [
    '[contexto del sistema, no lo dijo la persona]',
    publicados.length > 0
      ? 'Lo que esta publicado de este proyecto, con su URL:'
      : 'De este proyecto NO hay nada publicado todavia.',
  ];
  for (const r of propios) {
    lineas.push(` · ${r.nombre}: ${r.render_url ?? 'sin publicar'}`);
  }
  lineas.push(
    publicados.length > 0
      ? 'Si te preguntan por el link, es ese. No inventes otro ni lo armes a partir del nombre.'
      : 'Si te preguntan por el link, decile que todavia no se publico y que para publicarlo ' +
        'hace falta una corrida que cierre bien, o hacerlo a mano en Render. No inventes una URL.',
  );
  return lineas.join('\n');
}

/**
 * El prompt de un turno, con el bloque adelante.
 *
 * Adelante y no atras: lo ultimo que lee el modelo es lo que la persona
 * escribio, que es lo que tiene que contestar.
 */
export function conDespliegue(
  prompt: string,
  repos: readonly RepoPublicable[] | undefined,
): string {
  const bloque = bloqueDeDespliegue(repos);
  return bloque ? `${bloque}\n\n${prompt}` : prompt;
}
