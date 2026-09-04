import { describe, it, expect, vi } from 'vitest';
import {
  documentosDelTurno,
  guardarDocumento,
  guardarDocumentoGenerado,
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
  // La fila va por el store; aca solo hace falta que no explote.
  guardarFila: async () => {},
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
    // Un formato SIN soporte de vision: guardarlo seria aceptar algo que el
    // agente nunca va a poder abrir. Las imagenes (jpg, png) SI se aceptan
    // desde que el agente las lee con vision; ver el describe de mas abajo.
    expect(tipoDe('animacion.svg')).toBeUndefined();
    expect(tipoDe('video.mp4')).toBeUndefined();
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

    // Nada por HTTP salvo el conversor: el archivo va al disco y la fila por
    // el store. Antes las dos cosas eran llamadas a Supabase.
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes('/convertir'))).toBe(true);
  });

  it('anota quien lo mando', async () => {
    const filas: Array<{ subidoPor: string; proyectoId: string }> = [];
    await guardarDocumento(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'a.txt', datos: new Uint8Array([1]) },
      { ...deps(todoOk()), guardarFila: async (f: never) => void filas.push(f) } as never,
    );
    // La columna es NOT NULL y referencia auth.users: sin esto la fila no entra.
    expect(filas[0]!.subidoPor).toBe(USUARIO);
    expect(filas[0]!.proyectoId).toBe(PROYECTO);
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
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'video.mp4', datos: new Uint8Array([1]) },
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
    const filas: unknown[] = [];

    await expect(
      guardarDocumento(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'a.txt', datos: new Uint8Array([1]) },
        { ...deps(f, true), guardarFila: async (x: never) => void filas.push(x) } as never,
      ),
    ).rejects.toThrow('no space left on device');
    expect(filas).toEqual([]);
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
        guardarFila: async () => {},
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

/**
 * Las imagenes se aceptan y NO se convierten.
 *
 * El agente tiene `Read`, que las procesa como imagen —vision nativa del SDK—
 * asi que no hace falta OCR ni conversor: ve el diagrama entero, no solo el
 * texto que tenga. Lo unico que faltaba era dejar de rechazarlas.
 */
describe('imagenes', () => {
  it('se reconocen los formatos que el modelo puede ver', () => {
    expect(tipoDe('captura.png')).toBe('png');
    expect(tipoDe('foto.JPG')).toBe('jpg');
    expect(tipoDe('diagrama.jpeg')).toBe('jpeg');
    expect(tipoDe('logo.webp')).toBe('webp');
  });

  it('un formato que el modelo no ve se sigue rechazando', () => {
    // Sin soporte de vision, guardarlo seria aceptar algo que el agente nunca
    // va a poder abrir.
    expect(tipoDe('animacion.svg')).toBeUndefined();
    expect(tipoDe('video.mp4')).toBeUndefined();
  });

  it('no se manda al conversor: no hay texto que sacar', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const escritos: string[] = [];

    const out = await guardarDocumento(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'captura.png', datos: new Uint8Array([1]) },
      { ...deps(f), escribir: async (r: string) => void escritos.push(r) } as never,
    );

    // Ni una llamada: el conversor no sabe leer imagenes y pedirle una
    // conversion que va a fallar deja un error anotado que no significa nada.
    expect(f).not.toHaveBeenCalled();
    expect(out.error).toBeUndefined();
    // Solo el original; no hay `.md` que escribir.
    expect(escritos).toEqual(['/srv/docs/' + PROYECTO + '/captura.png']);
  });

  it('un documento de texto sigue yendo al conversor', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ texto: '# hola' }), { status: 200 }));
    await guardarDocumento(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombreOriginal: 'pliego.pdf', datos: new Uint8Array([1]) },
      deps(f),
    );
    expect(f).toHaveBeenCalled();
  });
});


/**
 * Los documentos que ESCRIBE el agente.
 *
 * La direccion inversa de `guardarDocumento`: en vez de bytes que hay que
 * convertir a texto, llega texto (Markdown) que hay que convertir a bytes. Ver
 * `multicodigo-vm/docs/superpowers/specs/2026-09-04-documentos-generados-design.md`.
 */
