import { describe, it, expect } from 'vitest';
import { datosDeProyecto, datosDeAgente, parseMenuData, TOPE_CALLBACK_DATA } from '../src/menu.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('callback_data del menu', () => {
  it('ida y vuelta de un proyecto', () => {
    expect(parseMenuData(datosDeProyecto(UUID))).toEqual({ kind: 'proyecto', id: UUID });
  });

  it('ida y vuelta de un agente', () => {
    expect(parseMenuData(datosDeAgente('c3'))).toEqual({ kind: 'agente', slot: 'c3' });
  });

  it('entra en el tope de 64 bytes de Telegram', () => {
    // Un uuid son 36 caracteres. Con el prefijo tiene que seguir entrando, o
    // Telegram rechaza el teclado entero y el menu no aparece.
    expect(Buffer.byteLength(datosDeProyecto(UUID))).toBeLessThanOrEqual(TOPE_CALLBACK_DATA);
    expect(Buffer.byteLength(datosDeAgente('c99'))).toBeLessThanOrEqual(TOPE_CALLBACK_DATA);
  });

  it('no confunde los datos de una aprobacion con los del menu', () => {
    // render.ts usa su propio formato. Un toque de aprobacion no puede
    // interpretarse como una eleccion de agente.
    expect(parseMenuData('ok:11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('rechaza un slot con forma invalida', () => {
    expect(parseMenuData('a:c0')).toBeNull();
    expect(parseMenuData('a:../../etc')).toBeNull();
  });

  it('rechaza un id de proyecto que no es uuid', () => {
    // El id va derecho a una consulta: aceptarlo sin validar seria confiar en
    // algo que vuelve del cliente.
    expect(parseMenuData('p:no-soy-un-uuid')).toBeNull();
  });

  it('rechaza basura', () => {
    expect(parseMenuData('')).toBeNull();
    expect(parseMenuData('p')).toBeNull();
    expect(parseMenuData('x:algo')).toBeNull();
  });
});
