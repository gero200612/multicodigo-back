/**
 * Tapa los tokens de un texto antes de loguearlo o devolverlo.
 *
 * Meta devuelve el token entero en "Malformed access token", asi que todo
 * error de Graph pasa por aca. Las claves de app (`swa_...`) tambien: un 401
 * logueado con la clave adentro la regala. Y el token de app (`<id>|<secreto>`),
 * que va en `debug_token`: si Meta lo repite, el secreto de la app queda a la vista.
 */
export function taparTokens(texto: string): string {
  return texto
    .replace(/EAA[A-Za-z0-9_-]{10,}/g, 'EAA…')
    .replace(/swa_[A-Za-z0-9_-]+/g, 'swa_…')
    .replace(/(\d{5,30})\|[A-Za-z0-9_-]{16,}/g, '$1|…');
}

/** El mensaje de un error cualquiera, ya tapado. */
export function textoDeError(e: unknown): string {
  return taparTokens(e instanceof Error ? e.message : String(e));
}
