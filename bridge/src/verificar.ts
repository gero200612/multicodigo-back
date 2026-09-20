/**
 * Mirar la app DESPLEGADA, no solo el codigo.
 *
 * ## Por que existe
 *
 * En la corrida `Hoteleria` del 2026-09-20 las tareas del login, del CORS y del
 * despliegue figuraban TODAS como hechas, y la app no se podia usar: el back
 * servia un commit de seis horas antes, `/api/auth/login` daba 404 y el
 * navegador bloqueaba las llamadas del front. Nadie se entero hasta que una
 * persona entro doce horas despues.
 *
 * El analista de USUARIO mira el codigo y el runner corre los tests; los dos
 * pueden dar verde sobre algo que no levanta. Lo unico que lo caza es pedirle
 * una pagina a la URL publica y ver que contesta.
 *
 * ## Que NO hace
 *
 * No sabe las rutas de la app ni sus credenciales, asi que no puede probar un
 * login de verdad. Lo que revisa es lo que vale para cualquier proyecto: que el
 * deploy haya terminado bien y que la URL no conteste 5xx. Eso alcanza para
 * cazar un servicio caido, un build roto y una base sin conectar — que fueron
 * tres de los cuatro problemas de esa noche.
 */

export interface ServicioAVerificar {
  /** El nombre del repo, para el mensaje. */
  nombre: string;
  /** El id del servicio en Render, si lo tiene. */
  serviceId?: string;
  /** La URL publica, si la tiene. */
  url?: string;
}

/** Un problema encontrado en la app desplegada. */
export interface ProblemaDeDespliegue {
  nombre: string;
  /** Una linea, para el informe. */
  resumen: string;
  /** El detalle para la tarea: el log del deploy o el cuerpo de la respuesta. */
  detalle: string;
}

export interface VerificarDeps {
  /** Como esta el ultimo deploy del servicio. De `render-api.ts`. */
  estadoDeDeploy?: (
    serviceId: string,
  ) => Promise<
    | { estado: 'vivo' }
    | { estado: 'construyendo' }
    | { estado: 'fallo'; motivo: string; log: string[] }
    | { estado: 'sin_render' }
    | { estado: 'error'; motivo: string }
  >;
  fetchImpl?: typeof fetch;
}

/** Cuanto se le espera a una URL antes de darla por caida. */
const TOPE_MS = 20_000;

/**
 * El cuerpo recortado, para que entre en una tarea sin tapar la pantalla.
 *
 * Una pagina de error de ASP.NET son cientos de lineas de stack; la primera
 * frase ya dice cual es el problema.
 */
function recorte(texto: string, tope = 400): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  return plano.length <= tope ? plano : `${plano.slice(0, tope)}…`;
}

export async function verificarDespliegue(
  servicios: readonly ServicioAVerificar[],
  deps: VerificarDeps = {},
): Promise<ProblemaDeDespliegue[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const problemas: ProblemaDeDespliegue[] = [];

  for (const s of servicios) {
    // Primero el deploy: una URL que contesta puede estar sirviendo la version
    // ANTERIOR mientras la nueva falla en loop, que es exactamente lo que
    // pasaba con `padel-front` y sus cuatro `update_failed` seguidos.
    if (s.serviceId && deps.estadoDeDeploy) {
      const d = await deps.estadoDeDeploy(s.serviceId).catch(() => undefined);
      if (d?.estado === 'fallo') {
        problemas.push({
          nombre: s.nombre,
          resumen: `el ultimo deploy de ${s.nombre} fallo (${d.motivo})`,
          detalle: d.log.join('\n'),
        });
        // Sin deploy no tiene sentido pedirle la pagina: lo que conteste es de
        // la version vieja.
        continue;
      }
      // Construyendo no es un problema: es que todavia no termino.
      if (d?.estado === 'construyendo') continue;
    }

    if (!s.url) continue;

    try {
      const res = await doFetch(s.url, { signal: AbortSignal.timeout(TOPE_MS) });
      // 4xx NO es un problema: una API con todo protegido contesta 401 en la
      // raiz y esta perfectamente sana. Lo que no puede pasar es un 5xx.
      if (res.status >= 500) {
        problemas.push({
          nombre: s.nombre,
          resumen: `${s.nombre} contesta ${res.status} en ${s.url}`,
          detalle: recorte(await res.text().catch(() => '')),
        });
      }
    } catch (err) {
      problemas.push({
        nombre: s.nombre,
        resumen: `${s.nombre} no contesta en ${s.url}`,
        detalle: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return problemas;
}

/**
 * El texto de la tarea que arregla un problema de despliegue.
 *
 * Se redacta aca y no en el pipeline porque es lo unico que el agente va a
 * leer: tiene que traer el sintoma, la URL y el log, que es lo que no puede
 * averiguar solo —no tiene salida a internet—.
 */
export function tareaDeProblema(p: ProblemaDeDespliegue): string {
  const detalle = p.detalle ? `\n\nLo que dice:\n${p.detalle}` : '';
  return (
    `La app desplegada no responde bien: ${p.resumen}. ` +
    'Los tests pueden estar en verde igual, asi que revisalo contra lo que ' +
    `pasa en el servicio, no contra el codigo local.${detalle}`
  );
}
