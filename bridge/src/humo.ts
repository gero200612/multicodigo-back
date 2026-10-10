/**
 * La prueba de humo de un back RECIEN publicado: entra con el usuario de
 * prueba y le pega a cada GET del contrato.
 *
 * Existe por Prueba_completa (2026-10-10). /health daba 200 y el deploy quedo
 * "andando", pero /api/pacientes y /api/turnos contestaban 500: las tablas no
 * existian porque la migracion no se aplico. Los tests del back corrian contra
 * una base en memoria, todos en verde, y nadie le pego a lo publicado.
 *
 * Solo GET y solo sin `{id}`: no escribe en la base de nadie, y una ruta con id
 * necesita un id real. Lo que cuenta como falla es un 5xx o que no conteste: un
 * 400 o un 404 pueden ser exactamente lo que dice el contrato.
 */

export interface Falla {
  ruta: string;
  /** 0 = no contesto. */
  status: number;
  cuerpo: string;
}

export interface ResultadoDeHumo {
  probadas: number;
  /** Si pudo hacer login. Sin login, las rutas protegidas dan 401 y no prueban nada. */
  entro: boolean;
  fallas: Falla[];
}

/** Los GET del contrato que se pueden pedir sin inventar nada. */
export function rutasDeHumo(contrato: string | undefined, hoy: Date): string[] {
  if (!contrato) return [];
  const fecha = hoy.toISOString().slice(0, 10);
  const rutas: string[] = [];
  for (const linea of contrato.split('\n')) {
    const m = /^\s*GET\s+(\/\S*)/.exec(linea);
    if (!m) continue;
    const [camino, query = ''] = m[1]!.split('?');
    if (!camino || camino.includes('{')) continue;
    // De la query solo quedan las fechas, que son las que suelen ser
    // obligatorias ("fecha" en turnos). El resto es filtro opcional.
    const params = query
      .split('&')
      .filter((p) => /=YYYY-MM-DD$/.test(p))
      .map((p) => p.replace('YYYY-MM-DD', fecha));
    const ruta = params.length > 0 ? `${camino}?${params.join('&')}` : camino;
    if (!rutas.includes(ruta)) rutas.push(ruta);
  }
  return rutas;
}

export function rutaDeLogin(contrato: string | undefined): string | undefined {
  return /^\s*POST\s+(\/\S*login\S*)/im.exec(contrato ?? '')?.[1];
}

/**
 * Con que usuario se entra: la cuenta de demo si la hay, y si no el usuario de
 * prueba que fija el pliego ("admin@x.com / Clave123!").
 */
export function credencialesDeHumo(p: {
  demo?: { email: string; password: string };
  md?: string;
  contrato?: string;
}): { email: string; password: string } | undefined {
  if (p.demo) return p.demo;
  for (const texto of [p.contrato, p.md]) {
    const m = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s*(?:\/|,|\||contrase(?:ñ|n)a:?|password:?)\s*([^\s,;)]+)/i.exec(texto ?? '');
    if (m) return { email: m[1]!, password: m[2]! };
  }
  return undefined;
}

const TECHO_MS = 20_000;
const TOPE_DE_CUERPO = 300;

export async function probarEnVivo(p: {
  backUrl: string;
  contrato: string | undefined;
  md: string;
  demo?: { email: string; password: string };
  hoy: Date;
  fetchImpl?: typeof fetch;
}): Promise<ResultadoDeHumo> {
  const f = p.fetchImpl ?? fetch;
  const base = p.backUrl.replace(/\/$/, '');
  const pedir = async (ruta: string, init: RequestInit = {}): Promise<{ status: number; cuerpo: string }> => {
    try {
      const res = await f(`${base}${ruta}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TECHO_MS) });
      return { status: res.status, cuerpo: (await res.text()).slice(0, TOPE_DE_CUERPO) };
    } catch (err) {
      return { status: 0, cuerpo: `no contesto: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  let token: string | undefined;
  const login = rutaDeLogin(p.contrato);
  const cred = credencialesDeHumo({ ...(p.demo ? { demo: p.demo } : {}), md: p.md, ...(p.contrato ? { contrato: p.contrato } : {}) });
  if (login && cred) {
    const r = await pedir(login, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: cred.email, password: cred.password }),
    });
    try {
      const j = JSON.parse(r.cuerpo) as Record<string, unknown>;
      const t = j['token'] ?? j['accessToken'] ?? j['access_token'];
      if (typeof t === 'string') token = t;
    } catch {
      // Sin token: se prueba igual, y `entro` lo dice.
    }
  }

  const rutas = rutasDeHumo(p.contrato, p.hoy);
  const fallas: Falla[] = [];
  for (const ruta of rutas) {
    const r = await pedir(ruta, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    if (r.status === 0 || r.status >= 500) fallas.push({ ruta, ...r });
  }
  return { probadas: rutas.length, entro: token !== undefined || !login, fallas };
}

/** Para el estado del deploy, el informe y la tarea que lo arregla. */
export function textoDeFallas(r: ResultadoDeHumo, log?: string): string {
  const lineas = [
    `El back publicado responde /health pero falla en ${r.fallas.length} de ${r.probadas} rutas del contrato:`,
    ...r.fallas.map((x) => `- GET ${x.ruta} -> ${x.status || 'no contesta'}: ${x.cuerpo.replace(/\s+/g, ' ').slice(0, 150)}`),
  ];
  if (log) lineas.push('', 'Lo ultimo que dice el log del back publicado:', log);
  return lineas.join('\n');
}
