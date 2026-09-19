import { describe, it, expect } from 'vitest';
import { conApiUrl, frontYBackDe } from '../src/conectar.js';

/**
 * Reescribir la URL del back en el config del front.
 *
 * Es lo UNICO de todo el sistema donde Punchi escribe codigo del cliente fuera
 * de una tarea, asi que el criterio es al reves del habitual: ante la duda, no
 * tocar. Un archivo que no matchea lo esperado se deja como esta y queda un
 * pendiente; nadie prefiere un config.js "arreglado" a medias.
 */
/**
 * El front de Angular, que es el que el sistema genera hoy.
 *
 * `reescribirConfig` buscaba UN solo archivo —`public/config.js`, del patron
 * viejo de express— asi que en un Angular devolvia `sin_config` y nadie
 * escribia nada. En `padel` eso llego a produccion como
 * `apiUrl: 'https://CAMBIAR-URL-DEL-BACK/api'`.
 */
describe('reescribir el apiUrl de un environment.ts', () => {
  const ANTES = [
    'export const environment = {',
    '  production: true,',
    '  // Ajustar en despliegue: URL publica del back, con el sufijo /api.',
    "  apiUrl: 'https://CAMBIAR-URL-DEL-BACK/api',",
    '};',
  ].join('\n');

  it('escribe la URL del back conservando el /api', () => {
    const r = conApiUrl(ANTES, 'https://padel-back-8my9.onrender.com');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // El sufijo NO se pierde: sin el, todas las llamadas irian a la raiz del
    // back y darian 404.
    expect(r.texto).toContain("apiUrl: 'https://padel-back-8my9.onrender.com/api',");
    expect(r.texto).toContain('production: true,');
    expect(r.texto).not.toContain('CAMBIAR-URL-DEL-BACK');
  });

  it('si ya apunta ahi, no cambia nada', () => {
    const ya = ANTES.replace('https://CAMBIAR-URL-DEL-BACK/api', 'https://b.onrender.com/api');
    const r = conApiUrl(ya, 'https://b.onrender.com');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.razon).toBe('igual');
  });

  it('un valor sin ruta no inventa sufijo', () => {
    const sinRuta = ANTES.replace('https://CAMBIAR-URL-DEL-BACK/api', 'http://localhost:5000');
    const r = conApiUrl(sinRuta, 'https://b.onrender.com');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain("apiUrl: 'https://b.onrender.com',");
  });
});

describe('reescribir window.API_URL', () => {
  it('cambia la URL y no toca el resto', () => {
    const antes = [
      '// Configuracion del front.',
      "window.API_URL = 'http://localhost:3000';",
      '',
      "window.OTRA_COSA = 'no me toques';",
    ].join('\n');

    const r = conApiUrl(antes, 'https://mesas-back.onrender.com');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain("window.API_URL = 'https://mesas-back.onrender.com';");
    expect(r.texto).toContain('// Configuracion del front.');
    expect(r.texto).toContain("window.OTRA_COSA = 'no me toques';");
    expect(r.texto).not.toContain('localhost');
  });

  it('acepta comillas dobles y espacios raros', () => {
    const r = conApiUrl('window.API_URL="http://localhost:3000"', 'https://x.onrender.com');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('https://x.onrender.com');
  });

  it('acepta la forma con var/const', () => {
    const r = conApiUrl("const API_URL = 'http://localhost:3000';", 'https://x.onrender.com');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain('https://x.onrender.com');
  });

  // Ante la duda no se toca: un archivo con otra forma puede estar haciendo
  // cualquier cosa, y una sustitucion a ciegas lo rompe.
  it('un archivo sin la asignacion no se toca', () => {
    const r = conApiUrl('export const config = { api: leerDeAlgunLado() };', 'https://x');
    expect(r.ok).toBe(false);
  });

  it('un archivo vacio no se toca', () => {
    expect(conApiUrl('', 'https://x').ok).toBe(false);
  });

  // Si ya apunta a donde tiene que apuntar, no hay nada que commitear: un
  // commit vacio ensucia la historia y dispara un deploy al pedo.
  it('si ya tiene la URL correcta, avisa que no hay nada que cambiar', () => {
    const texto = "window.API_URL = 'https://x.onrender.com';";
    const r = conApiUrl(texto, 'https://x.onrender.com');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('ya');
  });

  // Una URL con caracteres especiales no puede romper el archivo ni inyectar
  // codigo: lo que se escribe es un string literal.
  it('no deja escapar comillas en la URL', () => {
    const r = conApiUrl("window.API_URL = 'x';", "https://x'; alert(1); //");
    expect(r.ok).toBe(false);
  });
});

/**
 * Cual de los repos publicados es el front y cual el back.
 *
 * Por convencion de nombre, que es lo que el bot crea siempre. Sin los dos, no
 * se hace nada: adivinar cual de tres servicios es "el front" es como se
 * conectan cosas que no habia que conectar.
 */
describe('encontrar el front y el back', () => {
  const url = (n: string) => ({ repo: n, url: `https://${n}.onrender.com` });

  it('los reconoce por el sufijo', () => {
    const r = frontYBackDe([url('mesas-front'), url('mesas-back')]);
    expect(r?.front.repo).toBe('mesas-front');
    expect(r?.back.repo).toBe('mesas-back');
  });

  it('no le importa el orden', () => {
    const r = frontYBackDe([url('mesas-back'), url('mesas-front')]);
    expect(r?.front.repo).toBe('mesas-front');
  });

  it('sin front no devuelve nada', () => {
    expect(frontYBackDe([url('mesas-back')])).toBeUndefined();
  });

  it('sin back no devuelve nada', () => {
    expect(frontYBackDe([url('mesas-front')])).toBeUndefined();
  });

  it('sin nada publicado no devuelve nada', () => {
    expect(frontYBackDe([])).toBeUndefined();
  });

  // Un proyecto con tres servicios necesita otro diseño, y no existe todavia:
  // lo honesto es no hacer nada en vez de conectar dos al azar.
  it('con mas de un front no adivina', () => {
    const r = frontYBackDe([url('a-front'), url('b-front'), url('mesas-back')]);
    expect(r).toBeUndefined();
  });
});
