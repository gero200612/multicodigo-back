import dnsCallback, { promises as dns, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

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

/**
 * El `lookup` que usa cada conexion: resuelve y RECHAZA si alguna direccion es
 * privada, en el mismo paso en que se conecta.
 *
 * Antes se resolvia el host para validarlo y despues `fetch` lo resolvia de
 * nuevo para conectarse: entre las dos consultas un DNS malicioso podia cambiar
 * la respuesta (DNS rebinding) y llevar la conexion a la red de la casa. Con el
 * agente eligiendo las URLs —que salen de webs de terceros— eso dejo de ser
 * teorico. Validando adentro del `lookup` no hay una segunda resolucion.
 */
export const lookupPublico: LookupFunction = (host, opciones, listo) => {
  dnsCallback.lookup(host, { ...opciones, all: true }, (err, direcciones) => {
    if (err) return listo(err, '', 0);
    const lista = direcciones as LookupAddress[];
    if (lista.length === 0 || lista.some((d) => esIpPrivada(d.address))) {
      return listo(new Error(`host no publico: ${host}`), '', 0);
    }
    if ((opciones as { all?: boolean }).all) return (listo as unknown as (e: null, l: LookupAddress[]) => void)(null, lista);
    listo(null, lista[0]!.address, lista[0]!.family);
  });
};

function hostProhibido(host: string): boolean {
  return host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) !== 0 && esIpPrivada(host));
}

/** Un GET con el `lookup` de arriba. Sin `fetch`: el de Node no deja pasar uno. */
function pedirPagina(url: URL): Promise<{ status: number; location?: string; tipo: string; cuerpo?: Buffer }> {
  return new Promise((resolve, reject) => {
    const pedir = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = pedir(
      url,
      {
        method: 'GET',
        lookup: lookupPublico,
        timeout: TIEMPO_MS,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; HomeroBot/1.0)', accept: 'text/html' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const tipo = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, tipo, location: res.headers.location });
        }
        if (status < 200 || status >= 300 || !tipo.includes('html')) {
          res.resume();
          return resolve({ status, tipo });
        }
        const partes: Buffer[] = [];
        let largo = 0;
        res.on('data', (c: Buffer) => {
          largo += c.length;
          if (largo > TAMANIO_MAXIMO) {
            partes.push(c);
            res.destroy();
            return resolve({ status, tipo, cuerpo: Buffer.concat(partes).subarray(0, TAMANIO_MAXIMO) });
          }
          partes.push(c);
        });
        res.on('end', () => resolve({ status, tipo, cuerpo: Buffer.concat(partes) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
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
    if (hostProhibido(url.hostname)) return undefined;
    let r;
    try {
      r = await pedirPagina(url);
    } catch {
      return undefined;
    }
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) return undefined;
      url = new URL(r.location, url);
      continue;
    }
    if (!r.cuerpo) return undefined;
    return new TextDecoder().decode(r.cuerpo);
  }
  return undefined;
};

/**
 * Los chats y bots que ya tiene la web. Se miran en el HTML CRUDO porque
 * vienen como scripts de terceros, que `textoDeHtml` saca.
 */
const CHATBOTS: [string, RegExp][] = [
  ['Tidio', /tidio/i],
  ['Intercom', /intercom/i],
  ['Zendesk', /zendesk|zopim/i],
  ['Crisp', /crisp\.chat/i],
  ['Tawk.to', /tawk\.to/i],
  ['ManyChat', /manychat/i],
  ['Botmaker', /botmaker/i],
  ['Landbot', /landbot/i],
  ['HubSpot chat', /js\.usemessages|hs-scripts/i],
  ['Drift', /js\.driftt|drift\.com/i],
  ['LiveChat', /livechatinc/i],
  ['Jivo', /jivosite|jivochat/i],
  ['Chatbase', /chatbase/i],
  ['Leadsales', /leadsales/i],
  ['un chatbot', /chat-?bot|asistente virtual|asistente de ia|atención automática/i],
];

export function chatbotsDeHtml(html: string): string[] {
  return CHATBOTS.filter(([, re]) => re.test(html)).map(([nombre]) => nombre);
}

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
): Promise<{ texto: string; mails: string[]; paginas: string[]; chatbots: string[] } | undefined> {
  const home = await bajar(web);
  if (!home) return undefined;
  let mails = mailsDeHtml(home, web);
  let texto = textoDeHtml(home);
  const chatbots = chatbotsDeHtml(home);
  const paginas = [web];
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
      paginas.push(url);
      texto += '\n' + textoDeHtml(pagina).slice(0, 2000);
      if (mails.length > 0) break;
    }
  }
  return { texto: texto.slice(0, 8000), mails, paginas, chatbots };
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
