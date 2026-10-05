import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * El bridge corre las migraciones de una lista fija en main.ts. Una migración
 * nueva que no se suma ahí no corre NUNCA en producción, y lo que depende de
 * ella falla en silencio (pasó con la 042 y la 043 el 2026-10-05).
 */
describe('migraciones', () => {
  it('cada archivo de migrations/ está en la lista de main.ts', () => {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const faltan = readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .filter((f) => !main.includes(`'${f}'`));
    expect(faltan).toEqual([]);
  });
});
