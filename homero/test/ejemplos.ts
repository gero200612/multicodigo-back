import type { ContenidoAntesDespues, ContenidoChat, ContenidoPanel } from '../src/imagen.js';

/** Contenidos de ejemplo de cada plantilla, como los escribiria el publicista. */

export const CHAT: ContenidoChat = {
  publico: 'Para estudios contables',
  titulo: 'Las facturas se cargan solas.',
  bajada: 'Llegan por WhatsApp y quedan ordenadas. Cero tipeo.',
  chat: {
    nombre: 'Clientes',
    estado: '23 mensajes nuevos',
    mensajes: [
      { texto: 'Te paso la de octubre' },
      { archivo: 'factura_0231.pdf' },
      { archivo: 'factura_0232.pdf' },
      { texto: 'Van dos más, ¿llegaron?' },
      { archivo: 'factura_0233.pdf' },
    ],
  },
  resultado: {
    titulo: 'Facturas cargadas',
    etiqueta: 'al día',
    filas: [
      { nombre: 'Distribuidora Sur', detalle: '$184.500' },
      { nombre: 'Ferretería Mitre', detalle: '$42.300' },
      { nombre: 'Gráfica Norte', detalle: '$96.800' },
      { nombre: 'Lácteos del Oeste', detalle: '$61.250' },
    ],
  },
};

export const PANEL: ContenidoPanel = {
  publico: 'Para talleres',
  titulo: 'Nunca más sin el repuesto.',
  panel: {
    titulo: 'Stock del taller',
    subtitulo: 'Actualizado hace 2 minutos',
    filas: [
      { nombre: 'Filtro de aceite', valor: '24', nivel: 0.8, estado: 'ok', etiqueta: 'OK' },
      { nombre: 'Pastillas de freno', valor: '6', nivel: 0.2, estado: 'bajo', etiqueta: 'Bajo' },
      { nombre: 'Correa de distribución', valor: '0', nivel: 0, estado: 'alerta', etiqueta: 'Pedir' },
      { nombre: 'Bujías', valor: '18', nivel: 0.6, estado: 'ok', etiqueta: 'OK' },
    ],
  },
  aviso: { titulo: 'Falta correa de distribución', detalle: 'Pedido enviado al proveedor', pie: 'Hoy 9:41 · automático' },
  destacado: { grande: '24/7', texto: 'el stock al día, sin contar a mano' },
};

export const ANTES_DESPUES: ContenidoAntesDespues = {
  publico: 'Para distribuidoras',
  titulo: '¿Cuántas horas se van en copiar pedidos?',
  antes: {
    etiqueta: 'ANTES',
    items: [
      { fuerte: 'Pedidos por WhatsApp', suave: 'copiados a mano' },
      { fuerte: 'Planillas sueltas', suave: 'que nadie actualiza' },
      { fuerte: 'Errores al facturar', suave: 'y clientes esperando' },
      { fuerte: 'Stock de memoria', suave: 'y faltantes de sorpresa' },
    ],
  },
  despues: {
    etiqueta: 'CON SINCRO',
    items: [
      { fuerte: 'Pedidos que entran', suave: 'solos al sistema' },
      { fuerte: 'Todo en un lugar', suave: 'y al día' },
      { fuerte: 'Facturas sin tipeo', suave: 'desde el mismo pedido' },
      { fuerte: 'Avisos de stock', suave: 'antes de que falte' },
    ],
  },
};
