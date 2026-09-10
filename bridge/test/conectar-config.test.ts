import { describe, it, expect } from 'vitest';
import { CONFIG_DEL_FRONT, reescribirConfig, type ArchivosDelRepo } from '../src/conectar.js';
import { escribirArchivo, leerArchivo } from '../src/github-contenido.js';

const BACK = 'https://mesas-back.onrender.com';
const CONFIG = "// config del front\nwindow.API_URL = 'http://localhost:3000';\n";

/** Un repo de mentira con UN archivo, que anota lo que se le escribe. */
function repo(opciones: {
  texto?: string | null;
  leerFalla?: boolean;
  escribirFalla?: boolean;
}) {
  const escritos: Array<{ repo: string; ruta: string; texto: string; sha: string }> = [];
  const archivos: ArchivosDelRepo = {
    leer: async () => {
      if (opciones.leerFalla) return { ok: false, noExiste: false, motivo: 'GitHub contesto 500' };
      if (opciones.texto === null || opciones.texto === undefined) {
        return { ok: false, noExiste: true, motivo: 'no existe' };
      }
      return { ok: true, texto: opciones.texto, sha: 'sha-leido' };
    },
    escribir: async (repo, ruta, texto, sha) => {
      if (opciones.escribirFalla) return { ok: false, motivo: 'GitHub contesto 409' };
      escritos.push({ repo, ruta, texto, sha });
      return { ok: true };
    },
  };
  return { archivos, escritos };
}

describe('reescribirConfig', () => {
  it('apunta la URL al back y escribe con el sha que leyo', async () => {
    const { archivos, escritos } = repo({ texto: CONFIG });
    const r = await reescribirConfig('Sincro-arg/mesas-front', BACK, archivos);

    expect(r).toEqual({ estado: 'cambiado' });
    expect(escritos).toHaveLength(1);
    expect(escritos[0]!.ruta).toBe(CONFIG_DEL_FRONT);
    expect(escritos[0]!.repo).toBe('Sincro-arg/mesas-front');
    // El sha es lo que hace que GitHub rechace si el archivo cambio en el medio.
    expect(escritos[0]!.sha).toBe('sha-leido');
    expect(escritos[0]!.texto).toContain(`window.API_URL = '${BACK}'`);
    // Nada mas del archivo se toca.
    expect(escritos[0]!.texto).toContain('// config del front');
  });

  // Un commit que no cambia nada ensucia la historia y dispara un deploy inutil.
  it('si ya apunta al back no escribe nada', async () => {
    const { archivos, escritos } = repo({ texto: `window.API_URL = '${BACK}';` });
    expect(await reescribirConfig('o/r', BACK, archivos)).toEqual({ estado: 'igual' });
    expect(escritos).toHaveLength(0);
  });

  // Un front sin el archivo recibe la URL por otro lado: no hay nada que tocar.
  it('sin el archivo no escribe nada y no lo trata como error', async () => {
    const { archivos, escritos } = repo({ texto: null });
    expect(await reescribirConfig('o/r', BACK, archivos)).toEqual({ estado: 'sin_config' });
    expect(escritos).toHaveLength(0);
  });

  // Ante la duda no se toca: un config que arma la URL de otra forma puede
  // estar haciendo cualquier cosa, y una sustitucion a ciegas lo rompe.
  it('un config con otra forma no se toca', async () => {
    const { archivos, escritos } = repo({ texto: 'export default { api: leerDeAlgunLado() };' });
    expect(await reescribirConfig('o/r', BACK, archivos)).toEqual({ estado: 'sin_config' });
    expect(escritos).toHaveLength(0);
  });

  it('si no pudo leer, es un error y no escribe a ciegas', async () => {
    const { archivos, escritos } = repo({ leerFalla: true });
    const r = await reescribirConfig('o/r', BACK, archivos);
    expect(r.estado).toBe('error');
    expect(escritos).toHaveLength(0);
  });

  it('si la escritura falla lo dice con el motivo', async () => {
    const { archivos } = repo({ texto: CONFIG, escribirFalla: true });
    expect(await reescribirConfig('o/r', BACK, archivos)).toEqual({
      estado: 'error',
      motivo: 'GitHub contesto 409',
    });
  });
});

describe('github-contenido', () => {
  const TOKEN = 'ghs_token_secreto_de_la_app';

  it('lee y decodifica el archivo de main', async () => {
    let pedida = '';
    const r = await leerArchivo('o/r', 'public/config.js', {
      token: TOKEN,
      fetchImpl: (async (url: string) => {
        pedida = url;
        return new Response(
          JSON.stringify({ content: Buffer.from('hola').toString('base64'), sha: 'abc' }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(r).toEqual({ ok: true, texto: 'hola', sha: 'abc' });
    expect(pedida).toBe('https://api.github.com/repos/o/r/contents/public/config.js?ref=main');
  });

  it('un 404 es "no existe", no un error', async () => {
    const r = await leerArchivo('o/r', 'public/config.js', {
      token: TOKEN,
      fetchImpl: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, noExiste: true });
  });

  it('escribe en main con el sha y el contenido en base64, sin filtrar el token', async () => {
    let cuerpo: Record<string, unknown> = {};
    const r = await escribirArchivo('o/r', 'public/config.js', 'nuevo', 'abc', 'msg', {
      token: TOKEN,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 409 });
      }) as unknown as typeof fetch,
    });

    expect(cuerpo).toMatchObject({ sha: 'abc', branch: 'main', message: 'msg' });
    expect(Buffer.from(String(cuerpo.content), 'base64').toString('utf8')).toBe('nuevo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).not.toContain(TOKEN);
  });
});
