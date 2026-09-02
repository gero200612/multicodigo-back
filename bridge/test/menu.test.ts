import { describe, it, expect } from 'vitest';
import {
  datosDeProyecto,
  datosDeAgente,
  parseMenuData,
  tecladoDeProyectos,
  tecladoDeAgentes,
  TOPE_CALLBACK_DATA,
  tecladoDePermisos,
  tecladoDeAcciones,
  tecladoDeModelos,
} from '../src/menu.js';

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

describe('teclados', () => {
  it('un boton por proyecto, uno por fila', () => {
    const t = tecladoDeProyectos([
      { id: UUID, nombre: 'demo' },
      { id: '22222222-2222-4222-8222-222222222222', nombre: 'otro' },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]![0]!.label).toBe('demo');
    expect(t[0]![0]!.data).toBe(`p:${UUID}`);
  });

  it('el agente muestra su nombre y su estado', () => {
    const t = tecladoDeAgentes([
      { slot: 'c1', nombre: 'Backend', arriba: true, tieneCuenta: true },
      { slot: 'c2', nombre: undefined, arriba: false, tieneCuenta: true },
      { slot: 'c3', nombre: 'Nuevo', arriba: false, tieneCuenta: false },
    ]);

    expect(t[0]![0]!.label).toBe('● Backend');
    // Sin nombre cae al slot en mayusculas, que es como se lo nombra en el chat.
    expect(t[1]![0]!.label).toBe('○ C2');
    expect(t[2]![0]!.label).toBe('⚠ Nuevo');
  });

  it('el agente sin cuenta no se puede elegir', () => {
    // Elegirlo llevaria a un turno que falla con sin_credencial. Es mejor que
    // el boton no haga nada y el texto explique.
    const t = tecladoDeAgentes([
      { slot: 'c3', nombre: 'Nuevo', arriba: false, tieneCuenta: false },
    ]);
    expect(t[0]![0]!.data).toBe('x:');
  });

  // Un boton que cambia de lugar entre dos llamados es un toque equivocado.
  it('respeta el orden en el que le llegan', () => {
    const t = tecladoDeAgentes([
      { slot: 'c2', nombre: undefined, arriba: true, tieneCuenta: true },
      { slot: 'c1', nombre: undefined, arriba: true, tieneCuenta: true },
    ]);
    expect(t.map((f) => f[0]!.data)).toEqual(['a:c2', 'a:c1']);
  });
});

describe('el menu marca los slots ocupados', () => {
  const base = { slot: 'c1' as const, arriba: true, tieneCuenta: true };

  it('un slot ocupado se marca y dice por que', () => {
    const [fila] = tecladoDeAgentes([{ ...base, ocupado: true }]);
    expect(fila![0]!.label).toContain('🔒');
    expect(fila![0]!.label).toContain('lo esta usando otro');
  });

  // Un boton que lleva a un 409 hace perder un turno para llegar a un error que
  // ya sabiamos. Mismo criterio que el slot sin cuenta y el agotado.
  it('un slot ocupado no se puede elegir', () => {
    const [fila] = tecladoDeAgentes([{ ...base, ocupado: true }]);
    expect(parseMenuData(fila![0]!.data)).toBeNull();
  });

  it('un slot libre se sigue pudiendo elegir', () => {
    const [fila] = tecladoDeAgentes([{ ...base, ocupado: false }]);
    expect(parseMenuData(fila![0]!.data)).toEqual({ kind: 'agente', slot: 'c1' });
  });

  // El orden de las marcas dice que hacer: "sin tokens" manda a esperar o
  // cambiar de cuenta, "ocupado" manda a esperar y nada mas.
  it('sin tokens tapa a ocupado, no al reves', () => {
    const [fila] = tecladoDeAgentes([{ ...base, ocupado: true, agotado: {} }]);
    expect(fila![0]!.label).toContain('⛔');
    expect(fila![0]!.label).not.toContain('🔒');
  });
});

