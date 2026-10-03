import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Con qué cuenta de Claude trabaja cada bot de este proceso (Homero, Patán).
 *
 * Desde el panel se puede asignar la cuenta de un agente (un slot, con su HOME
 * en /srv/homes/<slot>) a Homero o a Patán. Si hay una asignada y su credencial
 * existe, el SDK corre con ese HOME; si no, con el HOME propio de Homero, que es
 * lo que hacía siempre. Así asignar no puede dejar a Homero sin cuenta.
 *
 * Se pregunta a la base cada minuto como mucho: cambiar la asignación es raro,
 * y cada pedido a la IA no tiene por qué pagar una consulta.
 */
export function cuentaDeClaude(
  slotDelBot: (bot: string) => Promise<string | undefined>,
  opciones: { dir?: string; ttlMs?: number; existe?: (ruta: string) => boolean; ahora?: () => number } = {},
) {
  const dir = opciones.dir ?? process.env.HOMERO_SLOTS_DIR ?? '/srv/slots';
  const ttl = opciones.ttlMs ?? 60_000;
  const existe = opciones.existe ?? existsSync;
  const ahora = opciones.ahora ?? Date.now;
  const cache = new Map<string, { home: string | undefined; hasta: number }>();

  return {
    /** El HOME a usar para `bot`, o undefined para el de siempre. */
    async home(bot: string): Promise<string | undefined> {
      const guardado = cache.get(bot);
      if (guardado && guardado.hasta > ahora()) return guardado.home;
      let home: string | undefined;
      try {
        const slot = await slotDelBot(bot);
        // El slot viene de la base: se valida la forma antes de armar una ruta.
        if (slot && /^c[1-9][0-9]?$/.test(slot)) {
          const candidato = join(dir, slot);
          if (existe(join(candidato, '.claude', '.credentials.json'))) home = candidato;
          else console.warn(`[homero] la cuenta de ${slot} (asignada a ${bot}) no tiene credencial; sigo con la propia`);
        }
      } catch (e) {
        console.warn('[homero] no pude leer qué cuenta tiene asignada; sigo con la propia:', e);
      }
      cache.set(bot, { home, hasta: ahora() + ttl });
      return home;
    },
  };
}
