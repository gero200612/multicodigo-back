import { z } from 'zod';
import { horarioEnCastellano } from './agenda.js';
import { horaArgentina } from './horas.js';
import { asegurarPlantilla } from './primer-whatsapp.js';
import type { Store } from './store.js';
import type { DepsDeVentas } from './ventas.js';
import { ErrorDeWhatsApp, type ClienteWa } from './whatsapp.js';

/**
 * El link de la reunion lo pasa Gero (pedido 2026-10-13: "prefiero pasarlo yo
 * media hora antes, un Meet"). Al reservar no se arma ninguno: 45 min antes le
 * llega a Gero un Telegram, le responde con su Meet y Homero se lo manda al
 * cliente por donde se agendo (WhatsApp o mail). A los 10 min, si sigue sin
 * link, se lo vuelve a pedir una vez.
 *
 * Todo vive en homero.estado: que mensaje de Telegram es de que reunion, y el
 * link que ya se mando. No hace falta tocar la tabla de reuniones.
 */

export const PLANTILLA_LINK = {
  nombre: 'link_reunion',
  idioma: 'es_AR',
  categoria: 'UTILITY' as const,
  texto: 'Hola! Te paso el link para nuestra reunión de hoy a las {{1}}: {{2}}',
  ejemplo: ['15:00', 'https://meet.google.com/abc-defg-hij'],
};

export const ANTES_DEL_PEDIDO_MS = 45 * 60_000;
export const ANTES_DEL_REPEDIDO_MS = 10 * 60_000;

const MEET = /https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s]*)?/i;

const clavePedido = (msg: number) => `meet:pedido:${msg}`;
const claveLink = (reunionId: number) => `meet:link:${reunionId}`;

export const PayloadDePedirMeet = z.object({
  reunionId: z.number(),
  vuelta: z.union([z.literal(1), z.literal(2)]),
  canal: z.enum(['whatsapp', 'mail']),
});
type PedidoDeMeet = z.infer<typeof PayloadDePedirMeet>;

/** Encola los dos pedidos a Gero: a -45 min (o ya, si falta menos) y a -10 min. */
export async function encolarPedidosDeMeet(
  store: Pick<Store, 'encolar'>,
  ahora: Date,
  r: { reunionId: number; inicio: Date; canal: PedidoDeMeet['canal'] },
): Promise<void> {
  const momentos: [1 | 2, number][] = [
    [1, r.inicio.getTime() - ANTES_DEL_PEDIDO_MS],
    [2, r.inicio.getTime() - ANTES_DEL_REPEDIDO_MS],
  ];
  for (const [vuelta, cuando] of momentos) {
    if (vuelta === 2 && cuando <= ahora.getTime()) continue;
    await store.encolar({
      tipo: 'pedir_meet',
      payload: { reunionId: r.reunionId, vuelta, canal: r.canal },
      requiereIa: false,
      clave: `pedir_meet:${vuelta}:${r.reunionId}`,
      disponibleDesde: new Date(Math.max(ahora.getTime(), cuando)),
    });
  }
}

/** La tarea: le pide el Meet a Gero por Telegram (la segunda vez, solo si no lo paso). */
export async function pedirMeet(payload: unknown, deps: Pick<DepsDeVentas, 'store' | 'proponer'>): Promise<void> {
  const p = PayloadDePedirMeet.parse(payload);
  const reunion = await deps.store.reunion(p.reunionId);
  if (!reunion) return;
  if (await deps.store.leerEstado<string>(claveLink(reunion.id))) return;
  const lead = await deps.store.lead(reunion.leadId);
  if (!lead) return;
  const por = p.canal === 'whatsapp' ? 'por WhatsApp' : 'por mail';
  const texto =
    p.vuelta === 1
      ? [
          `📅 En 45 min: reunión con ${lead.nombre} (${por}), ${horarioEnCastellano(reunion.inicio)}.`,
          '🔗 Respondé a ESTE mensaje con el link de Google Meet y se lo mando.',
          lead.investigacion ? `\nQué hacen: ${lead.investigacion.resumen_empresa}` : undefined,
          lead.investigacion ? `Dolor: ${lead.investigacion.dolor}` : undefined,
          lead.investigacion ? `Idea: ${lead.investigacion.idea}` : undefined,
        ]
      : [
          `⏰ Faltan 10 min para la reunión con ${lead.nombre} y todavía no tengo el link.`,
          '🔗 Respondé a ESTE mensaje con el link de Google Meet y se lo mando.',
        ];
  const msg = await deps.proponer(texto.filter((l) => l !== undefined).join('\n'), []);
  if (msg) await deps.store.guardarEstado(clavePedido(msg), p);
}

