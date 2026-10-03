import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Con qué cuenta de Claude trabaja cada bot de este proceso.
 *
 * Desde el panel se puede pasar la cuenta de un agente a Homero o a Patán. El
 * servicio de login MUEVE esa credencial al HOME del bot (y guarda aparte la
 * propia): Homero no lee carpetas de los agentes ni corre con su HOME.
 *
 * - Homero: su HOME de siempre (/home/homero). Ahí está la cedida, o la propia.
 * - Patán: /home/patan si tiene una cuenta propia ahí; si no, la de Homero.
 */
export function cuentaDeClaude(opciones: { homePatan?: string; existe?: (ruta: string) => boolean } = {}) {
  const homePatan = opciones.homePatan ?? process.env.HOMERO_HOME_PATAN ?? '/home/patan';
  const existe = opciones.existe ?? existsSync;

  return {
    /** El HOME a usar para `bot`, o undefined para el del proceso (el de Homero). */
    home(bot: 'homero' | 'patan'): string | undefined {
      if (bot === 'patan' && existe(join(homePatan, '.claude', '.credentials.json'))) return homePatan;
      return undefined;
    },
  };
}