describe('guardarDocumentoGenerado', () => {
  const MD = ['# Resolucion', '', 'Se resuelve.'].join(String.fromCharCode(10));

  /** Un conversor que devuelve bytes para `/generar`. */
  function conversorOk(bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])) {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/generar')) {
        return new Response(bytes as unknown as BodyInit, { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('le pide los bytes al conversor con el formato pedido', async () => {
    const f = conversorOk();
    await guardarDocumentoGenerado(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'sentencia', contenido: MD, formato: 'pdf' },
      deps(f),
    );

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain('/generar?formato=pdf');
    // El Markdown va como CUERPO: es la fuente del documento.
    expect(String((init as RequestInit).body)).toBe(MD);
  });

  it('guarda el original con el nombre saneado y la extension del formato', async () => {
    const escritos: string[] = [];
    const out = await guardarDocumentoGenerado(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'Sentencia Final', contenido: MD, formato: 'pdf' },
      { ...deps(conversorOk()), escribir: async (r: string) => void escritos.push(r) } as never,
    );

    expect(out.nombre).toBe('Sentencia-Final.pdf');
    expect(escritos).toContain(`/srv/docs/${PROYECTO}/Sentencia-Final.pdf`);
  });

  /**
   * El `.md` es el Markdown que escribio el agente, NO una reconversion del
   * binario.
   *
   * Es la propiedad que hace util este camino: el `.md` es la FUENTE. Pasar el
   * PDF de vuelta por el conversor perderia los titulos y las tablas para
   * recuperar un texto que ya estaba en la mano.
   */
  it('el .md es la fuente que escribio el agente, sin round-trip', async () => {
    const escrituras: Array<{ ruta: string; datos: Uint8Array }> = [];
    await guardarDocumentoGenerado(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'nota', contenido: MD, formato: 'pdf' },
      {
        ...deps(conversorOk()),
        escribir: async (ruta: string, datos: Uint8Array) => void escrituras.push({ ruta, datos }),
      } as never,
    );

    const md = escrituras.find((e) => e.ruta.endsWith('.md'))!;
    expect(new TextDecoder().decode(md.datos)).toBe(MD);
  });

  it('anota el origen y quien lo pidio', async () => {
    const filas: Array<Record<string, unknown>> = [];
    await guardarDocumentoGenerado(
      { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'nota', contenido: MD, formato: 'md' },
      { ...deps(conversorOk()), guardarFila: async (f: never) => void filas.push(f) } as never,
    );

    // `agente` es lo que hace que en la pantalla se distinga un documento que
    // escribio el bot de uno que subio la persona. Sin eso se ven identicos.
    expect(filas[0]!.origen).toBe('agente');
    // Y el usuario sigue siendo el de la persona cuyo turno lo produjo: la
    // columna es NOT NULL, y "lo pidio esta persona" es el dato verdadero.
    expect(filas[0]!.subidoPor).toBe(USUARIO);
  });

  /**
   * `md` y `txt` no necesitan al conversor.
   *
   * Es la degradacion que pide el diseño: con el conversor caido, los formatos
   * de texto se guardan igual. Perder una sentencia entera porque un
   * contenedor no responde, cuando el contenido ES el texto, seria absurdo.
   */
  for (const formato of ['md', 'txt']) {
    it(`${formato} se guarda sin pasar por el conversor`, async () => {
      const f = vi.fn(async () => new Response('no deberia llamarse', { status: 500 }));
      const out = await guardarDocumentoGenerado(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'nota', contenido: MD, formato },
        deps(f),
      );

      expect(f).not.toHaveBeenCalled();
      expect(out.nombre).toBe(`nota.${formato}`);
    });
  }

  it('un formato que el conversor no puede lo dice y NO escribe la fila', async () => {
    const filas: unknown[] = [];
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'este servidor no puede generar un .pdf' }), {
        status: 422,
      }),
    );

    await expect(
      guardarDocumentoGenerado(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'x', contenido: MD, formato: 'pdf' },
        { ...deps(f), guardarFila: async (x: never) => void filas.push(x) } as never,
      ),
    ).rejects.toThrow(/no puede generar/);

    // Sin fila: un documento que no se pudo generar no existe. Al reves que un
    // documento SUBIDO, donde el original se guarda aunque la conversion falle
    // —ahi hay un archivo de la persona que perder, y aca no hay nada.
    expect(filas).toEqual([]);
  });

  it('un contenido vacio no se guarda', async () => {
    await expect(
      guardarDocumentoGenerado(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'x', contenido: '   ', formato: 'md' },
        deps(conversorOk()),
      ),
    ).rejects.toThrow();
  });

  it('un formato desconocido no se guarda', async () => {
    await expect(
      guardarDocumentoGenerado(
        { proyectoId: PROYECTO, usuarioId: USUARIO, nombre: 'x', contenido: MD, formato: 'xlsx' },
        deps(conversorOk()),
      ),
    ).rejects.toThrow();
  });
});
