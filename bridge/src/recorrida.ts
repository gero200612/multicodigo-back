import type { AgentsClientDeps } from './agents-client.js';
import type { ProblemaDeDespliegue } from './verificar.js';

/**
 * La recorrida del front PUBLICADO: el gateway entra con el usuario del
 * proyecto, pasa por TODAS las pantallas del menu y mide (ver `recorrer` en
 * multicodigo-vm, gateway/src/mirar.ts). Lo hace el sistema, no el modelo.
 *
 * Existe por TallerPro (2026-10-12): seis pantallas mostraban "Error interno
 * del servidor", el header se partia en tres renglones, y la corrida cerro
 * "completa". El analista visual elegia hasta tres pantallas y, sin poder
 * entrar, solo veia la portada y el login, que estaban bien.
 */

export interface Recorrida {
  entro: boolean;
  /** Si el gateway tenia con que entrar (cuenta de demo o USUARIO_DE_PRUEBA). */
  conLogin: boolean;
  rutas: string[];
  mediciones: string[];
  notas: string[];
}

/** Las pantallas en cada tamaño, una por una: puede tardar varios minutos. */
const TECHO_MS = 9 * 60_000;

export async function recorrerPublicado(
  proyecto: string,
  publicado: string,
  deps: AgentsClientDeps,
): Promise<Recorrida | undefined> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.gatewayUrl.replace(/\/$/, '')}/recorrer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.token}` },
      body: JSON.stringify({ project: proyecto, publicado }),
      signal: AbortSignal.timeout(TECHO_MS),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Recorrida;
  } catch {
    return undefined;
  }
}

/** Que tipo de cosa marca una medicion: cada tipo es UNA tarea, no una por pantalla. */
const TIPOS: { re: RegExp; resumen: (n: string, cuantas: number) => string; pedido: string }[] = [
  {
    re: /LA PANTALLA MUESTRA UN ERROR/,
    resumen: (n, c) => `${n}: ${c} pantalla(s) le muestran un error a la persona`,
    pedido:
      'Cada una de estas pantallas, entrando con el usuario de prueba, le muestra un error a la persona. ' +
      'Busca la causa en el back publicado (la ruta que llama esa pantalla y el log del arranque), no en el ' +
      'mensaje del front.',
  },
  {
    re: /HEADER ROTO/,
    resumen: (n) => `${n}: el header se parte en renglones`,
    pedido:
      'El header no entra en una fila: lo que sobra cae a otro renglon. Agrupa el menu (por ejemplo un ' +
      'desplegable por area, o un menu lateral) para que entre en una fila desde 1280px, y en el telefono ' +
      'un menu que se abre.',
  },
  {
    re: /pedidos que fallaron/,
    resumen: (n, c) => `${n}: ${c} pantalla(s) con pedidos al back que fallan`,
    pedido: 'Estas pantallas hacen pedidos al back que fallan. Arreglalos en el back o en el front, segun corresponda.',
  },
  {
    re: /SE SALE DE ANCHO|DESALINEADO|errores de consola/,
    resumen: (n, c) => `${n}: ${c} problema(s) de diseño medidos`,
    pedido: 'El navegador midio estos problemas de diseño. Se miden, no son opinion: arreglalos.',
  },
];

/**
 * Lo que la recorrida encontro, como trabajo para la corrida. Agrupado por
 * tipo: seis pantallas con el mismo 500 son UNA tarea, con la lista.
 */
export function problemasDeRecorrida(nombre: string, publicado: string, r: Recorrida): ProblemaDeDespliegue[] {
  const problemas: ProblemaDeDespliegue[] = [];
  if (!r.entro && r.conLogin) {
    problemas.push({
      nombre,
      resumen: `no pude entrar a ${nombre} publicado con el usuario de prueba`,
      detalle:
        `La recorrida no pudo entrar a ${publicado} con el usuario de la linea USUARIO_DE_PRUEBA del contrato ` +
        `(o la cuenta de demo), asi que nadie puede revisar lo de adentro.\n${r.notas.join('\n')}`,
    });
  } else if (!r.conLogin && r.rutas.length <= 1) {
    problemas.push({
      nombre,
      resumen: `${nombre} no tiene usuario de prueba para revisarlo`,
      detalle:
        'Falta la linea `USUARIO_DE_PRUEBA: <email> / <contraseña>` en el contrato, con un administrador que ' +
        'el back siembre al arrancar: sin eso nadie puede entrar a revisar la app publicada.',
    });
  }
  const usadas = new Set<string>();
  for (const t of TIPOS) {
    const lineas = r.mediciones.filter((m) => !usadas.has(m) && t.re.test(m));
    if (lineas.length === 0) continue;
    for (const l of lineas) usadas.add(l);
    problemas.push({
      nombre,
      resumen: t.resumen(nombre, lineas.length),
      detalle: `${t.pedido}\n\nLo medido en ${publicado}:\n${lineas.slice(0, 15).join('\n')}`.slice(0, 3000),
    });
  }
  return problemas;
}
