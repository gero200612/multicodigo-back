import type { FilaDeInsights, LeadDeMeta, Meta } from '../src/meta.js';

/**
 * Una Meta en memoria: anota cada llamada y devuelve ids inventados. Lo que se
 * prueba es lo que Homero le pide a Meta (y cuando), no la API de verdad.
 */
export function metaFalsa() {
  const llamadas: { metodo: string; args: unknown[] }[] = [];
  let n = 0;
  const id = (prefijo: string) => `${prefijo}${++n}`;
  const datos = {
    insights: [] as FilaDeInsights[],
    leads: new Map<string, LeadDeMeta[]>(),
    /** El limite de gasto de la cuenta, en pesos. */
    limite: 0,
    /** Si esta, la proxima llamada con ese metodo falla. */
    fallar: undefined as string | undefined,
    /** El mensaje de esa falla; si no, uno generico. */
    mensaje: undefined as string | undefined,
  };
  const anotar = (metodo: string, ...args: unknown[]) => {
    llamadas.push({ metodo, args });
    if (datos.fallar === metodo) {
      datos.fallar = undefined;
      throw new Error(datos.mensaje ?? `Meta: falló ${metodo}`);
    }
  };
  const meta: Meta = {
    async cuenta() {
      anotar('cuenta');
      return { nombre: 'Homer', moneda: 'ARS', estado: 1, gastado: 0, limite: datos.limite };
    },
    async crearCampana(nombre) {
      anotar('crearCampana', nombre);
      return id('camp');
    },
    async subirImagen(png, nombre) {
      anotar('subirImagen', png.length, nombre);
      return id('hash');
    },
    async crearFormulario(f) {
      anotar('crearFormulario', f);
      return id('form');
    },
    async buscarIntereses(texto) {
      anotar('buscarIntereses', texto);
      return [{ id: id('int'), name: texto }];
    },
    async crearConjunto(c) {
      anotar('crearConjunto', c);
      return id('set');
    },
    async crearCreativo(c) {
      anotar('crearCreativo', c);
      return id('cre');
    },
    async crearAnuncio(a) {
      anotar('crearAnuncio', a);
      return id('ad');
    },
    async cambiarEstado(objeto, estado) {
      anotar('cambiarEstado', objeto, estado);
    },
    async cambiarDiario(conjunto, diario) {
      anotar('cambiarDiario', conjunto, diario);
    },
    async insights(desde, hasta) {
      anotar('insights', desde, hasta);
      return datos.insights;
    },
    async leads(formulario, desde) {
      anotar('leads', formulario, desde);
      return datos.leads.get(formulario) ?? [];
    },
  };
  const de = (metodo: string) => llamadas.filter((l) => l.metodo === metodo);
  return { meta, llamadas, datos, de };
}
