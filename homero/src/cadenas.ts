import type { Hallazgo } from './fuentes.js';

/**
 * Cadenas y franquicias: no se les escribe. Tienen sus propios sistemas y un
 * area de IT; una pyme con un problema concreto es el cliente, no Megatlon.
 *
 * Se filtran ANTES de crear el lead, sin IA: cada una que llegaba a investigar
 * gastaba un turno de Claude para terminar descartada.
 */

/**
 * Webs que no identifican a un negocio: muchas pymes usan su Instagram o un
 * Linktree como "web", y dos negocios distintos ahi no son una cadena.
 */
const GENERICOS = [
  'facebook.com',
  'instagram.com',
  'linktr.ee',
  'wa.me',
  'whatsapp.com',
  'sites.google.com',
  'business.site',
  'google.com',
  'wixsite.com',
  'blogspot.com',
  'mercadolibre.com.ar',
  'tiendanube.com',
  'mitiendanube.com',
  'youtube.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
];

/** `https://www.megatlon.com/sedes/palermo` -> `megatlon.com`. Undefined si es generico. */
export function dominio(web: string | undefined): string | undefined {
  if (!web) return undefined;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(web) ? web : `https://${web}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  host = host.replace(/^www\d*\./, '');
  if (GENERICOS.some((g) => host === g || host.endsWith(`.${g}`))) return undefined;
  return host || undefined;
}

/** `"SportClub Belgrano Plaza"` -> `"sportclub belgrano plaza"`, sin tildes. */
const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Separa los hallazgos de una busqueda en los que se investigan y las cadenas.
 *
 * Es cadena si:
 *  - la fuente la marca como marca (OSM: `brand`);
 *  - comparte web con otro hallazgo de la misma busqueda (dos sedes);
 *  - otro hallazgo se llama igual, o igual mas algo ("SportClub" y
 *    "SportClub Palermo");
 *  - `yaVisto` dice que ese dominio ya estaba en un lead anterior: otra sede
 *    de una busqueda pasada, o el mismo negocio otra vez.
 */
export async function sinCadenas(
  hallazgos: Hallazgo[],
  yaVisto: (dominio: string) => Promise<boolean>,
): Promise<{ quedan: Hallazgo[]; cadenas: Hallazgo[] }> {
  const porDominio = new Map<string, number>();
  for (const h of hallazgos) {
    const d = dominio(h.web);
    if (d) porDominio.set(d, (porDominio.get(d) ?? 0) + 1);
  }
  const nombres = hallazgos.map((h) => normal(h.nombre));
  // Nombres cortos ("gym", "spa") se repiten sin ser cadena: solo cuentan los
  // de 4 letras o mas.
  const repiteNombre = (i: number) => {
    const n = nombres[i]!;
    if (n.length < 4) return false;
    return nombres.some(
      (otro, j) => j !== i && otro.length >= 4 && (otro === n || otro.startsWith(`${n} `) || n.startsWith(`${otro} `)),
    );
  };

  const quedan: Hallazgo[] = [];
  const cadenas: Hallazgo[] = [];
  for (const [i, h] of hallazgos.entries()) {
    const d = dominio(h.web);
    const esCadena =
      h.marca === true ||
      (d !== undefined && (porDominio.get(d) ?? 0) > 1) ||
      repiteNombre(i) ||
      (d !== undefined && (await yaVisto(d)));
    (esCadena ? cadenas : quedan).push(h);
  }
  return { quedan, cadenas };
}
