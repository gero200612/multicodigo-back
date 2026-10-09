import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ReporteDeError } from '@multicodigo/shared';
import {
  MAX_DETALLE_BYTES,
  OCULTO,
  PgRegistroDeErrores,
  RegistroEnMemoria,
  YA_ABIERTO,
  registrarSinRomper,
  reporteDeCuerpoInvalido,
  sanearDetalle,
  sanearReporte,
  type RegistroDeErrores,
} from '../src/errores.js';

const PROYECTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USUARIO = '99999999-9999-4999-8999-999999999999';

const reporte = (extra: Partial<ReporteDeError> = {}): ReporteDeError => ({
  servicio: 'gateway',
  codigo: 'internal',
  mensaje: 'algo se rompio',
  huella: 'gateway|internal|TypeError: x @ at algo',
  detalle: { ruta: '/agents/c1/prompt' },
  ...extra,
});

describe('saneado', () => {
  // Las claves se borran enteras y sin mirar mayusculas: el panel (C#) manda
  // `GithubToken`, el gateway `githubToken`, un header crudo `Authorization`.
  it('borra las claves secretas a cualquier profundidad, sin importar mayusculas', () => {
    const d = sanearDetalle({
      ruta: '/turnos',
      Token: 'x',
      cuerpo: {
        githubToken: 'ghs_algo',
        APITOKEN: 'y',
        prompt: 'el pedido de la persona',
        Pliego: 'el pliego entero',
        lista: [{ password: 'z', secret: 'w', queda: 1 }],
      },
      headers: { Authorization: 'Bearer abc' },
    });
    expect(d).toEqual({ ruta: '/turnos', cuerpo: { lista: [{ queda: 1 }] }, headers: {} });
  });

  // Un stack o un mensaje de un tercero puede traer la credencial pegada en
  // cualquier clave: la clave no avisa, la forma si.
  it('tapa los valores con forma de credencial en cualquier clave', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.firma_123-abc';
    const d = sanearDetalle({
      a: `fallo con ${jwt} adentro`,
      b: 'header: Bearer sk_live_algo123 y sigue',
      c: ['token de github ghp_ABCdef123456 y ghs_otro'],
      d: 'la key es sk-ant-api03-AbC_dEf-123 listo',
      e: 'una tarea-sk-no se toca',
    });
    expect(d).toEqual({
      a: `fallo con ${OCULTO} adentro`,
      b: `header: ${OCULTO} y sigue`,
      c: [`token de github ${OCULTO} y ${OCULTO}`],
      d: `la key es ${OCULTO} listo`,
      e: 'una tarea-sk-no se toca',
    });
  });

  it('el mensaje tambien se sanea', () => {
    const r = sanearReporte(reporte({ mensaje: 'rechazado: Bearer abc.def' }));
    expect(r.mensaje).toBe(`rechazado: ${OCULTO}`);
  });

  // Se guarda el COMIENZO como texto: un JSON cortado a la mitad no entra en
  // una columna jsonb.
  it('un detalle de mas de 16 KB se guarda cortado y como texto', () => {
    const d = sanearDetalle({ stack: 'x'.repeat(40_000) });
    expect(d.truncado).toBe(true);
    expect(typeof d.inicio).toBe('string');
    expect(Buffer.byteLength(d.inicio as string)).toBe(MAX_DETALLE_BYTES);
    expect((d.inicio as string).startsWith('{"stack":"xxx')).toBe(true);
  });

  it('un detalle chico queda igual', () => {
    expect(sanearDetalle({ ruta: '/turnos', issues: [] })).toEqual({ ruta: '/turnos', issues: [] });
    expect(sanearDetalle(undefined)).toEqual({});
  });
});

