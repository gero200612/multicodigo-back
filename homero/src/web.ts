import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Leer la web de un negocio.
 *
 * Las URLs vienen de Google u OpenStreetMap, o sea de terceros: se pide solo
 * http(s), a hosts publicos, con tiempo y tamaño acotados. Sin esto una ficha
 * con `http://192.168.0.1` haria que Homero le pegue a la red de la casa.
 */

const TIEMPO_MS = 10_000;
const TAMANIO_MAXIMO = 600_000;

export function esIpPrivada(ip: string): boolean {
  if (isIP(ip) === 6) {
    const t = ip.toLowerCase();
    return t === '::1' || t.startsWith('fc') || t.startsWith('fd') || t.startsWith('fe80') || t === '::' ||
      (t.startsWith('::ffff:') && esIpPrivada(t.slice(7)));
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4) return true;
  const [a, b] = p as [number, number];
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  );
}

async function hostPublico(host: string): Promise<boolean> {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host)) return !esIpPrivada(host);
  try {
    const ips = await dns.lookup(host, { all: true });
    return ips.length > 0 && ips.every((i) => !esIpPrivada(i.address));
  } catch {
    return false;
  }
}

export type Buscador = (url: string) => Promise<string | undefined>;

/** Baja el HTML de una pagina, o `undefined` si no se puede o no se debe. */
export const bajarPagina: Buscador = async (crudo) => {
  let url: URL;
  try {
    url = new URL(crudo.startsWith('http') ? crudo : `https://${crudo}`);
  } catch {
    return undefined;
  }
  // Redirecciones a mano: cada salto se vuelve a validar.
  for (let saltos = 0; saltos < 4; saltos++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!(await hostPublico(url.hostname))) return undefined;
    let r: Response;
    try {
      r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIEMPO_MS),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; HomeroBot/1.0)', accept: 'text/html' },
      });
    } catch {
      return undefined;
    }
    if (r.status >= 300 && r.status < 400) {
      const destino = r.headers.get('location');
      if (!destino) return undefined;
      url = new URL(destino, url);
      continue;
    }
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('html')) return undefined;
    const buf = await r.arrayBuffer();
    return new TextDecoder().decode(buf.slice(0, TAMANIO_MAXIMO));
  }
  return undefined;
};

/** El texto visible de un HTML, sin scripts ni estilos. */
export function textoDeHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_ENTERO = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const FALSOS = /\.(png|jpe?g|gif|webp|svg)$|example\.|sentry|wixpress|domain\.com|tudominio|email\.com$|@2x/i;

/**
 * Los mails que aparecen en una pagina, los del propio dominio primero: un
 * `info@negocio.com` es mejor que el mail del diseñador de la web.
 */
export function mailsDeHtml(html: string, web?: string): string[] {
  const hallados = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) hallados.add(decodeURIComponent(m[1]!).toLowerCase());
  for (const m of textoDeHtml(html).matchAll(EMAIL)) hallados.add(m[0].toLowerCase());
  const validos = [...hallados].filter((e) => EMAIL_ENTERO.test(e) && !FALSOS.test(e));
  let dominio = '';
  try {
    dominio = web ? new URL(web.startsWith('http') ? web : `https://${web}`).hostname.replace(/^www\./, '') : '';
  } catch {
    // web rara: sin preferencia de dominio
  }
  return validos.sort((a, b) => Number(b.endsWith(`@${dominio}`)) - Number(a.endsWith(`@${dominio}`)));
}

/**
 * Lee la home y, si no hay mail, la pagina de contacto. Devuelve el texto para
 * la IA y los mails encontrados.
 */
export async function leerSitio(
  web: string,
  bajar: Buscador = bajarPagina,
): Promise<{ texto: string; mails: string[] } | undefined> {
  const home = await bajar(web);
  if (!home) return undefined;
  let mails = mailsDeHtml(home, web);
  let texto = textoDeHtml(home);
  if (mails.length === 0) {
    const base = web.startsWith('http') ? web : `https://${web}`;
    for (const ruta of ['/contacto', '/contact', '/contactanos', '/contacto/']) {
      let url: string;
      try {
        url = new URL(ruta, base).toString();
      } catch {
        break;
      }
      const pagina = await bajar(url);
      if (!pagina) continue;
      mails = mailsDeHtml(pagina, web);
      texto += '\n' + textoDeHtml(pagina).slice(0, 2000);
      if (mails.length > 0) break;
    }
  }
  return { texto: texto.slice(0, 8000), mails };
}

/** `true` si el dominio recibe mail. Evita rebotes, que queman la casilla. */
export async function recibeMail(email: string): Promise<boolean> {
  const dominio = email.split('@')[1];
  if (!dominio) return false;
  try {
    return (await dns.resolveMx(dominio)).length > 0;
  } catch {
    return false;
  }
}
