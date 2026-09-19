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
import type { Leido } from './github-contenido.js';

/**
 * La asignacion de la URL en el config del front.
 *
 * Cubre `window.API_URL`, `const API_URL` y `var/let`, y tambien el
 * `apiUrl: '...'` de un `environment.ts` de Angular, que es lo que el sistema
 * genera hoy. Con comillas simples o
 * dobles y espacios de por medio, porque el archivo lo escribe un modelo y esas
 * variantes son todas naturales. Lo que NO cubre —una URL armada, leida de otro
 * lado, o partida en dos lineas— cae en "no lo toco", que es el default seguro.
 */
const ASIGNACION =
  /((?:window\.|(?:const|let|var)\s+)API_URL\s*=\s*|apiUrl\s*:\s*)(['"])([^'"]*)\2/;

/**
 * Por que no se pudo reescribir, como codigo y no solo como texto.
 *
 * Quien llama decide distinto en cada caso —"ya apunta" es un exito, "no hay
 * asignacion" es que el front lee la URL de otro lado— y decidir comparando el
 * texto del motivo se rompe el dia que alguien lo corrige de redaccion.
 */
export type RazonDeNoCambio = 'url_invalida' | 'sin_asignacion' | 'igual';

/**
 * La ruta que traia el valor anterior, si traia alguna.
 *
 * `https://CAMBIAR-URL-DEL-BACK/api` -> `/api`. Una URL sin ruta, un valor que
 * no es URL o una barra sola no aportan nada y devuelven ''.
 */
function sufijoDeRuta(valor: string): string {
  try {
    const { pathname } = new URL(valor);
    return pathname === '/' ? '' : pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

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
): { ok: true; texto: string } | { ok: false; motivo: string; razon: RazonDeNoCambio } {
  // Una URL con comillas o saltos de linea se escribiria adentro de un string
  // literal y podria cerrarlo. No deberia pasar —las URLs salen de Render— pero
  // el que escribe un archivo ajeno no se apoya en "no deberia".
  if (!/^https?:\/\/[^\s'"\\]+$/.test(url)) {
    return {
      ok: false,
      motivo: `la URL ${url} no tiene una forma que pueda escribir`,
      razon: 'url_invalida',
    };
  }

  const m = ASIGNACION.exec(texto);
  if (!m) {
    return {
      ok: false,
      motivo: 'no encontre donde esta configurada la URL de la API',
      razon: 'sin_asignacion',
    };
  }
  // El valor viejo manda el SUFIJO: un Angular apunta a `.../api`, no a la raiz.
  //
  // Sin esto, conectar el front lo dejaba pidiendo a la raiz del back y todas
  // las llamadas daban 404. El placeholder que genera el sistema es
  // `https://CAMBIAR-URL-DEL-BACK/api`, asi que el sufijo esta a la vista y lo
  // unico que hay que hacer es no tirarlo.
  const destino = `${url}${sufijoDeRuta(m[3] ?? '')}`;

  if (m[3] === destino) {
    // Nada que hacer: un commit vacio ensucia la historia y dispara un deploy
    // que no cambia nada.
    return { ok: false, motivo: 'ya apunta a esa URL', razon: 'igual' };
  }

  // Se reemplaza SOLO el tramo que matcheo, con `$1` intacto: el resto del
  // archivo —comentarios, otras variables, el formato— queda igual.
  return { ok: true, texto: texto.replace(ASIGNACION, `$1$2${destino}$2`) };
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

/**
 * Donde se busca el config del front.
 *
 * UNO y fijo, como dice el spec: es donde lo pone el patron que el sistema
 * construye (un server de express que sirve `public/`). Buscar en varios
 * lugares seria empezar a adivinar, y aca adivinar mal es escribir un archivo
 * que nadie pidio tocar.
 */
export const CONFIG_DEL_FRONT = 'public/config.js';

/**
 * Donde puede vivir la URL del back, en orden.
 *
 * Eran UNO solo —`public/config.js`, el patron del express que servia
 * `public/`— y el sistema hace rato que genera Angular, donde eso no existe.
 * El resultado: `reescribirConfig` devolvia `sin_config`, nadie escribia nada,
 * y el front quedaba con el placeholder que le puso el modelo. En `padel` eso
 * fue `apiUrl: 'https://CAMBIAR-URL-DEL-BACK/api'` desplegado a produccion.
 *
 * Se prueban en orden y gana el PRIMERO que existe. Sigue sin adivinar: son
 * dos rutas fijas, las dos del patron que este sistema construye.
 */
export const CONFIGS_DEL_FRONT = [CONFIG_DEL_FRONT, 'src/environments/environment.ts'] as const;

/** Que paso con el config del front. */
export type ResultadoDeConfig =
  /** Se reescribio y se commiteo en main: hay que desplegar el front. */
  | { estado: 'cambiado' }
  /** Ya apuntaba al back. Conectado, y sin nada que desplegar. */
  | { estado: 'igual' }
  /** No existe, o no tiene una asignacion reconocible. No se toco. */
  | { estado: 'sin_config' }
  /** Se intento y fallo algo que una persona tiene que mirar. */
  | { estado: 'error'; motivo: string };

/** Leer y escribir en el repo. Vienen de `github-contenido.ts`, con el token ya puesto. */
export interface ArchivosDelRepo {
  leer: (repo: string, ruta: string) => Promise<Leido>;
  escribir: (
    repo: string,
    ruta: string,
    texto: string,
    sha: string,
    mensaje: string,
  ) => Promise<{ ok: true } | { ok: false; motivo: string }>;
}

/**
 * El respaldo de la variable de entorno: reescribir el `config.js` del front.
 *
 * Hace falta porque la variable sola NO alcanzo en `mesas`: quedo seteada en
 * Render y el front siguio apuntando a `localhost`, porque un front de HTML
 * puro no lee `process.env` — su server tiene que inyectarla, y ese codigo no
 * existia. Nada lo decia: el informe dio la conexion por hecha.
 */
export async function reescribirConfig(
  githubRepo: string,
  url: string,
  archivos: ArchivosDelRepo,
): Promise<ResultadoDeConfig> {
  // El primero que exista. Un `noExiste` no es un error: es el otro patron.
  let ruta = '';
  let leido: Leido | undefined;
  for (const candidata of CONFIGS_DEL_FRONT) {
    const r = await archivos.leer(githubRepo, candidata);
    if (r.ok) {
      ruta = candidata;
      leido = r;
      break;
    }
    if (!r.noExiste) return { estado: 'error', motivo: r.motivo };
  }
  if (!leido || !leido.ok) return { estado: 'sin_config' };

  const r = conApiUrl(leido.texto, url);
  if (!r.ok) {
    if (r.razon === 'igual') return { estado: 'igual' };
    if (r.razon === 'sin_asignacion') return { estado: 'sin_config' };
    return { estado: 'error', motivo: r.motivo };
  }

  const escrito = await archivos.escribir(
    githubRepo,
    ruta,
    r.texto,
    leido.sha,
    `chore(config): apuntar API_URL al back publicado\n\n` +
      `El front y el back se despliegan como dos servicios, y la URL del back\n` +
      `recien existe cuando se publica. La escribe el sistema al cerrar la\n` +
      `corrida: ${url}`,
  );
  return escrito.ok ? { estado: 'cambiado' } : { estado: 'error', motivo: escrito.motivo };
}
