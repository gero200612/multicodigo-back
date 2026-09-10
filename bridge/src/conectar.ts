/**
 * Conectar el front con el back al cerrar una corrida.
 *
 * Una corrida que construye dos servicios los publicaba y los dejaba SIN
 * conocerse: en `mesas` (2026-09-10) quedaron los dos andando y el panel
 * mostrando "no me puedo conectar con la cocina", porque su `config.js` seguia
 * apuntando a `localhost`. El dato para unirlos ya existia —`publicar()` junta
 * las URLs de los dos— y se usaba solo para el informe.
 *
 * Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-10-conectar-front-y-back-design.md`.
 */

import type { Publicado } from './publicar.js';

/**
 * La asignacion de la URL en el config del front.
 *
 * Cubre `window.API_URL`, `const API_URL` y `var/let`, con comillas simples o
 * dobles y espacios de por medio, porque el archivo lo escribe un modelo y esas
 * variantes son todas naturales. Lo que NO cubre —una URL armada, leida de otro
 * lado, o partida en dos lineas— cae en "no lo toco", que es el default seguro.
 */
const ASIGNACION = /((?:window\.|(?:const|let|var)\s+)API_URL\s*=\s*)(['"])([^'"]*)\2/;

/**
 * El config del front, con la URL del back adentro.
 *
 * ## Por que devuelve un error en vez de intentar igual
 *
 * Esto es lo UNICO de todo el sistema donde el bridge escribe codigo del
 * cliente por fuera de una tarea del agente. El criterio, entonces, es al reves
 * del habitual: ante la duda no se toca. Un `config.js` que no matchea puede
 * estar haciendo cualquier cosa —leer de otro lado, componer la URL— y una
 * sustitucion a ciegas lo rompe. Un pendiente que dice "cambiale la URL a mano"
 * es infinitamente mejor que un archivo roto que nadie pidio tocar.
 */
export function conApiUrl(
  texto: string,
  url: string,
): { ok: true; texto: string } | { ok: false; motivo: string } {
  // Una URL con comillas o saltos de linea se escribiria adentro de un string
  // literal y podria cerrarlo. No deberia pasar —las URLs salen de Render— pero
  // el que escribe un archivo ajeno no se apoya en "no deberia".
  if (!/^https?:\/\/[^\s'"\\]+$/.test(url)) {
    return { ok: false, motivo: `la URL ${url} no tiene una forma que pueda escribir` };
  }

  const m = ASIGNACION.exec(texto);
  if (!m) {
    return { ok: false, motivo: 'no encontre donde esta configurada la URL de la API' };
  }
  if (m[3] === url) {
    // Nada que hacer: un commit vacio ensucia la historia y dispara un deploy
    // que no cambia nada.
    return { ok: false, motivo: 'ya apunta a esa URL' };
  }

  // Se reemplaza SOLO el tramo que matcheo, con `$1` intacto: el resto del
  // archivo —comentarios, otras variables, el formato— queda igual.
  return { ok: true, texto: texto.replace(ASIGNACION, `$1$2${url}$2`) };
}

/**
 * Cual de los repos publicados es el front y cual el back.
 *
 * Por convencion de nombre (`<proyecto>-front` / `<proyecto>-back`), que es lo
 * que el bot crea siempre. Con mas de uno de cada lado NO se adivina: conectar
 * dos servicios al azar es peor que no conectar ninguno, y un proyecto de tres
 * servicios necesita un diseño que todavia no existe.
 */
export function frontYBackDe(
  publicados: readonly Publicado[],
): { front: Publicado; back: Publicado } | undefined {
  const fronts = publicados.filter((p) => p.repo.endsWith('-front'));
  const backs = publicados.filter((p) => p.repo.endsWith('-back'));
  if (fronts.length !== 1 || backs.length !== 1) return undefined;
  return { front: fronts[0]!, back: backs[0]! };
}