describe('reporteDeCuerpoInvalido', () => {
  const Schema = z.object({
    proyectoId: z.string().uuid(),
    documentos: z.array(z.string()).max(2),
    prompt: z.string().min(1),
  });

  // Los issues viajan SIN los valores: el prompt de la persona no puede
  // terminar en la tabla que lee un agente.
  it('la huella lleva la ruta y los paths de zod, y el detalle no lleva valores', () => {
    const cuerpo = { proyectoId: PROYECTO, usuarioId: USUARIO, documentos: ['a', 'b', 'c'], prompt: '' };
    const err = Schema.safeParse(cuerpo).error!;
    const r = reporteDeCuerpoInvalido('/turnos', err, cuerpo);

    expect(r.huella).toBe('bridge|cuerpo_invalido|/turnos documentos:too_big,prompt:too_small');
    expect(r.codigo).toBe('cuerpo_invalido');
    expect(r.proyectoId).toBe(PROYECTO);
    expect(r.usuarioId).toBe(USUARIO);
    expect(r.detalle).toEqual({
      ruta: '/turnos',
      issues: [
        { path: 'documentos', code: 'too_big', message: expect.any(String) },
        { path: 'prompt', code: 'too_small', message: expect.any(String) },
      ],
    });
    expect(JSON.stringify(r)).not.toContain('"a"');
  });

  it('un id con forma rara del cuerpo no se usa', () => {
    const cuerpo = { proyectoId: '../otro', usuarioId: 42 };
    const r = reporteDeCuerpoInvalido('/turnos', Schema.safeParse(cuerpo).error!, cuerpo);
    expect(r.proyectoId).toBeUndefined();
    expect(r.usuarioId).toBeUndefined();
  });

  it('un cuerpo que no es objeto no rompe', () => {
    const r = reporteDeCuerpoInvalido('/turnos', Schema.safeParse('hola').error!, 'hola');
    expect(r.huella).toBe('bridge|cuerpo_invalido|/turnos (raiz):invalid_type');
  });
});

/**
 * Los mismos casos contra la base de verdad (PGlite, con la 047) y contra el
 * doble en memoria que usan los tests del webhook: si se separan, falla aca.
 */
// Una sola base para todos los casos (levantar PGlite tarda segundos): cada
// caso la vacia antes de empezar.
let db: PGlite | undefined;
async function conPglite(): Promise<RegistroDeErrores> {
  if (!db) {
    db = new PGlite();
    const sql = readFileSync(fileURLToPath(new URL('../migrations/047_errores.sql', import.meta.url)), 'utf8');
    await db.exec(sql);
    // Dos veces: en produccion corre en cada arranque.
    await db.exec(sql);
  }
  await db.exec('TRUNCATE public.errores RESTART IDENTITY');
  return new PgRegistroDeErrores(db);
}

