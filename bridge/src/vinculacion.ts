/** Cuanto vale un codigo de vinculacion. */
export const MINUTOS_DE_CODIGO = 10;

/** Cuantos codigos puede pedir un chat, y en cuanto tiempo. */
export const TOPE_POR_CHAT = 3;
export const VENTANA_MS = 60 * 60 * 1000;

/**
 * Cuantos codigos pidio cada chat en la ultima ventana.
 *
 * Existe porque el bot le contesta a chats que no conoce: sin tope, cualquiera
 * que lo encuentre puede pedir codigos hasta llenar la tabla.
 *
 * En memoria y no en Postgres a proposito. Perder el conteo al reiniciar es
 * aceptable —el techo real lo pone que el codigo no sirve sin cuenta en el
 * panel— y una escritura por mensaje entrante no vale lo que cuesta.
 */
export class LimitePorChat {
  private pedidos = new Map<number, number[]>();

  constructor(
    private tope = TOPE_POR_CHAT,
    private ventanaMs = VENTANA_MS,
    private ahora: () => number = () => Date.now(),
  ) {}

  permite(chatId: number): boolean {
    const t = this.ahora();
    this.limpiar(t);

    const previos = (this.pedidos.get(chatId) ?? []).filter((x) => t - x < this.ventanaMs);
    if (previos.length >= this.tope) {
      this.pedidos.set(chatId, previos);
      return false;
    }

    previos.push(t);
    this.pedidos.set(chatId, previos);
    return true;
  }

  /** Solo para los tests: cuantos chats se estan recordando. */
  tamaño(): number {
    return this.pedidos.size;
  }

  /**
   * Saca los chats cuya ventana ya paso entera. Sin esto, un bot publico
   * acumula una entrada por cada chat que le escribio alguna vez.
   */
  private limpiar(t: number): void {
    for (const [chat, marcas] of this.pedidos) {
      if (marcas.every((x) => t - x >= this.ventanaMs)) this.pedidos.delete(chat);
    }
  }
}
