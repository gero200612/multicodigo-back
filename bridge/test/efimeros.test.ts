import { describe, expect, it } from 'vitest';
import { conEfimeros, linksDelProyecto, type MensajesDelChat } from '../src/pipeline.js';

function chat() {
  const vistos: { id: number; texto: string }[] = [];
  const borrados: number[] = [];
  const comunes: string[] = [];
  let n = 0;
  const mensajes: MensajesDelChat = {
    enviar: async (_c, texto) => {
      vistos.push({ id: ++n, texto });
      return n;
    },
    borrar: async (_c, id) => void borrados.push(id),
  };
  return { vistos, borrados, comunes, mensajes, avisarComun: async (t: string) => void comunes.push(t) };
}

describe('los mensajes de estado de la corrida', () => {
  it('"Analizando visual…" se borra cuando llega "Analizando funcional…", y ese con el siguiente aviso', async () => {
    const c = chat();
    const avisar = conEfimeros(1, c.avisarComun, c.mensajes);
    await avisar('🔍 Analizando visual…', { efimero: true });
    await avisar('🔍 Analizando funcional…', { efimero: true });
    expect(c.borrados).toEqual([1]);
    await avisar('Los cuatro firmaron.');
    expect(c.borrados).toEqual([1, 2]);
    expect(c.comunes).toEqual(['Los cuatro firmaron.']);
    // Un aviso comun sin estado pendiente no borra nada.
    await avisar('Otro aviso.');
    expect(c.borrados).toEqual([1, 2]);
  });

  it('sin forma de borrar (tests, sin bot) el de estado sale como aviso comun', async () => {
    const c = chat();
    const avisar = conEfimeros(1, c.avisarComun);
    await avisar('🔍 Analizando visual…', { efimero: true });
    expect(c.comunes).toEqual(['🔍 Analizando visual…']);
  });

  it('si Telegram no deja borrar, la corrida sigue igual', async () => {
    const c = chat();
    const avisar = conEfimeros(1, c.avisarComun, { ...c.mensajes, borrar: async () => Promise.reject(new Error('400')) });
    await avisar('🔍 Analizando visual…', { efimero: true });
    await expect(avisar('Listo.')).resolves.toBeUndefined();
    expect(c.comunes).toEqual(['Listo.']);
  });
});

describe('los links al cerrar la corrida', () => {
  const store = {
    idDeProyecto: async (p: string) => (p === 'TallerPro' ? 'p1' : null),
    reposDeProyecto: async () => [
      { nombre: 'TallerPro-front', github_repo: 'Sincro-arg/TallerPro-front', solo_lectura: false, destino_url: 'https://tallerpro.apps.punchi.dev', render_url: null },
      { nombre: 'TallerPro-back', github_repo: 'Sincro-arg/TallerPro-back', solo_lectura: false, destino_url: 'https://tallerpro-api.apps.punchi.dev', render_url: null },
      { nombre: 'referencia-sincroresto-front', github_repo: 'Sincro-arg/referencia-sincroresto-front', solo_lectura: true, destino_url: null, render_url: null },
    ],
  } as never;

  it('trae la app publicada y el código de cada repo propio; los de referencia no', async () => {
    const t = await linksDelProyecto('TallerPro', [], { store });
    expect(t).toContain('<b>Links:</b>');
    expect(t).toContain('TallerPro-front → https://tallerpro.apps.punchi.dev');
    expect(t).toContain('TallerPro-back → https://tallerpro-api.apps.punchi.dev');
    expect(t).toContain('https://github.com/Sincro-arg/TallerPro-front');
    expect(t).not.toContain('referencia');
  });

  it('no repite la URL que el informe ya muestra en "Publicado"', async () => {
    const t = await linksDelProyecto('TallerPro', [{ url: 'https://tallerpro.apps.punchi.dev' }], { store });
    expect(t).not.toContain('TallerPro-front → https://tallerpro.apps.punchi.dev');
    expect(t).toContain('TallerPro-back → https://tallerpro-api.apps.punchi.dev');
  });

  it('sin proyecto conocido, nada', async () => {
    expect(await linksDelProyecto('otro', [], { store })).toBe('');
  });
});
