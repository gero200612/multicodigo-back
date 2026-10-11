import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

/**
 * Corre las migraciones que falten, en orden, cada una en su transaccion.
 *
 * Se anotan en `migraciones` y no se re-ejecutan: en otros servicios correr
 * todo el SQL en cada arranque obligo a escribir migraciones idempotentes a
 * mano y una que no lo era rompio un deploy. El lock evita que dos procesos
 * arrancando juntos corran la misma.
 */

const CARPETA = new URL('../migrations/', import.meta.url);
// Un numero cualquiera, fijo: el lock de migraciones de este servicio.
const LOCK = 7_310_455;

export async function migrar(pool: pg.Pool, log: (t: string) => void = () => {}): Promise<string[]> {
  const archivos = (await readdir(CARPETA)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const cliente = await pool.connect();
  const corridas: string[] = [];
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await cliente.query(
      'CREATE TABLE IF NOT EXISTS migraciones (nombre text PRIMARY KEY, aplicada timestamptz NOT NULL DEFAULT now())',
    );
    const hechas = new Set((await cliente.query<{ nombre: string }>('SELECT nombre FROM migraciones')).rows.map((r) => r.nombre));
    for (const archivo of archivos) {
      if (hechas.has(archivo)) continue;
      const sql = await readFile(new URL(archivo, CARPETA), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migraciones (nombre) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
      } catch (e) {
        await cliente.query('ROLLBACK');
        throw new Error(`la migracion ${archivo} fallo: ${e instanceof Error ? e.message : String(e)}`);
      }
      log(`migracion ${archivo} aplicada`);
      corridas.push(archivo);
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    cliente.release();
  }
  return corridas;
}
