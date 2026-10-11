import type { Contexto } from './contexto.js';
import { emitirAdmin } from './eventos.js';

/**
 * Una alerta para Gero. Queda guardada y sale como evento de admin, que Homero
 * levanta con `GET /admin/eventos` y manda por Telegram.
 *
 * Con `clave` no se repite: el 80 % del tope salta una vez por mes aunque el
 * gasto pase el umbral veinte veces.
 */
export async function alertar(
  ctx: Contexto,
  a: { clave?: string; negocioId: number | null; tipo: string; texto: string },
): Promise<boolean> {
  const alerta = await ctx.store.crearAlerta({
    clave: a.clave ?? null,
    negocioId: a.negocioId,
    tipo: a.tipo,
    texto: a.texto,
    fecha: ctx.ahora(),
  });
  if (!alerta) return false;
  ctx.log(`alerta ${a.tipo}: ${a.texto}`);
  await emitirAdmin(ctx, { tipo: a.tipo, negocio_id: a.negocioId, texto: a.texto });
  return true;
}
