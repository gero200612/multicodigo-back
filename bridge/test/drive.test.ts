import { describe, it, expect, vi } from 'vitest';
import {
  accessToken,
  borrar,
  buscar,
  crear,
  editarPlanilla,
  escribir,
  leer,
  ErrorDeDrive,
  TokenRevocado,
  type DriveDeps,
} from '../src/drive.js';

/**
 * Los tests de Drive no tocan Google.
 *
 * Se le pasa un `fetchImpl` de mentira y se mira QUE PEDIDO se arma: es lo
 * unico que importa de este modulo. Un test contra la API de verdad probaria
 * la conexion a internet y ademas escribiria en el Drive de alguien.
 */
function conRespuesta(
  respuesta: { status?: number; json?: unknown; texto?: string },
  registro: { url?: string; init?: RequestInit } = {},
): DriveDeps {
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    registro.url = url.toString();
    registro.init = init;
    const cuerpo = respuesta.texto ?? JSON.stringify(respuesta.json ?? {});
    return new Response(cuerpo, {
      status: respuesta.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    clientId: 'id-de-prueba',
    clientSecret: 'secret-de-prueba',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe('accessToken', () => {
  it('devuelve el token que da Google', async () => {
    const deps = conRespuesta({ json: { access_token: 'ya29.abc' } });
    expect(await accessToken('refresh-1', deps)).toBe('ya29.abc');
  });

  // El caso que decide si la fila se borra o no. `invalid_grant` significa que
  // la persona revoco el acceso, y reintentarlo no lo va a arreglar nunca.
  it('distingue un token revocado de cualquier otra falla', async () => {
    const deps = conRespuesta({ status: 400, texto: '{"error":"invalid_grant"}' });
    await expect(accessToken('refresh-muerto', deps)).rejects.toBeInstanceOf(TokenRevocado);
  });

  it('un 500 de Google no es un token revocado', async () => {
    const deps = conRespuesta({ status: 500, texto: 'boom' });
    // La diferencia importa: esto NO tiene que borrar la fila de nadie.
    await expect(accessToken('refresh-1', deps)).rejects.not.toBeInstanceOf(TokenRevocado);
  });

  // El secret nunca se imprime, pero SI viaja en el cuerpo del POST: si no
  // viajara, Google contestaria invalid_client y el sintoma seria "te revocaron
  // el acceso" sobre una cuenta que esta perfecta.
  it('manda el client_id y el secret', async () => {
    const visto: { init?: RequestInit } = {};
    const deps = conRespuesta({ json: { access_token: 't' } }, visto);
    await accessToken('refresh-1', deps);
    const body = String(visto.init?.body);
    expect(body).toContain('client_id=id-de-prueba');
    expect(body).toContain('client_secret=secret-de-prueba');
    expect(body).toContain('grant_type=refresh_token');
  });
});

describe('buscar', () => {
  it('devuelve nombre, id y tipo', async () => {
    const deps = conRespuesta({
      json: { files: [{ id: 'f1', name: 'Balance 2026', mimeType: 'application/pdf' }] },
    });
    expect(await buscar('t', 'Balance', deps)).toEqual([
      { id: 'f1', nombre: 'Balance 2026', tipo: 'application/pdf' },
    ]);
  });

  it('un archivo que no esta es una lista vacia, no un error', async () => {
    const deps = conRespuesta({ json: { files: [] } });
    expect(await buscar('t', 'nada', deps)).toEqual([]);
  });

  // El nombre lo propone el MODELO, que es texto libre. Sin escapar, un
  // apostrofo rompe la query de Drive — y uno puesto a proposito la reescribe.
  it('escapa las comillas del nombre', async () => {
    const visto: { url?: string } = {};
    const deps = conRespuesta({ json: { files: [] } }, visto);
    await buscar('t', "Martin's ' or name contains '", deps);
    const q = new URL(visto.url!).searchParams.get('q')!;
    // Cada comilla del nombre quedo escapada, asi que la query sigue teniendo
    // exactamente dos comillas sin escapar: las que abren y cierran el literal.
    expect(q.match(/(?<!\\)'/g)).toHaveLength(2);
  });

  it('no busca en la papelera', async () => {
    const visto: { url?: string } = {};
    const deps = conRespuesta({ json: { files: [] } }, visto);
    await buscar('t', 'algo', deps);
    expect(new URL(visto.url!).searchParams.get('q')).toContain('trashed = false');
  });
});

describe('leer', () => {
  /** Dos respuestas seguidas: la de metadatos y la del contenido. */
  function conDos(primera: unknown, segunda: { texto: string; status?: number }): DriveDeps {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify(primera), { status: 200 });
      return new Response(segunda.texto, { status: segunda.status ?? 200 });
    });
    return {
      clientId: 'i',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
  }

  it('exporta un Google Doc como texto', async () => {
    const deps = conDos(
      { id: 'd1', name: 'Notas', mimeType: 'application/vnd.google-apps.document' },
      { texto: 'el contenido' },
    );
    expect(await leer('t', 'd1', deps)).toBe('el contenido');
  });

  // La regresion que costo un turno: `files.export` con text/csv devuelve SOLO
  // la primera hoja, y no avisa. El agente contesto "trae una sola hoja y no
  // puedo indicarle cual" sobre una planilla que tenia una pestaña "Debug".
  it('trae TODAS las hojas de una planilla, con el nombre de cada una', async () => {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(url.toString());
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({
            id: 's1',
            name: 'Sincro Status',
            mimeType: 'application/vnd.google-apps.spreadsheet',
          }),
        );
      }
      if (n === 2) {
        return new Response(
          JSON.stringify({
            sheets: [
              { properties: { title: 'Funcionalidades' } },
              { properties: { title: 'Debug' } },
            ],
          }),
        );
      }
      return new Response(
        JSON.stringify({
          valueRanges: [
            { values: [['item', 'estado'], ['login', 'ok']] },
            { values: [['bug', 'nota'], ['sesion, 24hs', 'se corta']] },
          ],
        }),
      );
    });
    const deps = { clientId: 'i', clientSecret: 's', fetchImpl: fetchImpl as unknown as typeof fetch };

    const texto = await leer('t', 's1', deps);

    // Las dos hojas, cada una con su titulo: sin el nombre el modelo no puede
    // citar de donde saco un dato ni saber que hay otra pestaña.
    expect(texto).toContain('## Funcionalidades');
    expect(texto).toContain('## Debug');
    expect(texto).toContain('login,ok');
    // Una celda con coma se cita, o parte la fila en dos columnas.
    expect(texto).toContain('"sesion, 24hs",se corta');
    // Y NO se usa la exportacion de Drive, que es la que perdia las hojas.
    expect(urls.join(' ')).not.toContain('text/csv');
    expect(urls.some((u) => u.includes('values:batchGet'))).toBe(true);
  });

  // Paso en produccion el mismo dia que se escribio `leerPlanilla`: la API de
  // Sheets se habilita POR SEPARADO en Google Cloud, y apagada contesta 403
  // aunque el archivo se lea perfecto por Drive. O sea que el cambio que traia
  // todas las hojas dejo de traer ninguna.
  it('si la API de Sheets esta apagada, cae a la primera hoja y lo AVISA', async () => {
    const urls: string[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(url.toString());
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ id: 's1', name: 'P', mimeType: 'application/vnd.google-apps.spreadsheet' }),
        );
      }
      if (n === 2) {
        return new Response(
          JSON.stringify({
            error: { code: 403, message: 'Google Sheets API has not been used in project 123' },
          }),
          { status: 403 },
        );
      }
      return new Response('item,estado\nlogin,ok');
    });
    const deps = { clientId: 'i', clientSecret: 's', fetchImpl: fetchImpl as unknown as typeof fetch };

    const texto = await leer('t', 's1', deps);

    // Las filas llegan: media planilla es muchisimo mejor que un error.
    expect(texto).toContain('login,ok');
    // Y el modelo se entera de que esta viendo una parte. Sin esto contesta
    // "no hay nada de eso" sobre una pestaña que nunca miro.
    expect(texto).toContain('PRIMERA HOJA');
    // Cayo a la exportacion de Drive, que no necesita la API de Sheets.
    expect(urls.some((u) => u.includes('text%2Fcsv') || u.includes('text/csv'))).toBe(true);
  });

  it('pide los valores de cada hoja por su nombre, citado', async () => {
    let batch = '';
    let n = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ id: 's1', name: 'P', mimeType: 'application/vnd.google-apps.spreadsheet' }),
        );
      }
      if (n === 2) {
        return new Response(JSON.stringify({ sheets: [{ properties: { title: "Menu 'online'" } }] }));
      }
      batch = url.toString();
      return new Response(JSON.stringify({ valueRanges: [{ values: [['a']] }] }));
    });
    const deps = { clientId: 'i', clientSecret: 's', fetchImpl: fetchImpl as unknown as typeof fetch };

    await leer('t', 's1', deps);

    // Un titulo con espacios necesita comillas para ser un rango valido, y la
    // comilla de adentro se duplica. Se lee el parametro y no la URL cruda:
    // URLSearchParams escribe el espacio como '+'.
    expect(new URL(batch).searchParams.getAll('ranges')).toEqual(["'Menu ''online'''"]);
  });

  it('baja un archivo de texto tal cual', async () => {
    const deps = conDos({ id: 't1', name: 'notas.md', mimeType: 'text/markdown' }, { texto: '# hola' });
    expect(await leer('t', 't1', deps)).toBe('# hola');
  });

  // "No pude leerlo" deja a la persona sin nada que hacer. El tipo adentro le
  // permite entender que pasa y decidir.
  it('dice el tipo cuando no sabe leerlo', async () => {
    const deps = conDos({ id: 'z1', name: 'cosas.zip', mimeType: 'application/zip' }, { texto: '' });
    await expect(leer('t', 'z1', deps)).rejects.toThrow(/application\/zip/);
  });

  // Con `drive.file`, "no existe" y "existe pero no me lo autorizaron" son el
  // mismo 404. El mensaje no puede afirmar el primero.
  it('un 404 no afirma que el archivo no exista', async () => {
    const deps = conRespuesta({ status: 404, texto: 'not found' });
    await expect(leer('t', 'x', deps)).rejects.toThrow(/no esta entre los que puedo ver/);
  });

  it('un 429 pide esperar y no reintenta', async () => {
    const visto: { url?: string } = {};
    const deps = conRespuesta({ status: 429, texto: 'slow down' }, visto);
    await expect(leer('t', 'x', deps)).rejects.toMatchObject({ code: 'esperar' });
  });
});

