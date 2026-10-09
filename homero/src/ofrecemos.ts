/**
 * Lo que Sincro vende de verdad. Un anuncio solo puede prometer lo que esta
 * aca: lo leen el publicista al escribir y el revisor al chequear. Si Gero
 * suma o saca algo, se cambia aca y nada mas.
 */

export const OFRECEMOS = [
  'Carga automática de facturas y comprobantes (llegan por WhatsApp o mail y quedan cargados y ordenados)',
  'Pedidos que entran desde WhatsApp o mail directo al sistema, sin copiarlos a mano',
  'Control de stock con avisos cuando algo se está por terminar',
  'Turnos y agenda (reservas, recordatorios, cancelaciones)',
  'Cobranzas y recordatorios de pago a clientes',
  'Reportes del negocio (ventas, gastos, lo que se debe y lo que se cobra)',
];

/** Lo que ya hicimos y se puede nombrar como antecedente. */
export const ANTECEDENTE = 'SincroResto: el sistema de gestión para restaurantes (pedidos, stock, caja), hecho por Sincro y en uso.';

/** Para los prompts: el catalogo entero como texto. */
export function catalogo(): string {
  return [
    'Sincro hace software y automatizaciones A MEDIDA para pymes argentinas. Lo que ofrece:',
    ...OFRECEMOS.map((o) => `- ${o}`),
    `Antecedente real: ${ANTECEDENTE}`,
    'No ofrece: publicidad, contabilidad, asesoría impositiva, hardware, apps genéricas de terceros ni resultados garantizados.',
  ].join('\n');
}
