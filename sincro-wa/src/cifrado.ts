import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM para lo que el bot guarda y no puede guardar en claro: los
 * tokens de Meta de los clientes y el secreto con el que firma los eventos.
 *
 * El formato es `v1.<iv>.<tag>.<cifrado>` en base64url. La version va adelante
 * para poder rotar el esquema sin adivinar que tiene cada fila.
 */

export function claveDeCifrado(base64: string): Buffer {
  const clave = Buffer.from(base64, 'base64');
  if (clave.length !== 32) throw new Error('SINCRO_WA_CIFRADO tiene que ser 32 bytes en base64');
  return clave;
}

export function cifrar(clave: Buffer, texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave, iv);
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), cifrado].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function descifrar(clave: Buffer, guardado: string): string {
  const [version, iv, tag, cifrado] = guardado.split('.');
  if (version !== 'v1' || !iv || !tag || cifrado === undefined) throw new Error('dato cifrado con formato desconocido');
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}