describe('escribir y crear', () => {
  it('escribir usa el endpoint de subida sobre el id', async () => {
    const visto: { url?: string; init?: RequestInit } = {};
    const deps = conRespuesta({ json: { id: 'f1', name: 'Informe', mimeType: 'text/plain' } }, visto);
    await escribir('t', 'f1', 'nuevo contenido', deps);
    expect(visto.url).toContain('/upload/drive/v3/files/f1');
    expect(visto.init?.method).toBe('PATCH');
    expect(visto.init?.body).toBe('nuevo contenido');
  });

  // Sin la parte de metadatos el archivo queda llamandose "Untitled", que es un
  // archivo que despues nadie encuentra.
  it('crear manda el nombre y el contenido', async () => {
    const visto: { url?: string; init?: RequestInit } = {};
    const deps = conRespuesta({ json: { id: 'n1', name: 'Informe', mimeType: 'text/plain' } }, visto);
    const a = await crear('t', 'Informe', 'cuerpo', deps);
    expect(visto.url).toContain('uploadType=multipart');
    expect(String(visto.init?.body)).toContain('"name":"Informe"');
    expect(String(visto.init?.body)).toContain('cuerpo');
    expect(a.id).toBe('n1');
  });
});

describe('editarPlanilla', () => {
  it('escribe el rango con USER_ENTERED', async () => {
    const visto: { url?: string; init?: RequestInit } = {};
    const deps = conRespuesta({ json: { updatedCells: 1 } }, visto);
    expect(await editarPlanilla('t', 'p1', 'Hoja1!D7', [['Listo']], deps)).toBe(1);
    expect(visto.url).toContain('sheets.googleapis.com');
    // USER_ENTERED es lo que hace que un "31/12" entre como fecha: con RAW
    // quedaria el texto, que no es lo que hubiera escrito una persona.
    expect(visto.url).toContain('valueInputOption=USER_ENTERED');
    expect(visto.init?.method).toBe('PUT');
    expect(String(visto.init?.body)).toContain('Listo');
  });

  // El rango va en la URL, y "Hoja 1!A1" tiene un espacio y un signo.
  it('encodea el rango', async () => {
    const visto: { url?: string } = {};
    const deps = conRespuesta({ json: { updatedCells: 2 } }, visto);
    await editarPlanilla('t', 'p1', 'Mi Hoja!A1:B1', [['a', 'b']], deps);
    expect(visto.url).toContain('Mi%20Hoja!A1%3AB1');
  });
});

