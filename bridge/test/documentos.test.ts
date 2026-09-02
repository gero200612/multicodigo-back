import { describe, it, expect, vi } from 'vitest';
import {
  documentosDelTurno,
  guardarDocumento,
  nombreDeArchivo,
  tipoDe,
  MAXIMO_BYTES,
} from '../src/documentos.js';

/**
 * Las deps con el disco falso.
 *
 * `escribir` puede fallar a pedido: es lo que reemplaza al "Storage devolvio
 * 507" de cuando los archivos se subian a un bucket, y prueba lo mismo — que
 * la fila no se escriba si el archivo no se pudo guardar.
 */
const deps = (fetchImpl: unknown, fallaEscribir = false) => ({
  supabaseUrl: 'https://proj.supabase.co',
  serviceKey: 'service-role-secreta',
  conversorUrl: 'http://conversor:8096',
  docsRaiz: '/srv/docs',
  crearDir: async () => {},
  escribir: async () => {
    if (fallaEscribir) throw new Error('no space left on device');
  },
  fetchImpl: fetchImpl as never,
});

const PROYECTO = '11111111-1111-4111-8111-111111111111';
const USUARIO = '22222222-2222-4222-8222-222222222222';

describe('tipoDe', () => {
  it('acepta lo que el conversor sabe leer', () => {
    expect(tipoDe('pliego.pdf')).toBe('pdf');
    expect(tipoDe('PRECIOS.XLSX')).toBe('xlsx');
  });

  it('rechaza lo que no', () => {
    // Una foto no tiene texto que sacar, y aceptarla seria guardar algo que el
    // agente nunca va a poder leer.
    expect(tipoDe('foto.jpg')).toBeUndefined();
    expect(tipoDe('sinextension')).toBeUndefined();
    expect(tipoDe(undefined)).toBeUndefined();
  });
});

describe('nombreDeArchivo', () => {
  it('no deja escapar de _docs', () => {
    // Lo que protege el disco del servidor: el nombre lo elige quien manda el
    // archivo, y termina siendo una ruta en /srv/work.
    expect(nombreDeArchivo('../../etc/passwd.txt', 'txt')).toBe('passwd.txt');
    expect(nombreDeArchivo('..\\\\..\\\\windows\\\\system.txt', 'txt')).toBe('system.txt');
    expect(nombreDeArchivo('.', 'txt')).toBe('documento.txt');
    expect(nombreDeArchivo('', 'md')).toBe('documento.md');
  });

  it('conserva los acentos como su letra base', () => {
    // "especificación" tiene que quedar "especificacion", no "especificacin".
    expect(nombreDeArchivo('especificación final.pdf', 'pdf')).toBe('especificacion-final.pdf');
  });

  it('colapsa los guiones que salen de limpiar', () => {
    expect(nombreDeArchivo('informe (final) v2.docx', 'docx')).toBe('informe-final-v2.docx');
  });

  it('siempre deja la extension', () => {
    // Sin ella el agente ve el binario como texto e intenta leerlo.
    expect(nombreDeArchivo('precios', 'csv')).toBe('precios.csv');
    // Y no la duplica cuando ya estaba.
    expect(nombreDeArchivo('precios.csv', 'csv')).toBe('precios.csv');
  });
});

