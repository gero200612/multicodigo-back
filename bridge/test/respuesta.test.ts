import { describe, it, expect } from 'vitest';
import { pidePermisoParaCommitear } from '../src/respuesta.js';

/**
 * Una tarea que termina PIDIENDO PERMISO no dejo el trabajo commiteado.
 *
 * Visto en la corrida `saludos3` del 2026-09-09: la tarea que le toco a `c1`
 * contesto "Quiero commitear esto en saludos3-back. ¿Aprobás el commit?", nadie
 * contesto —era una corrida desatendida, a nadie le tocaba contestar— y el
 * sistema la cerro como `lista`. El trabajo quedo sin commitear en el disco de
 * c1 y el informe conto la tarea como hecha.
 *
 * El riesgo de detectar esto por texto es el falso positivo: el agente termina
 * muchas respuestas buenas con una pregunta ("¿agrego tambien el front?"). Un
 * falso positivo marca fallida una tarea que SI se hizo y, con tres, cierra la
 * corrida. Asi que el patron es angosto a proposito: pedir permiso PARA
 * COMMITEAR O PUSHEAR, que es el unico caso donde el trabajo se queda afuera.
 */
describe('pide permiso para commitear', () => {
  // El texto exacto que quedo en produccion.
  it('reconoce el caso real de saludos3', () => {
    expect(
      pidePermisoParaCommitear(
        'Test pasa. La estructura quedó así: package.json, src/app.js, tests/.\n\n' +
          'Quiero commitear esto en saludos3-back. ¿Aprobás el commit?',
      ),
    ).toBe(true);
  });

  it('reconoce otras formas de pedir lo mismo', () => {
    expect(pidePermisoParaCommitear('¿Puedo commitear?')).toBe(true);
    expect(pidePermisoParaCommitear('¿Apruebas que commitee los cambios?')).toBe(true);
    expect(pidePermisoParaCommitear('Listo para pushear. ¿Confirmas el push?')).toBe(true);
    expect(pidePermisoParaCommitear('¿Autorizas el commit a la rama?')).toBe(true);
  });

  // --- Los falsos positivos, que son el riesgo de verdad -------------------
  //
  // Todos estos son respuestas de tareas que SI commitearon, sacadas de las
  // corridas reales de gastos, propinas y pruebarelevo.

  it('no confunde un trabajo que ya commiteo', () => {
    expect(pidePermisoParaCommitear('Listo, commiteado.')).toBe(false);
    expect(
      pidePermisoParaCommitear('Corrí los tests, pasaron verde, y commiteé.'),
    ).toBe(false);
    expect(
      pidePermisoParaCommitear(
        'Los 5 tests corren verdes y quedó commiteado.',
      ),
    ).toBe(false);
  });

  // Una pregunta al final NO es pedir permiso: el trabajo esta hecho y el
  // modelo ofrece seguir. Marcar esto fallido tiraría trabajo bueno.
  it('no confunde una pregunta sobre que hacer despues', () => {
    expect(
      pidePermisoParaCommitear(
        'Listo, commiteado. Si el pliego esperaba que /saludo/ también devuelva 400, ' +
          'avisame y agrego una ruta extra para ese caso.',
      ),
    ).toBe(false);
    expect(
      pidePermisoParaCommitear('Quedó commiteado. ¿Agrego también el front?'),
    ).toBe(false);
    expect(
      pidePermisoParaCommitear(
        'Listo. Falta: que el puerto use process.env.PORT (con default 3000), y los tests.',
      ),
    ).toBe(false);
  });

  // Hablar de commits en pasado o describir lo hecho no es pedir nada.
  it('no confunde una explicacion que menciona commits', () => {
    expect(
      pidePermisoParaCommitear(
        'Sumé el test correspondiente y quedó commiteado junto con package-lock.json.',
      ),
    ).toBe(false);
    expect(
      pidePermisoParaCommitear('No pude commitear porque git falló: fatal: not a git repository'),
    ).toBe(false);
  });

  it('una respuesta vacia no pide nada', () => {
    expect(pidePermisoParaCommitear('')).toBe(false);
  });
});