describe('borrar', () => {
  // La prueba entera de esta funcion. `files.delete` no tiene deshacer; la
  // papelera de Drive es lo que en el worktree da git.
  it('manda a la papelera y no borra', async () => {
    const visto: { url?: string; init?: RequestInit } = {};
    const deps = conRespuesta({ json: { id: 'f1', name: 'Viejo', mimeType: 'text/plain' } }, visto);
    await borrar('t', 'f1', deps);
    expect(visto.init?.method).toBe('PATCH');
    expect(visto.init?.method).not.toBe('DELETE');
    expect(String(visto.init?.body)).toContain('"trashed":true');
  });
});

describe('errores', () => {
  it('un 403 comun es sin_permiso', async () => {
    const deps = conRespuesta({ status: 403, texto: 'forbidden' });
    await expect(buscar('t', 'x', deps)).rejects.toMatchObject({ code: 'sin_permiso' });
  });

  // Google manda el limite de tasa como 403 con un motivo adentro, no solo como
  // 429. Sin mirar el cuerpo, "espera un rato" se cuenta como "no tenes
  // permiso" y la persona va a revisar permisos que estan bien.
  it('un 403 de rate limit pide esperar', async () => {
    const deps = conRespuesta({ status: 403, texto: '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}' });
    await expect(buscar('t', 'x', deps)).rejects.toMatchObject({ code: 'esperar' });
  });

  it('los errores de Drive son ErrorDeDrive', async () => {
    const deps = conRespuesta({ status: 500, texto: 'boom' });
    await expect(buscar('t', 'x', deps)).rejects.toBeInstanceOf(ErrorDeDrive);
  });
});