describe('los botones de los modos de permiso', () => {
  it('ofrece los tres modos', () => {
    const filas = tecladoDePermisos('preguntar');
    expect(filas).toHaveLength(3);
  });

  // Una lista que cambia segun donde estas obliga a recordar en cual estabas.
  it('marca el actual sin sacarlo de la lista', () => {
    const filas = tecladoDePermisos('ediciones');
    const marcado = filas.filter((f) => f[0]!.label.startsWith('◉'));
    expect(marcado).toHaveLength(1);
    expect(marcado[0]![0]!.label).toContain('ediciones');
  });

  // Un boton que contesta "listo, ya estabas ahi" es ruido.
  it('el actual no se puede volver a elegir', () => {
    const filas = tecladoDePermisos('todo');
    const actual = filas.find((f) => f[0]!.label.startsWith('◉'))!;
    expect(parseMenuData(actual[0]!.data)).toBeNull();
  });

  it('los otros dos si se pueden elegir', () => {
    const filas = tecladoDePermisos('todo');
    const otros = filas.filter((f) => f[0]!.label.startsWith('○'));
    expect(otros).toHaveLength(2);
    for (const f of otros) {
      expect(parseMenuData(f[0]!.data)).toMatchObject({ kind: 'permiso' });
    }
  });

  // El dato del boton vuelve del cliente: un modo inventado no puede terminar
  // en un INSERT.
  it('un modo que no existe no se parsea', () => {
    expect(parseMenuData('k:aprobame-todo')).toBeNull();
    expect(parseMenuData('k:')).toBeNull();
  });

  it('los botones caben en el tope de callback_data de Telegram', () => {
    for (const fila of tecladoDePermisos('preguntar')) {
      expect(fila[0]!.data.length).toBeLessThanOrEqual(TOPE_CALLBACK_DATA);
    }
  });
});

describe('los botones del menu principal', () => {
  it('ofrece mas de una cosa: es lo que /menu no hacia', () => {
    expect(tecladoDeAcciones().length).toBeGreaterThan(1);
  });

  it('cada boton lleva a una accion que se puede leer de vuelta', () => {
    for (const fila of tecladoDeAcciones()) {
      expect(parseMenuData(fila[0]!.data)).toMatchObject({ kind: 'accion' });
    }
  });

  it('elegir agente sigue estando: era lo unico que habia antes', () => {
    const datos = tecladoDeAcciones().map((f) => parseMenuData(f[0]!.data));
    expect(datos).toContainEqual({ kind: 'accion', accion: 'agentes' });
  });

  // El dato vuelve del cliente: una accion inventada no puede llegar a ejecutar
  // un comando.
  it('una accion que no existe no se parsea', () => {
    expect(parseMenuData('z:borrar-todo')).toBeNull();
    expect(parseMenuData('z:')).toBeNull();
  });

  it('los botones caben en el tope de callback_data', () => {
    for (const fila of tecladoDeAcciones()) {
      expect(fila[0]!.data.length).toBeLessThanOrEqual(TOPE_CALLBACK_DATA);
    }
  });
});

describe('los botones de modelo', () => {
  it('ofrece los tres modelos y dice para que sirve cada uno', () => {
    const filas = tecladoDeModelos(undefined);
    expect(filas).toHaveLength(3);
    // El nombre solo no alcanza para decidir: "Sonnet 5" no dice si conviene.
    for (const f of filas) expect(f[0]!.label).toContain('—');
  });

  // Marcar uno cuando nadie eligio seria afirmar cual usa el CLI por default,
  // que es justo lo que no sabemos.
  it('sin eleccion no marca ninguno', () => {
    const filas = tecladoDeModelos(undefined);
    expect(filas.filter((f) => f[0]!.label.startsWith('◉'))).toHaveLength(0);
    for (const f of filas) {
      expect(parseMenuData(f[0]!.data)).toMatchObject({ kind: 'modelo' });
    }
  });

  it('marca el actual y lo deja inerte', () => {
    const filas = tecladoDeModelos('sonnet');
    const actual = filas.find((f) => f[0]!.label.startsWith('◉'))!;
    expect(actual[0]!.label).toContain('Sonnet');
    expect(parseMenuData(actual[0]!.data)).toBeNull();
  });

  it('un modelo inventado no se parsea', () => {
    expect(parseMenuData('q:gpt-4')).toBeNull();
    expect(parseMenuData('q:')).toBeNull();
  });

  it('los botones caben en el tope de callback_data', () => {
    for (const f of tecladoDeModelos('opus')) {
      expect(f[0]!.data.length).toBeLessThanOrEqual(TOPE_CALLBACK_DATA);
    }
  });

  it('el menu principal ofrece elegir el modelo', () => {
    const datos = tecladoDeAcciones().map((f) => parseMenuData(f[0]!.data));
    expect(datos).toContainEqual({ kind: 'accion', accion: 'modelo' });
  });
});