describe('guardarDocumento', () => {
  /** Un fetch que contesta bien a las tres llamadas: conversor, storage, fila. */
  function todoOk() {
    return vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/convertir')) {
        return new Response(JSON.stringify({ texto: '# El pliego' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('sube el original, el texto y escribe la fila', async () => {
    const f = todoOk();
    const out = await guardarDocumento(
      {
        proyectoId: PROYECTO,
        usuarioId: USUARIO,
        nombreOriginal: 'Pliego Final.pdf',
        datos: new Uint8Array([1, 2, 3]),
      },
      deps(f),
    );

    // Se conserva la capitalizacion, igual que en el panel: el nombre se
    // sanea para que sea una ruta segura, no se normaliza.
    expect(out.nombre).toBe('Pliego-Final.pdf');
    expect(out.error).toBeUndefined();

    // Solo la fila va por HTTP; el archivo se escribe en el disco.
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://proj.supabase.co/rest/v1/documentos');
    expect(urls.some((u) => u.includes('/storage/v1'))).toBe(false);
  });

  it('anota quien lo mando', async () => {
    const f = todoOk();
    await guardarDocumento(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'a.txt', datos: new Uint8Array([1]) },
      deps(f),
    );
    const fila = f.mock.calls.find((c) => String(c[0]).includes('/rest/v1/documentos'))!;
    const cuerpo = JSON.parse(fila[1]!.body as string);
    // La columna es NOT NULL y referencia auth.users: sin esto la fila no entra.
    expect(cuerpo.subido_por).toBe(USUARIO);
    expect(cuerpo.proyecto_id).toBe(PROYECTO);
  });

  it('guarda igual el documento que no se pudo convertir', async () => {
    // El original se puede descargar del panel y la conversion se reintenta.
    // Perder el archivo que la persona ya mando es peor.
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/convertir')) {
        return new Response(JSON.stringify({ message: 'el PDF es un escaneo' }), { status: 422 });
      }
      return new Response('{}', { status: 200 });
    });

    const escritos: string[] = [];
    const out = await guardarDocumento(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'escaneo.pdf', datos: new Uint8Array([1]) },
      { ...deps(f), escribir: async (ruta: string) => void escritos.push(ruta) } as never,
    );

    expect(out.error).toBe('el PDF es un escaneo');
    // El original se escribio; el .md no, porque no hay texto.
    expect(escritos.some((r) => r.endsWith('escaneo.pdf'))).toBe(true);
    expect(escritos.some((r) => r.endsWith('escaneo.pdf.md'))).toBe(false);
  });

  it('rechaza un tipo que no se sabe leer, sin subir nada', async () => {
    const f = todoOk();
    await expect(
      guardarDocumento(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'foto.jpg', datos: new Uint8Array([1]) },
        deps(f),
      ),
    ).rejects.toThrow('tipo_desconocido');
    expect(f).not.toHaveBeenCalled();
  });

  it('rechaza un archivo mas grande que el tope', async () => {
    const f = todoOk();
    await expect(
      guardarDocumento(
        {
          proyectoId: PROYECTO,
          usuarioId: USUARIO,
          nombreOriginal: 'grande.pdf',
          datos: new Uint8Array(MAXIMO_BYTES + 1),
        },
        deps(f),
      ),
    ).rejects.toThrow('muy_grande');
    expect(f).not.toHaveBeenCalled();
  });

  it('no escribe la fila si el archivo no se pudo guardar', async () => {
    // Una fila que apunta a un archivo que no esta hace fallar el turno
    // siguiente al copiarlo al worktree.
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/convertir')) {
        return new Response(JSON.stringify({ texto: 'x' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    await expect(
      guardarDocumento(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'a.txt', datos: new Uint8Array([1]) },
        deps(f, true),
      ),
    ).rejects.toThrow('no space left on device');
    expect(f.mock.calls.some((c) => String(c[0]).includes('/rest/v1/documentos'))).toBe(false);
  });
});

