import { describe, it, expect } from 'vitest';
import { verificarDespliegue, tareaDeProblema } from '../src/verificar.js';

/**
 * Lo que caza mirar la app desplegada.
 *
 * En `Hoteleria` (2026-09-20) las tareas del login, del CORS y del despliegue
 * figuraban todas como HECHAS y la app no se podia usar. Los tests en verde y
 * el analista mirando codigo no alcanzan: hay que pedirle la pagina a la URL.
 */
describe('verificarDespliegue', () => {
  it('no dice nada cuando todo contesta', async () => {
    const r = await verificarDespliegue(
      [{ nombre: 'x-front', url: 'https://x-front.test/' }],
      { fetchImpl: (async () => new Response('<html></html>', { status: 200 })) as any },
    );
    expect(r).toEqual([]);
  });

  // Una API con todo protegido contesta 401 en la raiz y esta sana. Tratar eso
  // como falla llenaria el informe de ruido y nadie lo leeria mas.
  it('un 401 no es un problema', async () => {
    const r = await verificarDespliegue(
      [{ nombre: 'x-back', url: 'https://x-back.test/' }],
      { fetchImpl: (async () => new Response('no', { status: 401 })) as any },
    );
    expect(r).toEqual([]);
  });

  // El back de `Hoteleria` contestaba 500 en TODO porque las tablas no
  // existian: la base estaba conectada y sin migrar.
  it('un 5xx lo reporta con lo que dijo el servidor', async () => {
    const r = await verificarDespliegue(
      [{ nombre: 'hotel-back', url: 'https://hotel-back.test/api/rooms' }],
      {
        fetchImpl: (async () =>
          new Response('Npgsql.PostgresException: 42P01: relation "Rooms" does not exist', {
            status: 500,
          })) as any,
      },
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.resumen).toContain('500');
    expect(r[0]!.detalle).toContain('relation "Rooms" does not exist');
  });

  it('una URL que no contesta tambien cuenta', async () => {
    const r = await verificarDespliegue(
      [{ nombre: 'x-back', url: 'https://x-back.test/' }],
      { fetchImpl: (async () => { throw new Error('fetch failed'); }) as any },
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.resumen).toContain('no contesta');
  });

  /**
   * El caso que mas engaña: la URL contesta 200 con la version ANTERIOR
   * mientras la nueva falla en loop. `padel-front` acumulo cuatro
   * `update_failed` seguidos arrancando con `ng serve` y desde afuera se veia
   * perfecto.
   */
  it('un deploy fallado se reporta aunque la URL conteste bien', async () => {
    let pidioLaUrl = false;
    const r = await verificarDespliegue(
      [{ nombre: 'padel-front', serviceId: 'srv-1', url: 'https://padel-front.test/' }],
      {
        estadoDeDeploy: async () => ({
          estado: 'fallo' as const,
          motivo: 'update_failed',
          log: ['==> Running "npm start"', '> ng serve'],
        }),
        fetchImpl: (async () => {
          pidioLaUrl = true;
          return new Response('<html></html>', { status: 200 });
        }) as any,
      },
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.resumen).toContain('update_failed');
    expect(r[0]!.detalle).toContain('ng serve');
    // Y no se le pide la pagina: lo que conteste es de la version vieja.
    expect(pidioLaUrl).toBe(false);
  });

  it('un deploy a medio construir no es un problema', async () => {
    const r = await verificarDespliegue(
      [{ nombre: 'x-back', serviceId: 'srv-1', url: 'https://x-back.test/' }],
      {
        estadoDeDeploy: async () => ({ estado: 'construyendo' as const }),
        fetchImpl: (async () => new Response('no', { status: 500 })) as any,
      },
    );
    expect(r).toEqual([]);
  });
});

describe('tareaDeProblema', () => {
  it('le da al agente el sintoma y el log, que es lo que no puede averiguar', () => {
    const t = tareaDeProblema({
      nombre: 'hotel-back',
      resumen: 'hotel-back contesta 500 en https://hotel-back.test/api/rooms',
      detalle: 'relation "Rooms" does not exist',
    });
    expect(t).toContain('500');
    expect(t).toContain('relation "Rooms" does not exist');
  });
});