export interface DepsDeMeet extends Pick<DepsDeVentas, 'store' | 'firma'> {
  wa?: ClienteWa;
  aprobar: (salienteId: number) => Promise<boolean>;
}

/**
 * Gero le respondio a un mensaje de Telegram. Si era un pedido de Meet, lo
 * manda y devuelve que contestarle; si no, `undefined` (el mensaje es otra cosa).
 */
export async function recibirMeet(citado: number, texto: string, deps: DepsDeMeet): Promise<string | undefined> {
  const p = await deps.store.leerEstado<PedidoDeMeet>(clavePedido(citado));
  if (!p) return undefined;
  const link = MEET.exec(texto)?.[0];
  if (!link) return 'Pegame el link de Google Meet (https://meet.google.com/...) respondiendo a ese mismo mensaje.';
  const reunion = await deps.store.reunion(p.reunionId);
  if (!reunion) return 'Esa reunión ya no está: se canceló.';
  const lead = await deps.store.lead(reunion.leadId);
  if (!lead) return 'No encontré a quién era la reunión.';
  const hora = horaArgentina(reunion.inicio);

  const r = p.canal === 'whatsapp' ? await porWhatsApp(lead.telefono, hora, link, deps) : await porMail(reunion.id, lead.id, hora, link, deps);
  if (!r.ok) return `❌ No le pude mandar el link a ${lead.nombre}: ${r.motivo}`;
  await deps.store.guardarEstado(claveLink(reunion.id), link);
  return `✅ Le mandé el link a ${lead.nombre} ${p.canal === 'whatsapp' ? 'por WhatsApp' : 'por mail'}.`;
}

type Resultado = { ok: true } | { ok: false; motivo: string };

async function porWhatsApp(telefono: string | undefined, hora: string, link: string, deps: DepsDeMeet): Promise<Resultado> {
  const a = (telefono ?? '').replace(/\D/g, '');
  if (!deps.wa || !a) return { ok: false, motivo: 'no tengo su WhatsApp' };
  const aMano = `mandáselo vos: https://wa.me/${a}`;
  try {
    await deps.wa.mandar(a, `🎥 Acá tenés el link para nuestra reunión de hoy a las ${hora}:\n${link}`);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ErrorDeWhatsApp) || e.codigo !== 'fuera_de_ventana') {
      return { ok: false, motivo: `${e instanceof ErrorDeWhatsApp ? e.codigo : String(e)}; ${aMano}` };
    }
  }
  // Pasaron mas de 24 h desde su ultimo mensaje: solo con la plantilla.
  try {
    await deps.wa.avisar(a, PLANTILLA_LINK.nombre, PLANTILLA_LINK.idioma, [hora, link]);
    return { ok: true };
  } catch (e) {
    const estado = await asegurarPlantilla(deps.wa, PLANTILLA_LINK).catch(() => 'desconocido');
    const codigo = e instanceof ErrorDeWhatsApp ? e.codigo : String(e);
    return { ok: false, motivo: `pasaron más de 24 h y la plantilla link_reunion no salió (${codigo}, estado: ${estado}); ${aMano}` };
  }
}

async function porMail(reunionId: number, leadId: number, hora: string, link: string, deps: DepsDeMeet): Promise<Resultado> {
  // Va en el hilo de la confirmacion, desde la misma casilla.
  const confirmacion = (await deps.store.salientesDeLead(leadId)).find((s) => s.tipo === 'confirmacion' && s.reunionId === reunionId);
  if (!confirmacion) return { ok: false, motivo: 'no encontré el mail de la confirmación' };
  const id = await deps.store.crearSaliente({
    leadId,
    tipo: 'recordatorio',
    paso: 0,
    casilla: confirmacion.casilla,
    asunto: confirmacion.asunto,
    cuerpo: `Hola! Te paso el link para nuestra reunión de hoy a las ${hora} (hora de Argentina):\n\n${link}\n\n¡Nos vemos!\n${deps.firma}`,
    enRespuestaA: confirmacion.messageId,
    reunionId,
  });
  // Gero ya lo dio al pasar el link: sale sin otra aprobacion.
  if (!(await deps.aprobar(id))) return { ok: false, motivo: 'no pude encolar el mail' };
  return { ok: true };
}
