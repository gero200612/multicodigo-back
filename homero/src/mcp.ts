import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * Las herramientas de Homero, servidas por MCP a los agentes del fondo comun.
 *
 * El agente corre en un slot del gateway; sus herramientas viven aca, al lado
 * de la base y de las casillas. Lo que cruza es un pedido JSON-RPC por HTTP
 * (el gateway hace de pasamanos) y lo que vuelve es texto.
 *
 * Cada corrida abre una SESION con su token y su lista de herramientas. El
 * token muere al cerrar la corrida: un agente no puede seguir usando
 * herramientas despues de terminar, ni usar las de otra corrida.
 *
 * El protocolo esta escrito a mano y no con el SDK de MCP: es "Streamable HTTP"
 * sin estado y con respuestas JSON (sin SSE), que son cinco metodos. Una
 * dependencia mas para eso es mas superficie que el codigo que ahorra.
 */

/**
 * Un pedazo de lo que devuelve una herramienta, como lo define MCP. La imagen
 * va en base64: el SDK del agente se la pasa a Claude como imagen (asi el
 * revisor VE el anuncio, no una descripcion).
 */
export type Bloque = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Lo que hace una herramienta. Devuelve texto para el modelo, o bloques si lleva una imagen. */
export interface Herramienta<T = unknown> {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los argumentos, tal cual lo ve el modelo. */
  esquema: Record<string, unknown>;
  /** La validacion de verdad: el esquema de arriba es una sugerencia para el modelo. */
  validar: z.ZodType<T>;
  correr(args: T): Promise<string | Bloque[]>;
}

/** Un error que el agente tiene que leer (argumento malo, tope alcanzado). */
export class ErrorParaElAgente extends Error {}

/** Lo que un agente esta haciendo ahora, para el tablero de la web. */
export interface Actividad {
  agente: 'buscador' | 'vendedor' | 'atencion' | 'publicista' | 'revisor';
  corridaId: number;
  desde: Date;
  /** El negocio de la corrida, si es de uno (vendedor, atencion). */
  lead?: string;
  /** Lo que se le pidio, para el encabezado de la web: cantidad, rubro, zona. */
  pedido?: { cantidad?: number; rubro?: string; zona?: string };
  /** Cada herramienta que uso, en orden, con el dato que la identifica (la URL, el negocio...). */
  pasos: { herramienta: string; dato?: string; en: Date; error?: boolean }[];
}

/** Los pasos en vivo que se guardan por corrida: el tablero muestra los ultimos. */
const PASOS_EN_VIVO = 60;

/** El dato de un paso: lo que Gero reconoce (la URL, el negocio, el mail). Nunca el texto entero. */
function datoDe(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const k of ['url', 'nombre', 'email', 'rubro', 'motivo', 'zona', 'titulo']) {
    if (typeof a[k] === 'string' && a[k]) return String(a[k]).slice(0, 120);
  }
  return undefined;
}

interface Sesion {
  token: Buffer;
  herramientas: Map<string, Herramienta<any>>;
  actividad?: Actividad;
}

export class SesionesMcp {
  private readonly sesiones = new Map<string, Sesion>();

  /** Abre la sesion de una corrida y devuelve su token. */
  abrir(corrida: string, herramientas: Herramienta<any>[], actividad?: Omit<Actividad, 'pasos'>): string {
    const token = randomBytes(24).toString('base64url');
    this.sesiones.set(corrida, {
      token: Buffer.from(token),
      herramientas: new Map(herramientas.map((h) => [h.nombre, h])),
      actividad: actividad ? { ...actividad, pasos: [] } : undefined,
    });
    return token;
  }

  /** Lo que estan haciendo los agentes ahora mismo. */
  enCurso(): Actividad[] {
    return [...this.sesiones.values()].flatMap((s) => (s.actividad ? [s.actividad] : []));
  }

  cerrar(corrida: string): void {
    this.sesiones.delete(corrida);
  }

  /**
   * Usa una herramienta como lo haria el modelo por MCP: mismo token, misma
   * validacion. Lo usan los tests para hacer de agente.
   */
  async usar(
    corrida: string,
    token: string,
    nombre: string,
    args: unknown = {},
  ): Promise<{ texto: string; error: boolean; bloques: Bloque[] }> {
    const s = this.sesion(corrida, token);
    if (!s) return { texto: 'corrida desconocida o terminada', error: true, bloques: [] };
    const r = (await atender({ id: 1, method: 'tools/call', params: { name: nombre, arguments: args } }, s)) as {
      result?: { content: Bloque[]; isError?: boolean };
      error?: { message: string };
    };
    if (r.error) return { texto: r.error.message, error: true, bloques: [] };
    const bloques = r.result!.content;
    const texto = bloques.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    return { texto, error: r.result!.isError === true, bloques };
  }

