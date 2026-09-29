import type { NuevaTarea, Recibido, Store, Tarea } from '../src/store.js';

interface Fila extends Tarea {
  clave?: string;
  estado: 'pendiente' | 'corriendo' | 'lista' | 'fallida';
  disponibleDesde: Date;
  ultimoError?: string;
}

/** Un Store en memoria con la misma semantica que el de Postgres. */
export class MemoriaStore implements Store {
  estado = new Map<string, unknown>();
  tareas: Fila[] = [];
  primeros = new Map<string, Date>();
  envios: { cuenta: string; para: string; asunto: string; en: Date }[] = [];
  recibidos = new Set<string>();
  bajas = new Set<string>();

  constructor(private ahora: () => Date = () => new Date()) {}

  async leerEstado<T>(clave: string) {
    return this.estado.get(clave) as T | undefined;
  }
  async guardarEstado(clave: string, valor: unknown) {
    if (valor === null) this.estado.delete(clave);
    else this.estado.set(clave, JSON.parse(JSON.stringify(valor)));
  }

  async encolar(t: NuevaTarea) {
    if (t.clave && this.tareas.some((f) => f.clave === t.clave)) return false;
    this.tareas.push({
      id: this.tareas.length + 1,
      tipo: t.tipo,
      payload: JSON.parse(JSON.stringify(t.payload)),
      requiereIa: t.requiereIa,
      intentos: 0,
      clave: t.clave,
      estado: 'pendiente',
      disponibleDesde: t.disponibleDesde ?? this.ahora(),
    });
    return true;
  }
  async tomarSiguiente(ahora: Date, iaDisponible: boolean) {
    const f = this.tareas
      .filter(
        (t) =>
          t.estado === 'pendiente' &&
          t.disponibleDesde.getTime() <= ahora.getTime() &&
          (iaDisponible || !t.requiereIa),
      )
      .sort((a, b) => a.disponibleDesde.getTime() - b.disponibleDesde.getTime() || a.id - b.id)[0];
    if (!f) return undefined;
    f.estado = 'corriendo';
    return { id: f.id, tipo: f.tipo, payload: f.payload, requiereIa: f.requiereIa, intentos: f.intentos };
  }
  private fila(id: number) {
    return this.tareas.find((t) => t.id === id)!;
  }
  async terminar(id: number) {
    this.fila(id).estado = 'lista';
  }
  async reprogramar(id: number, cuando: Date, o: { contarIntento: boolean; error?: string }) {
    const f = this.fila(id);
    f.estado = 'pendiente';
    f.disponibleDesde = cuando;
    if (o.contarIntento) f.intentos++;
    if (o.error) f.ultimoError = o.error;
  }
  async fallar(id: number, error: string) {
    const f = this.fila(id);
    f.estado = 'fallida';
    f.intentos++;
    f.ultimoError = error;
  }
  async rescatarColgadas() {
    let n = 0;
    for (const t of this.tareas)
      if (t.estado === 'corriendo') {
        t.estado = 'pendiente';
        n++;
      }
    return n;
  }
  async contarTareas() {
    return {
      pendientes: this.tareas.filter((t) => t.estado === 'pendiente').length,
      fallidas: this.tareas.filter((t) => t.estado === 'fallida').length,
    };
  }

  async registrarCuenta() {}
  async primerEnvio(email: string) {
    return this.primeros.get(email);
  }
  async enviosDesde(email: string, desde: Date) {
    return this.envios.filter((e) => e.cuenta === email && e.en.getTime() >= desde.getTime()).length;
  }
  async registrarEnvio(e: { cuenta: string; para: string; asunto: string }) {
    this.envios.push({ ...e, en: this.ahora() });
    if (!this.primeros.has(e.cuenta)) this.primeros.set(e.cuenta, this.ahora());
  }

  async guardarRecibido(r: Recibido) {
    const k = `${r.cuenta}|${r.messageId}`;
    if (this.recibidos.has(k)) return false;
    this.recibidos.add(k);
    return true;
  }
  async esBaja(email: string) {
    return this.bajas.has(email.toLowerCase());
  }
  async agregarBaja(email: string) {
    this.bajas.add(email.toLowerCase());
  }
}