describe('documentosDelTurno', () => {
  /**
   * La ruta viaja tal cual: no se firma nada.
   *
   * El gateway lee el archivo del disco —el panel lo dejo en un directorio que
   * los dos montan— asi que firmar una URL de Storage por documento era mandar
   * un archivo a internet para traerlo de vuelta entre dos procesos de la misma
   * maquina.
   */
  it('devuelve las rutas del disco, sin firmar nada', async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/rest/v1/documentos')) {
        return new Response(
          JSON.stringify([
            { nombre: 'pliego.pdf', ruta: `${PROYECTO}/pliego.pdf`, ruta_texto: `${PROYECTO}/pliego.pdf.md` },
          ]),
          { status: 200 },
        );
      }
      throw new Error('no deberia pedir nada mas: firmar una URL ya no existe');
    });

    const docs = await documentosDelTurno(PROYECTO, deps(f));

    expect(docs).toEqual([
      {
        nombre: 'pliego.pdf',
        ruta: `${PROYECTO}/pliego.pdf`,
        ruta_texto: `${PROYECTO}/pliego.pdf.md`,
      },
    ]);
    // Una sola llamada: la de leer la tabla. Antes eran tres.
    expect(f).toHaveBeenCalledTimes(1);
  });

  // Un documento sin conversion a texto viaja igual: el agente no lo puede
  // leer, pero lo puede citar.
  it('un documento sin .md viaja con ruta_texto en null', async () => {
    const f = vi.fn(async () =>
      new Response(
        JSON.stringify([{ nombre: 'foto.pdf', ruta: `${PROYECTO}/foto.pdf`, ruta_texto: null }]),
        { status: 200 },
      ),
    );
    const docs = await documentosDelTurno(PROYECTO, deps(f));
    expect(docs).toEqual([{ nombre: 'foto.pdf', ruta: `${PROYECTO}/foto.pdf`, ruta_texto: null }]);
  });

  it('devuelve vacio si Supabase no contesta, sin tirar', async () => {
    // Sin documentos el turno corre igual. Cortarlo porque no se pudo firmar
    // una URL seria cambiar una degradacion por una caida.
    const f = vi.fn(async () => {
      throw new Error('sin red');
    });
    await expect(documentosDelTurno(PROYECTO, deps(f))).resolves.toEqual([]);
  });
});

/**
 * Un archivo mandado al bot va al DISCO, igual que uno subido por el panel.
 *
 * Los dos caminos tienen que terminar en el mismo lugar: `_docs` del worktree.
 * Cuando el panel dejo de usar Supabase Storage, este camino quedo escribiendo
 * en el bucket —o sea, en un lugar que el gateway ya no mira— y un archivo
 * mandado por Telegram se guardaba sin que el agente lo viera nunca.
 */
describe('guardarDocumento: al disco, no a Storage', () => {
  const ENTRADA = {
    proyectoId: PROYECTO,
    usuarioId: '11111111-1111-4111-8111-111111111111',
    nombreOriginal: 'pliego.pdf',
    datos: new Uint8Array([1, 2, 3]),
  };

  function conEscritura() {
    const escritos: Array<{ ruta: string; datos: Uint8Array }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      // La fila en la tabla sigue yendo por REST; lo que no puede pasar es un
      // POST a /storage/v1.
      if (String(url).includes('/storage/v1')) {
        throw new Error('no deberia tocar Storage: los archivos van al disco');
      }
      return new Response('[]', { status: 201 });
    });
    return {
      escritos,
      deps: {
        supabaseUrl: 'https://proj.supabase.co',
        serviceKey: 'k',
        docsRaiz: '/srv/docs',
        crearDir: async () => {},
        escribir: async (ruta: string, datos: Uint8Array) => {
          escritos.push({ ruta, datos });
        },
        fetchImpl,
      },
    };
  }

  it('escribe el archivo bajo la raiz de documentos', async () => {
    const { deps, escritos } = conEscritura();
    await guardarDocumento(ENTRADA, deps as never);

    expect(escritos[0]!.ruta).toBe(`/srv/docs/${PROYECTO}/pliego.pdf`);
    expect(escritos[0]!.datos).toEqual(ENTRADA.datos);
  });

  // El mismo nombre dos veces reemplaza, no acumula: la fila hace upsert y las
  // dos mitades tienen que quedar iguales.
  it('el mismo archivo dos veces se sobrescribe', async () => {
    const { deps, escritos } = conEscritura();
    await guardarDocumento(ENTRADA, deps as never);
    await guardarDocumento(ENTRADA, deps as never);

    expect(escritos).toHaveLength(2);
    expect(escritos[0]!.ruta).toBe(escritos[1]!.ruta);
  });
});