  /** La sesion si el token es el de ESA corrida. */
  sesion(corrida: string, token: string | undefined): Sesion | undefined {
    const s = this.sesiones.get(corrida);
    if (!s || !token) return undefined;
    const dado = Buffer.from(token);
    if (dado.length !== s.token.length || !timingSafeEqual(dado, s.token)) return undefined;
    return s;
  }
}

interface PedidoRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOLO_POR_DEFECTO = '2025-03-26';
/** Lo que vuelve de una herramienta se recorta: el contexto del agente es finito. */
const LARGO_MAXIMO = 12_000;

async function atender(p: PedidoRpc, s: Sesion): Promise<Record<string, unknown> | undefined> {
  // Una notificacion no lleva id ni respuesta.
  if (p.id === undefined || p.id === null) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: p.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: p.id, error: { code, message } });

  switch (p.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof p.params?.protocolVersion === 'string' ? p.params.protocolVersion : PROTOCOLO_POR_DEFECTO,
        capabilities: { tools: {} },
        serverInfo: { name: 'homero', version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: [...s.herramientas.values()].map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          inputSchema: h.esquema,
        })),
      });
    case 'tools/call': {
      const nombre = typeof p.params?.name === 'string' ? p.params.name : '';
      const h = s.herramientas.get(nombre);
      if (!h) return error(-32602, `herramienta desconocida: ${nombre}`);
      const vivo = s.actividad
        ? { herramienta: nombre, dato: datoDe(p.params?.arguments), en: new Date(), error: false }
        : undefined;
      if (vivo && s.actividad) {
        s.actividad.pasos.push(vivo);
        if (s.actividad.pasos.length > PASOS_EN_VIVO) s.actividad.pasos.shift();
      }
      const args = h.validar.safeParse(p.params?.arguments ?? {});
      if (!args.success) {
        if (vivo) vivo.error = true;
        return ok({ content: [{ type: 'text', text: `Argumentos invalidos: ${args.error.message}` }], isError: true });
      }
      try {
        const salida = await h.correr(args.data);
        const recortar = (t: string) => (t.length > LARGO_MAXIMO ? `${t.slice(0, LARGO_MAXIMO)}\n[…recortado]` : t);
        const bloques: Bloque[] = typeof salida === 'string' ? [{ type: 'text', text: salida }] : salida;
        return ok({ content: bloques.map((b) => (b.type === 'text' ? { type: 'text', text: recortar(b.text) } : b)) });
      } catch (err) {
        // Al agente le llega el motivo de lo que el agente puede arreglar; el
        // resto es un error interno que no le dice nada util y queda en el log.
        if (vivo) vivo.error = true;
        const mensaje =
          err instanceof ErrorParaElAgente ? err.message : 'Error interno de Homero; probá otra cosa o cerrá.';
        if (!(err instanceof ErrorParaElAgente)) console.error(`[homero] mcp ${nombre}:`, err);
        return ok({ content: [{ type: 'text', text: mensaje }], isError: true });
      }
    }
    default:
      return error(-32601, `metodo no soportado: ${String(p.method)}`);
  }
}

/**
 * El servidor HTTP del MCP. Escucha en la red `enlace_homero`, donde solo esta
 * el gateway (y el panel, que no tiene tokens de corrida).
 */
export function crearServidorMcp(sesiones: SesionesMcp): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  app.post<{ Params: { corrida: string } }>('/mcp/:corrida', async (request, reply) => {
    const token = request.headers['x-mc-corrida-token'];
    const s = sesiones.sesion(request.params.corrida, typeof token === 'string' ? token : undefined);
    if (!s) return reply.code(401).send({ error: 'corrida desconocida o terminada' });

    const cuerpo = request.body as PedidoRpc | PedidoRpc[];
    if (Array.isArray(cuerpo)) {
      const respuestas = (await Promise.all(cuerpo.map((p) => atender(p, s)))).filter((r) => r !== undefined);
      if (respuestas.length === 0) return reply.code(202).send();
      return reply.code(200).header('content-type', 'application/json').send(respuestas);
    }
    const r = await atender(cuerpo ?? {}, s);
    if (!r) return reply.code(202).send();
    return reply.code(200).header('content-type', 'application/json').send(r);
  });

  // Sin estado y sin SSE: no hay stream que abrir ni sesion que borrar.
  app.get('/mcp/:corrida', async (_req, reply) => reply.code(405).send());
  app.delete('/mcp/:corrida', async (_req, reply) => reply.code(200).send());

  return app;
}
