import { ErrorDeWhatsApp, type ClienteWa, type EventoWa, type PlantillaDeWa } from '../src/whatsapp.js';

/**
 * Un bot falso con plantillas: anota lo que se manda y deja simular que la
 * plantilla no esta aprobada o que el negocio no tiene `avisos`.
 */
export function waConPlantillas(o: { estado?: string; sinPermiso?: boolean } = {}) {
  const avisos: { a: string; plantilla: string; idioma: string; variables: string[] }[] = [];
  const creadas: { nombre: string; idioma: string; categoria: string; componentes: unknown[] }[] = [];
  const acks: number[][] = [];
  let eventos: EventoWa[] = [];
  const lista: PlantillaDeWa[] = o.estado
    ? [{ nombre: 'consulta_recibida', idioma: 'es_AR', categoria: 'UTILITY', estado: o.estado }]
    : [];
  const wa: ClienteWa = {
    eventos: async () => eventos,
    ack: async (ids) => void acks.push(ids),
    mandar: async () => ({ id: 1, wamid: 'wamid.1' }),
    charla: async (contacto) => ({ contacto, ventana_abierta: false, baja: false, mensajes: [] }),
    async avisar(a, plantilla, idioma, variables) {
      if (o.sinPermiso) throw new ErrorDeWhatsApp(404, 'no_existe');
      const p = lista.find((x) => x.nombre === plantilla && x.idioma === idioma);
      if (!p || p.estado !== 'APPROVED') throw new ErrorDeWhatsApp(409, 'plantilla_no_aprobada');
      avisos.push({ a, plantilla, idioma, variables });
      return { id: avisos.length, wamid: `wamid.p${avisos.length}` };
    },
    async plantillas() {
      if (o.sinPermiso) throw new ErrorDeWhatsApp(404, 'no_existe');
      return lista;
    },
    async crearPlantilla(p) {
      creadas.push(p);
      const nueva = { nombre: p.nombre, idioma: p.idioma, categoria: p.categoria, estado: 'PENDING' };
      lista.push(nueva);
      return nueva;
    },
  };
  return { wa, avisos, creadas, acks, ponerEventos: (e: EventoWa[]) => (eventos = e) };
}