describe.each<[string, () => Promise<RegistroDeErrores>]>([
  ['RegistroEnMemoria', async () => {
    // Un reloj que avanza: con el real dos reportes seguidos empatan en `ultima`.
    let t = Date.parse('2026-10-08T12:00:00Z');
    return new RegistroEnMemoria(() => new Date((t += 1000)));
  }],
  ['PgRegistroDeErrores', conPglite],
])('%s', (_nombre, crear) => {
  let registro: RegistroDeErrores;
  beforeEach(async () => {
    registro = await crear();
  });

  it('el mismo bug repetido es una fila que suma veces y se queda con el ultimo detalle', async () => {
    const a = await registro.registrar(reporte({ detalle: { vez: 1 } }));
    const b = await registro.registrar(reporte({ detalle: { vez: 2 }, proyectoId: PROYECTO }));

    expect(a.nuevo).toBe(true);
    expect(b).toEqual({ id: a.id, nuevo: false });
    const fila = (await registro.porId(a.id))!;
    expect(fila.veces).toBe(2);
    expect(fila.detalle).toEqual({ vez: 2 });
    expect(fila.proyectoId).toBe(PROYECTO);
    expect(fila.estado).toBe('nuevo');
    expect(Date.parse(fila.ultima)).toBeGreaterThanOrEqual(Date.parse(fila.primera));
  });

  // El arreglo no anduvo: eso hay que verlo, no sumarlo a una fila cerrada.
  it('un error publicado que vuelve a pasar abre una fila nueva', async () => {
    const a = await registro.registrar(reporte());
    await registro.cambiarEstado(a.id, 'publicado', { agente: 'c2', resumen: 'listo' });

    const b = await registro.registrar(reporte());
    expect(b.nuevo).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect((await registro.porId(a.id))!.veces).toBe(1);
  });

  // Publicar un ticket pasa a main la rama entera del agente: los arreglos que
  // estaban en esa rama ya no tienen que ofrecer "Publicar".
  it('marcarPublicados pasa a publicado los en_rama de ese agente en ese proyecto', async () => {
    const OTRO = '00000000-0000-4000-8000-000000000099';
    const mio = await registro.registrar(reporte({ huella: 'h1' }));
    const viejo = await registro.registrar(reporte({ huella: 'h2' }));
    const otroAgente = await registro.registrar(reporte({ huella: 'h3' }));
    const otroProyecto = await registro.registrar(reporte({ huella: 'h4' }));
    const nuevo = await registro.registrar(reporte({ huella: 'h5' }));
    await registro.cambiarEstado(mio.id, 'en_rama', { agente: 'c1', proyectoId: PROYECTO, resumen: 'r' });
    await registro.cambiarEstado(viejo.id, 'en_rama', { agente: 'c1' });
    await registro.cambiarEstado(otroAgente.id, 'en_rama', { agente: 'c2', proyectoId: PROYECTO });
    await registro.cambiarEstado(otroProyecto.id, 'en_rama', { agente: 'c1', proyectoId: OTRO });

    const ids = await registro.marcarPublicados(PROYECTO, 'c1');

    // `viejo` no anotó el proyecto: no se adivina, se publica con su botón.
    expect(ids).toEqual([mio.id]);
    expect((await registro.porId(viejo.id))!.estado).toBe('en_rama');
    const fila = (await registro.porId(mio.id))!;
    expect(fila.estado).toBe('publicado');
    expect(fila.arreglo).toMatchObject({ agente: 'c1', resumen: 'r', publicadoCon: 'la rama del agente' });
    expect((await registro.porId(otroAgente.id))!.estado).toBe('en_rama');
    expect((await registro.porId(otroProyecto.id))!.estado).toBe('en_rama');
    expect((await registro.porId(nuevo.id))!.estado).toBe('nuevo');
  });

  it('mientras se arregla, repetirse suma en la misma fila', async () => {
    const a = await registro.registrar(reporte());
    await registro.cambiarEstado(a.id, 'arreglando');
    expect(await registro.registrar(reporte())).toEqual({ id: a.id, nuevo: false });
  });

  it('el registro sanea antes de guardar', async () => {
    const a = await registro.registrar(reporte({ detalle: { token: 'x', stack: 'Bearer abc' } }));
    expect((await registro.porId(a.id))!.detalle).toEqual({ stack: OCULTO });
  });

  it('lista los abiertos por defecto, del mas reciente al mas viejo', async () => {
    const viejo = await registro.registrar(reporte({ huella: 'h1' }));
    const cerrado = await registro.registrar(reporte({ huella: 'h2' }));
    const nuevo = await registro.registrar(reporte({ huella: 'h3' }));
    await registro.cambiarEstado(cerrado.id, 'descartado');

    expect((await registro.listar('abiertos')).map((e) => e.id)).toEqual([nuevo.id, viejo.id]);
    expect((await registro.listar('descartado')).map((e) => e.id)).toEqual([cerrado.id]);
    expect(await registro.listar('todos')).toHaveLength(3);
  });

  it('cambiar el estado guarda el arreglo, y sin arreglo deja el que habia', async () => {
    const a = await registro.registrar(reporte());
    const r1 = await registro.cambiarEstado(a.id, 'en_rama', { job: 'j1', ramas: ['claude/c1/x'] });
    expect(r1).toMatchObject({ estado: 'en_rama', arreglo: { job: 'j1', ramas: ['claude/c1/x'] } });
    const r2 = await registro.cambiarEstado(a.id, 'descartado');
    expect(r2).toMatchObject({ estado: 'descartado', arreglo: { job: 'j1' } });
  });

  it('un id que no existe da undefined', async () => {
    expect(await registro.porId(999)).toBeUndefined();
    expect(await registro.cambiarEstado(999, 'descartado')).toBeUndefined();
  });

  // El indice unico parcial no deja dos filas abiertas con la misma huella.
  it('reabrir uno descartado cuando ya hay otro abierto del mismo bug dice ya_abierto', async () => {
    const a = await registro.registrar(reporte());
    await registro.cambiarEstado(a.id, 'descartado');
    await registro.registrar(reporte());
    expect(await registro.cambiarEstado(a.id, 'nuevo')).toBe(YA_ABIERTO);
  });

  it('las fechas salen en ISO y el id es numero', async () => {
    const a = await registro.registrar(reporte({ usuarioId: USUARIO }));
    const f = (await registro.porId(a.id))!;
    expect(typeof f.id).toBe('number');
    expect(f.primera).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(f.usuarioId).toBe(USUARIO);
    expect(f.arreglo).toBeNull();
  });
});

describe('registrarSinRomper', () => {
  it('sin registro no hace nada', async () => {
    expect(await registrarSinRomper(undefined, reporte())).toBeUndefined();
  });

  it('un registro que tira no tira', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const roto = { registrar: async () => { throw new Error('la base se cayo'); } } as unknown as RegistroDeErrores;
    expect(await registrarSinRomper(roto, reporte())).toBeUndefined();
    espia.mockRestore();
  });

  it('un registro colgado no demora mas que la espera', async () => {
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    const colgado = { registrar: () => new Promise(() => {}) } as unknown as RegistroDeErrores;
    const antes = Date.now();
    expect(await registrarSinRomper(colgado, reporte(), 50)).toBeUndefined();
    expect(Date.now() - antes).toBeLessThan(1000);
    espia.mockRestore();
  });
});
