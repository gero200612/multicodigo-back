import type { Rubro } from './rubros.js';

/** Un negocio tal como lo devuelve una fuente, antes de leer su web. */
export interface Hallazgo {
  externo: string;
  nombre: string;
  web?: string;
  email?: string;
  telefono?: string;
  fuente: 'google' | 'osm';
}

export type Fuente = (rubro: Rubro, ciudad: string) => Promise<Hallazgo[]>;

/**
 * Google Places (Text Search). La mejor cobertura, pero pide una API key con
 * facturacion activada. El cupo gratis mensual alcanza para esto.
 */
export function fuenteGoogle(apiKey: string): Fuente {
  return async (rubro, ciudad) => {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        // Solo los campos que se usan: Google cobra por campo pedido.
        'x-goog-fieldmask': 'places.id,places.displayName,places.websiteUri,places.nationalPhoneNumber',
      },
      body: JSON.stringify({
        textQuery: `${rubro.busqueda} en ${ciudad}, Argentina`,
        languageCode: 'es',
        regionCode: 'AR',
        pageSize: 20,
      }),
    });
    if (!r.ok) throw new Error(`Google Places ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const cuerpo = (await r.json()) as {
      places?: { id: string; displayName?: { text?: string }; websiteUri?: string; nationalPhoneNumber?: string }[];
    };
    return (cuerpo.places ?? []).map((p) => ({
      externo: `google:${p.id}`,
      nombre: p.displayName?.text ?? 'Sin nombre',
      web: p.websiteUri,
      telefono: p.nationalPhoneNumber,
      fuente: 'google' as const,
    }));
  };
}

const SERVIDORES_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * OpenStreetMap por Overpass. Gratis y sin cuenta, con menos cobertura que
 * Google. Se piden solo los que tienen web o mail: sin eso no hay a quien
 * escribirle.
 */
export const fuenteOsm: Fuente = async (rubro, ciudad) => {
  const filtros = rubro.osm
    .map((f) => `nwr${f}[~"^(website|contact:website|email|contact:email)$"~"."](area.c);`)
    .join('\n');
  const consulta = `[out:json][timeout:60];
area["name"="${ciudad.replace(/"/g, '')}"]["boundary"="administrative"]->.c;
(
${filtros}
);
out tags 60;`;
  // El servidor principal da 504 seguido cuando esta cargado: se prueban
  // espejos en orden hasta que uno conteste.
  let r: Response | undefined;
  let ultimoError = '';
  for (const servidor of SERVIDORES_OVERPASS) {
    try {
      r = await fetch(servidor, {
        method: 'POST',
        signal: AbortSignal.timeout(90_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'HomeroBot/1.0' },
        body: new URLSearchParams({ data: consulta }),
      });
      if (r.ok) break;
      ultimoError = `${servidor} ${r.status}`;
    } catch (err) {
      ultimoError = `${servidor} ${err instanceof Error ? err.message : String(err)}`;
    }
    r = undefined;
  }
  if (!r) throw new Error(`Overpass no contesto: ${ultimoError}`);
  const cuerpo = (await r.json()) as {
    elements?: { type: string; id: number; tags?: Record<string, string> }[];
  };
  return (cuerpo.elements ?? [])
    .filter((e) => e.tags?.name)
    .map((e) => {
      const t = e.tags!;
      return {
        externo: `osm:${e.type}/${e.id}`,
        nombre: t.name!,
        web: t.website ?? t['contact:website'],
        email: (t.email ?? t['contact:email'])?.split(/[;,\s]/)[0]?.toLowerCase(),
        telefono: t.phone ?? t['contact:phone'],
        fuente: 'osm' as const,
      };
    });
};

/**
 * El link publico a la ficha de donde salio un negocio, para que Gero pueda
 * ver de donde saco Homero la informacion.
 */
export function linkDeFicha(externo: string | undefined): string | undefined {
  if (!externo) return undefined;
  if (externo.startsWith('osm:')) return `https://www.openstreetmap.org/${externo.slice(4)}`;
  if (externo.startsWith('google:')) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(externo.slice(7))}`;
  }
  return undefined;
}
