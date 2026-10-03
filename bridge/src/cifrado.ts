import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Cifrado de los tokens de despliegue (Render, Vercel, Netlify, Railway).
 *
 * AES-256-GCM con la clave de `CONEXIONES_CLAVE`, o derivada de
 * `BRIDGE_API_TOKEN` si no hay una propia: un secreto que ya vive solo en el
 * servidor. El texto guardado es `v1:<iv>:<tag>:<cifrado>` en base64url, y GCM
 * hace que un valor tocado en la base no descifre (falla, no devuelve basura).
 */
export function claveDe(secreto: string): Buffer {
  return createHash('sha256').update(`multicodigo:conexiones:${secreto}`).digest();
}

export function cifrar(texto: string, clave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave, iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), datos.toString('base64url')].join(':');
}

export function descifrar(guardado: string, clave: Buffer): string {
  const [v, iv, tag, datos] = guardado.split(':');
  if (v !== 'v1' || !iv || !tag || !datos) throw new Error('formato de cifrado desconocido');
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(datos, 'base64url')), d.final()]).toString('utf8');
}
