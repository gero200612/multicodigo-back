import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Las claves de las apps: `swa_<negocioId>_<43 caracteres base64url>`.
 *
 * El id va adentro para buscar el negocio sin recorrer todos los hashes; lo
 * que autentica son los 32 bytes al azar. El bot guarda solo el sha256: si se
 * filtra la base, las claves no sirven.
 */

export function generarClave(negocioId: number): string {
  return `swa_${negocioId}_${randomBytes(32).toString('base64url')}`;
}

export function hashDeClave(clave: string): string {
  return createHash('sha256').update(clave).digest('hex');
}

/** El negocio que dice la clave, o undefined si no tiene la forma de una clave de app. */
export function negocioDeClave(clave: string): number | undefined {
  const m = /^swa_(\d{1,9})_[A-Za-z0-9_-]{43}$/.exec(clave);
  return m ? Number(m[1]) : undefined;
}

/**
 * Compara en tiempo constante. Se comparan los sha256 y no los textos: asi
 * los dos lados miden lo mismo y el largo de la clave tampoco se filtra.
 */
export function mismaClave(clave: string, hashGuardado: string | null | undefined): boolean {
  if (!hashGuardado) return false;
  const a = Buffer.from(hashDeClave(clave), 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Un secreto para firmar los eventos que van por push. */
export function generarSecreto(): string {
  return randomBytes(32).toString('base64url');
}
