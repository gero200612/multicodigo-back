import { z } from 'zod';
import { diaArgentino, finDe, horarioEnCastellano, invitacionIcs, linkDeReunion } from './agenda.js';
import type { Casilla } from './config.js';
import { cupoDelDia, enviarMail, type DepsDeEnvio } from './envio.js';
import type { Fuente } from './fuentes.js';
import { horaArgentina, inicioDelDia, proximaVentanaDeEnvio, relojArgentino, sumarDiasHabiles } from './horas.js';
import { rubroPorId, RUBROS } from './rubros.js';
import type { Investigacion, Lead, Recibido, Saliente, Store } from './store.js';

/** Un boton de Telegram: el texto que se ve y lo que vuelve al tocarlo. */
export interface Boton {
  texto: string;
  datos: string;
}

export interface DepsDeVentas extends DepsDeEnvio {
  store: Store;
  casillas: Casilla[];
  firma: string;
  emailGero?: string;
  avisar: (texto: string) => Promise<void>;
  /** Manda una tarjeta con botones y devuelve el id del mensaje. */
  proponer: (texto: string, botones: Boton[]) => Promise<number | undefined>;
  pedirIa: (prompt: string) => Promise<string>;
  /** La de Patán, si tiene cuenta propia asignada; sin esto usa `pedirIa`. */
  pedirIaPatan?: (prompt: string) => Promise<string>;
  fuente: Fuente;
  nombreDeFuente: string;
  recibeMail: (email: string) => Promise<boolean>;
  azar?: () => number;
}

export const MODO = 'modo';

export type Modo = 'aprobar' | 'auto';

export async function modoActual(store: Store): Promise<Modo> {
  return (await store.leerEstado<Modo>(MODO)) ?? 'aprobar';
}

/** `"Ana <ana@x.com>"` -> `ana@x.com` */
export function direccion(de: string): string {
  const m = /<([^>]+)>/.exec(de);
  return (m?.[1] ?? de).trim().toLowerCase();
}

const conRe = (asunto: string) => (/^re:/i.test(asunto) ? asunto : `Re: ${asunto}`);

// ------------------------------------------------------------ borradores

/**
 * El mail inicial y su seguimiento quedan escritos, y despues lo de siempre:
 * en ensayo la muestra a Gero, en modo auto se aprueban solos, si no la
 * tarjeta para aprobar. Lo usa el agente vendedor al dejar el mail listo.
 */
export async function crearSecuencia(
  leadId: number,
  m: { email: string; asunto: string; mensaje: string; seguimiento: string; investigacion: Investigacion },
  deps: DepsDeVentas,
  o: { forzarAprobacion?: boolean } = {},
): Promise<void> {
  await deps.store.actualizarLead(leadId, { estado: 'borrador', email: m.email, investigacion: m.investigacion });
  await deps.store.crearSaliente({ leadId, tipo: 'inicial', paso: 0, asunto: m.asunto, cuerpo: m.mensaje });
  await deps.store.crearSaliente({ leadId, tipo: 'seguimiento', paso: 1, asunto: conRe(m.asunto), cuerpo: m.seguimiento });

  const ensayo = await ensayoActivo(deps);
  const muestraEnviada = ensayo ? await mandarMuestra(leadId, ensayo, deps) : false;
  if (!ensayo && !o.forzarAprobacion && (await modoActual(deps.store)) === 'auto') {
    await aprobarLead(leadId, deps);
    return;
  }
  await proponerBorrador(leadId, deps, { ensayo, muestraEnviada });
}

/**
 * La tarjeta de un borrador en Telegram: todo lo que Homero sabe del negocio,
 * el mail y el seguimiento. Fuera de ensayo lleva Aprobar; en ensayo solo
 * Descartar, porque nada puede salirle a un cliente.
 */
export async function proponerBorrador(
  leadId: number,
  deps: DepsDeVentas,
  o: { ensayo?: string; muestraEnviada?: boolean } = {},
): Promise<boolean> {
  const lead = await deps.store.lead(leadId);
  if (!lead || lead.estado !== 'borrador') return false;
  const salientes = await deps.store.salientesDeLead(leadId);
  const inicial = salientes.find((s) => s.tipo === 'inicial' && s.estado === 'borrador');
  if (!inicial) return false;
  const seguimiento = salientes.find((s) => s.tipo === 'seguimiento' && s.estado === 'borrador');
  const inv = lead.investigacion;
  const rubro = rubroPorId(lead.rubro);
  const fuentes = inv?.fuentes ?? [];
  const chatbots = inv?.chatbots ?? [];

  const tarjeta = [
    `✉️ NUEVO: ${lead.nombre} (${rubro?.nombre ?? lead.rubro}, ${lead.ciudad})`,
    inv?.factibilidad ? `Factibilidad: ${inv.factibilidad}/10 · ${inv.factibilidad_motivo ?? ''}` : undefined,
    `Para: ${lead.email}`,
    lead.telefono ? `Tel: ${lead.telefono}` : undefined,
    inv ? `Qué hacen: ${inv.resumen_empresa}` : undefined,
    inv ? `Qué les falta: ${inv.dolor}` : undefined,
    inv ? `Propuesta: ${inv.idea}` : undefined,
    chatbots.length ? `Ya tienen atención automática: ${chatbots.join(', ')} (no les ofrezco bot)` : undefined,
    fuentes.length ? `De dónde saqué la info:\n${fuentes.map((f) => `• ${f}`).join('\n')}` : undefined,
    '',
    `Asunto: ${inicial.asunto}`,
    '',
    inicial.cuerpo,
    '',
    seguimiento ? `— Seguimiento (a la semana, si no contesta): ${seguimiento.cuerpo}` : undefined,
    '',
    o.ensayo && o.muestraEnviada
      ? `🧪 Ensayo: te mandé a ${o.ensayo} el mail exactamente como le llegaría. Para probar la respuesta, contestalo desde ahí como si fueras ${lead.nombre}. Al cliente no sale nada hasta /ensayo off.`
      : o.ensayo
        ? '🧪 Ensayo: al cliente no sale nada hasta /ensayo off.'
        : 'Para cambiar el primer mail, respondé a este mensaje con el texto nuevo.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
  const botones: Boton[] = o.ensayo
    ? [{ texto: '🗑 Descartar', datos: `de:${lead.id}` }]
    : [
        { texto: '✅ Aprobar', datos: `ap:${lead.id}` },
        { texto: '🗑 Descartar', datos: `de:${lead.id}` },
      ];
  const msg = await deps.proponer(tarjeta, botones);
  if (msg) await deps.store.actualizarSaliente(inicial.id, { telegramMsg: msg });
  return true;
}

/**
 * /prioridad: los `n` borradores con mayor factibilidad, del mejor al peor,
 * para aprobar primero los que mas chances tienen.
 */
export async function proponerPrioridad(deps: DepsDeVentas, n = 5): Promise<number> {
  const leads: Lead[] = [];
  for (const id of await deps.store.leadsEnBorrador()) {
    const l = await deps.store.lead(id);
    if (l) leads.push(l);
  }
  leads.sort((a, b) => (b.investigacion?.factibilidad ?? 0) - (a.investigacion?.factibilidad ?? 0));
  const ensayo = await ensayoActivo(deps);
  let propuestos = 0;
  for (const l of leads.slice(0, n)) {
    if (await proponerBorrador(l.id, deps, { ensayo })) propuestos++;
  }
  return propuestos;
}

/**
 * Cuantos mails nuevos entran hoy: el cupo de todas las casillas, menos lo que
 * ya salio hoy, menos lo que ya esta aprobado esperando turno.
 */
export async function lugaresHoy(
  deps: Pick<DepsDeVentas, 'store' | 'casillas' | 'ahora'>,
): Promise<{ quedan: number; cupo: number; ventanaAbierta: boolean }> {
  const ahora = deps.ahora();
  let cupo = 0;
  let enviados = 0;
  for (const c of deps.casillas) {
    cupo += cupoDelDia(await deps.store.primerEnvio(c.email), ahora);
    enviados += await deps.store.enviosDesde(c.email, inicioDelDia(ahora));
  }
  const { aprobados } = await deps.store.pipeline();
  return {
    quedan: Math.max(0, cupo - enviados - aprobados),
    cupo,
    ventanaAbierta: proximaVentanaDeEnvio(ahora).getTime() <= ahora.getTime(),
  };
}

/** Al salir del ensayo: vuelve a mandar los borradores pendientes, ahora con Aprobar. */
export async function reproponerBorradores(deps: DepsDeVentas): Promise<number> {
  let n = 0;
  for (const id of await deps.store.leadsEnBorrador()) {
    if (await proponerBorrador(id, deps)) n++;
  }
  return n;
}

// ------------------------------------------------------------ ensayo

export const ENSAYO = 'ensayo';

/**
 * A que mail van las muestras, o `undefined` si el ensayo esta apagado.
 *
 * Prendido por defecto (al mail de Gero) hasta que se apague con /ensayo off:
 * lo primero que se quiere ver es que mandaria, antes de que mande.
 */
export async function ensayoActivo(
  deps: Pick<DepsDeVentas, 'store' | 'emailGero'>,
): Promise<string | undefined> {
  const e = await deps.store.leerEstado<{ a?: string; apagado?: boolean }>(ENSAYO);
  if (e?.apagado) return undefined;
  return e?.a ?? deps.emailGero;
}

/**
 * Le manda a Gero el mail de un lead EXACTAMENTE como lo recibiria el cliente:
 * mismo remitente, asunto y cuerpo, sin encabezados. La informacion (de donde
 * salio, factibilidad, seguimiento) va por Telegram. No cuenta para el cupo ni
 * toca al lead.
 */
export async function mandarMuestra(leadId: number, a: string, deps: DepsDeVentas): Promise<boolean> {
  const lead = await deps.store.lead(leadId);
  if (!lead || deps.casillas.length === 0) return false;
  const inicial = (await deps.store.salientesDeLead(leadId)).find((s) => s.tipo === 'inicial');
  if (!inicial) return false;

  // La muestra tambien sale de la casilla nueva: cuenta para su cupo. Quince
  // mails seguidos desde una casilla recien creada la mandan a spam, aunque
  // vayan todos a Gero. Pasado el cupo, el mail queda solo en Telegram.
  const casilla = casillaDeLead(deps.casillas, leadId);
  const ahora = deps.ahora();
  const cupo = cupoDelDia(await deps.store.primerEnvio(casilla.email), ahora);
  if ((await deps.store.enviosDesde(casilla.email, inicioDelDia(ahora))) >= cupo) return false;

  const { messageId } = await deps.correo.enviar(casilla, deps.remitente, {
    para: a,
    asunto: inicial.asunto,
    texto: inicial.cuerpo,
  });
  await deps.store.registrarEnvio({ cuenta: casilla.email, para: a, asunto: inicial.asunto, messageId });
  // Para reconocer la respuesta de Gero a esta muestra como si fuera del cliente.
  if (messageId) await deps.store.guardarEstado(`muestra:${messageId}`, leadId);
  return true;
}

/** Apaga el ensayo y libera los horarios que tomaron las pruebas. */
export async function apagarEnsayo(deps: Pick<DepsDeVentas, 'store'>): Promise<number> {
  const ids = (await deps.store.leerEstado<number[]>('reuniones_de_ensayo')) ?? [];
  for (const id of ids) await deps.store.cancelarReunion(id);
  await deps.store.guardarEstado('reuniones_de_ensayo', null);
  await deps.store.guardarEstado(ENSAYO, { apagado: true });
  return ids.length;
}

/** Manda la muestra de todos los borradores que esperan aprobacion. */
export async function mandarMuestras(a: string, deps: DepsDeVentas): Promise<number> {
  let n = 0;
  for (const leadId of await deps.store.leadsEnBorrador()) {
    if (await mandarMuestra(leadId, a, deps)) n++;
  }
  return n;
}

/** La casilla de un lead: repartidos en ronda, y siempre la misma para su hilo. */
export function casillaDeLead(casillas: Casilla[], leadId: number): Casilla {
  return casillas[leadId % casillas.length]!;
}

/**
 * El proximo turno para un mail inicial: separados entre 4 y 12 minutos entre
 * si. Veinte mails en el mismo minuto es la firma de un robot.
 */
async function proximoTurno(deps: DepsDeVentas): Promise<Date> {
  const azar = deps.azar ?? Math.random;
  const ahora = deps.ahora().getTime();
  const ultimo = await deps.store.leerEstado<string>('ultimo_turno');
  const base = Math.max(ahora, ultimo ? new Date(ultimo).getTime() : 0);
  const turno = new Date(base + (4 + azar() * 8) * 60_000);
  await deps.store.guardarEstado('ultimo_turno', turno.toISOString());
  return turno;
}

/** Aprueba la secuencia entera de un lead y programa el primer mail. */
export async function aprobarLead(leadId: number, deps: DepsDeVentas): Promise<boolean> {
  const lead = await deps.store.lead(leadId);
  if (!lead || lead.estado !== 'borrador' || deps.casillas.length === 0) return false;
  // En ensayo nada sale a un cliente, aunque llegue a tocarse un boton viejo.
  if (await ensayoActivo(deps)) return false;
  const casilla = casillaDeLead(deps.casillas, leadId);
  const salientes = (await deps.store.salientesDeLead(leadId)).filter((s) => s.estado === 'borrador');
  for (const s of salientes) await deps.store.actualizarSaliente(s.id, { estado: 'aprobado', casilla: casilla.email });
  await deps.store.actualizarLead(leadId, { estado: 'aprobado', casilla: casilla.email });
  const inicial = salientes.find((s) => s.tipo === 'inicial');
  if (inicial) {
    await deps.store.encolar({
      tipo: 'enviar_saliente',
      payload: { salienteId: inicial.id },
      requiereIa: false,
      clave: `enviar:${inicial.id}`,
      disponibleDesde: await proximoTurno(deps),
    });
  }
  return true;
}

export async function descartarLead(leadId: number, deps: Pick<DepsDeVentas, 'store'>): Promise<void> {
  for (const s of await deps.store.salientesDeLead(leadId)) {
    if (s.estado === 'borrador' || s.estado === 'aprobado') await deps.store.actualizarSaliente(s.id, { estado: 'cancelado' });
  }
  await deps.store.actualizarLead(leadId, { estado: 'descartado' });
}

/** Aprueba y encola una respuesta (o confirmacion) ya escrita. */
export async function aprobarSaliente(salienteId: number, deps: DepsDeVentas): Promise<boolean> {
  const s = await deps.store.saliente(salienteId);
  if (!s || s.estado !== 'borrador') return false;
  await deps.store.actualizarSaliente(s.id, { estado: 'aprobado' });
  await deps.store.encolar({
    tipo: 'enviar_saliente',
    payload: { salienteId: s.id },
    requiereIa: false,
    clave: `enviar:${s.id}`,
  });
  return true;
}

export async function descartarSaliente(salienteId: number, deps: Pick<DepsDeVentas, 'store'>): Promise<void> {
  const s = await deps.store.saliente(salienteId);
  if (!s || s.estado !== 'borrador') return;
  await deps.store.actualizarSaliente(salienteId, { estado: 'cancelado' });
  // Sin confirmacion no hay reunion: el horario vuelve a estar libre.
  if (s.tipo === 'confirmacion' && s.reunionId) {
    await deps.store.cancelarReunion(s.reunionId);
    await deps.store.actualizarLead(s.leadId, { estado: 'respondio' });
  }
}

// ------------------------------------------------------------ enviar

/** Un solo seguimiento, a la semana (5 dias habiles) si no contesto. */
const DIAS_HASTA_EL_SEGUIMIENTO = 5;

/**
 * Manda un mail de la secuencia y programa el siguiente. Devuelve cuando
 * reintentar si todavia no se puede (fuera de horario, sin cupo).
 */
export async function enviarSaliente(
  payload: unknown,
  deps: DepsDeVentas,
): Promise<{ reprogramarPara: Date } | void> {
  const { salienteId } = z.object({ salienteId: z.number() }).parse(payload);
  const s = await deps.store.saliente(salienteId);
  if (!s || s.estado !== 'aprobado') return;
  const lead = await deps.store.lead(s.leadId);
  if (!lead?.email) return;

  // Si el lead ya contesto (o se dio de baja, o reboto), la secuencia se corta.
  const frio = s.tipo === 'inicial' || s.tipo === 'seguimiento';
  const puedeSeguir =
    s.tipo === 'inicial' ? lead.estado === 'aprobado' : s.tipo === 'seguimiento' ? lead.estado === 'contactado' : true;
  if (!puedeSeguir) {
    await deps.store.actualizarSaliente(s.id, { estado: 'cancelado' });
    return;
  }

  // En ensayo lo frio no sale nunca, y lo demas (respuestas, confirmaciones,
  // recordatorios) le llega a Gero en vez de al cliente.
  const ensayo = await ensayoActivo(deps);
  if (ensayo && frio) {
    await deps.store.actualizarSaliente(s.id, { estado: 'cancelado' });
    return;
  }
  const para = ensayo ?? lead.email;

  const casilla = deps.casillas.find((c) => c.email === s.casilla) ?? casillaDeLead(deps.casillas, lead.id);
  let enRespuestaA = s.enRespuestaA;
  if (s.tipo === 'seguimiento') {
    const inicial = (await deps.store.salientesDeLead(lead.id)).find((x) => x.tipo === 'inicial');
    enRespuestaA = inicial?.messageId;
  }
  let ics: string | undefined;
  if (s.tipo === 'confirmacion' && s.reunionId) {
    const r = await deps.store.reunion(s.reunionId);
    if (r) {
      ics = invitacionIcs({
        uid: `reunion-${r.id}@sincro`,
        inicio: r.inicio,
        fin: r.fin,
        titulo: `Sincro + ${lead.nombre}`,
        descripcion: `Charla de 30 minutos sobre ${lead.investigacion?.idea ?? 'automatizar procesos'}.`,
        link: r.link,
        organizador: casilla.email,
        invitados: [para, ...(deps.emailGero && deps.emailGero !== para ? [deps.emailGero] : [])],
      });
    }
  }

  const r = await enviarMail(
    deps,
    casilla,
    {
      para,
      asunto: s.asunto,
      texto: s.cuerpo,
      enRespuestaA,
      ics,
      cc: s.tipo === 'confirmacion' && !ensayo && deps.emailGero !== para ? deps.emailGero : undefined,
    },
    { enHilo: !frio },
  );

  if (r.tipo === 'esperar') {
    // Los frios se desparraman en las primeras tres horas de la ventana: que
    // no salgan todos juntos a las 9 en punto.
    const jitter = frio && r.motivo !== 'casilla_pausada' ? (deps.azar ?? Math.random)() * 3 * 3_600_000 : 0;
    return { reprogramarPara: new Date(r.hasta.getTime() + jitter) };
  }
  if (r.tipo === 'baja') {
    await deps.store.actualizarSaliente(s.id, { estado: 'cancelado' });
    await deps.store.cancelarSeguimientos(lead.id);
    await deps.store.actualizarLead(lead.id, { estado: 'baja' });
    return;
  }

  await deps.store.marcarEnviado(s.id, r.messageId);
  if (s.tipo === 'inicial') await deps.store.actualizarLead(lead.id, { estado: 'contactado' });
  if (frio) {
    const siguiente = (await deps.store.salientesDeLead(lead.id)).find(
      (x) => x.tipo === 'seguimiento' && x.paso === s.paso + 1 && x.estado === 'aprobado',
    );
    if (siguiente) {
      await deps.store.encolar({
        tipo: 'enviar_saliente',
        payload: { salienteId: siguiente.id },
        requiereIa: false,
        clave: `enviar:${siguiente.id}`,
        disponibleDesde: sumarDiasHabiles(deps.ahora(), DIAS_HASTA_EL_SEGUIMIENTO),
      });
    }
  }
}

// ------------------------------------------------------------ respuestas

/**
 * De quien es un mail que llego: el lead (aunque conteste otra persona de la
 * empresa, por el hilo) y si es Gero probando el ensayo.
 */
export async function identificarRemitente(
  r: Recibido,
  deps: DepsDeVentas,
): Promise<{ lead?: Lead; esEnsayo: boolean; de: string }> {
  const de = direccion(r.de);
  const ensayo = await ensayoActivo(deps);
  const esEnsayo = ensayo !== undefined && de === ensayo;

  let lead = esEnsayo ? undefined : await deps.store.leadPorEmail(de);
  if (!lead && r.enRespuestaA) {
    const deMuestra = esEnsayo ? await deps.store.leerEstado<number>(`muestra:${r.enRespuestaA}`) : undefined;
    // Le escribimos a info@ y contesto juan@: el hilo dice de quien es.
    const nuestro = deMuestra ? undefined : await deps.store.salientePorMessageId(r.enRespuestaA);
    const leadId = deMuestra ?? nuestro?.leadId;
    if (leadId) lead = await deps.store.lead(leadId);
    // Desde aca se le contesta a quien respondio, que es quien quiere hablar.
    if (lead && !esEnsayo) {
      await deps.store.actualizarLead(lead.id, { email: de });
      lead = { ...lead, email: de };
    }
  }
  return { lead, esEnsayo, de };
}

/**
 * Una respuesta ya escrita le llega a Gero con Enviar / No enviar. Los
 * horarios que ofrece quedan anotados para reconocer cual elige el cliente.
 */
export async function proponerRespuestaArmada(
  lead: Lead,
  r: Recibido,
  texto: string,
  horarios: Date[],
  deps: DepsDeVentas,
  prefijo = '',
): Promise<void> {
  if (horarios.length > 0) await deps.store.guardarOferta(lead.id, horarios);
  const id = await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'respuesta',
    paso: 0,
    casilla: r.cuenta,
    asunto: conRe(r.asunto),
    cuerpo: texto,
    enRespuestaA: r.messageId,
  });
  const ensayo = await ensayoActivo(deps);
  const msg = await deps.proponer(
    `${prefijo}↩️ Respuesta para ${lead.nombre}${ensayo ? ' (🧪 ensayo: te llega a vos)' : ''}:\n\n${texto}\n\nPara cambiarla, respondé a este mensaje con el texto nuevo.`,
    [
      { texto: '📤 Enviar', datos: `en:${id}` },
      { texto: '🗑 No enviar', datos: `no:${id}` },
    ],
  );
  if (msg) await deps.store.actualizarSaliente(id, { telegramMsg: msg });
}

/**
 * Reserva el horario y le pasa a Gero la confirmacion para que la apruebe.
 *
 * Nada sale sin su OK, tampoco esto: el horario queda tomado para que nadie
 * mas lo agarre, y si Gero toca "No enviar" se libera.
 */
export async function reservar(
  lead: Lead,
  inicio: Date,
  r: Recibido,
  deps: DepsDeVentas,
  esEnsayo = false,
): Promise<boolean> {
  const link = linkDeReunion();
  const reunionId = await deps.store.crearReunion({ leadId: lead.id, inicio, fin: finDe(inicio), link });
  if (!reunionId) return false;
  if (esEnsayo) {
    // Se cancelan solas con /ensayo off: no pueden quedar tapando la agenda.
    const previas = (await deps.store.leerEstado<number[]>('reuniones_de_ensayo')) ?? [];
    await deps.store.guardarEstado('reuniones_de_ensayo', [...previas, reunionId]);
  } else {
    await deps.store.actualizarLead(lead.id, { estado: 'reunion' });
  }

  const cuerpo = [
    `¡Genial! Quedamos el ${horarioEnCastellano(inicio)} (hora de Argentina). Te mandé la invitación para que te quede en el calendario.`,
    '',
    `Link para entrar: ${link}`,
    '',
    'Son 30 minutos. Si te surge algo, avisame por acá y lo movemos.',
    deps.firma,
  ].join('\n');
  const conf = await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'confirmacion',
    paso: 0,
    casilla: r.cuenta,
    asunto: conRe(r.asunto),
    cuerpo,
    enRespuestaA: r.messageId,
    reunionId,
  });

  // Un recordatorio el mismo dia baja mucho las ausencias.
  const ahora = deps.ahora().getTime();
  const alCliente = new Date(inicio.getTime() - 2 * 3_600_000);
  if (alCliente.getTime() > ahora + 3_600_000) {
    await deps.store.encolar({
      tipo: 'recordatorio',
      payload: { reunionId, a: 'cliente', asunto: conRe(r.asunto), casilla: r.cuenta },
      requiereIa: false,
      clave: `recordatorio:cliente:${reunionId}`,
      disponibleDesde: alCliente,
    });
  }
  await deps.store.encolar({
    tipo: 'recordatorio',
    payload: { reunionId, a: 'gero' },
    requiereIa: false,
    clave: `recordatorio:gero:${reunionId}`,
    disponibleDesde: new Date(Math.max(ahora, inicio.getTime() - 30 * 60_000)),
  });

  const tarjeta = await deps.proponer(
    [
      `${esEnsayo ? '🧪 ENSAYO · ' : ''}📅 ELIGIÓ HORARIO: ${lead.nombre}`,
      `Cuándo: ${horarioEnCastellano(inicio)} (ya lo reservé)`,
      `Link: ${link}`,
      lead.investigacion ? `Qué hacen: ${lead.investigacion.resumen_empresa}` : undefined,
      lead.investigacion ? `Dolor probable: ${lead.investigacion.dolor}` : undefined,
      lead.investigacion ? `Idea que le propusimos: ${lead.investigacion.idea}` : undefined,
      lead.web ? `Web: ${lead.web}` : undefined,
      lead.telefono ? `Tel: ${lead.telefono}` : undefined,
      `Mail: ${lead.email}`,
      '',
      '↩️ Confirmación con la invitación de calendario (te copio a vos):',
      cuerpo,
      '',
      'Si tocás "No enviar", libero el horario.',
    ]
      .filter((l) => l !== undefined)
      .join('\n'),
    [
      { texto: '📤 Enviar', datos: `en:${conf}` },
      { texto: '🗑 No enviar', datos: `no:${conf}` },
    ],
  );
  if (tarjeta) await deps.store.actualizarSaliente(conf, { telegramMsg: tarjeta });
  return true;
}

const PayloadDeRecordatorio = z.object({
  reunionId: z.number(),
  a: z.enum(['cliente', 'gero']),
  asunto: z.string().optional(),
  casilla: z.string().optional(),
});

export async function recordatorio(payload: unknown, deps: DepsDeVentas): Promise<void> {
  const p = PayloadDeRecordatorio.parse(payload);
  const reunion = await deps.store.reunion(p.reunionId);
  if (!reunion) return;
  const lead = await deps.store.lead(reunion.leadId);
  if (!lead) return;

  if (p.a === 'gero') {
    await deps.avisar(
      [
        `⏰ En 30 min: reunión con ${lead.nombre}`,
        `Link: ${reunion.link}`,
        lead.investigacion ? `Qué hacen: ${lead.investigacion.resumen_empresa}` : undefined,
        lead.investigacion ? `Dolor: ${lead.investigacion.dolor}` : undefined,
        lead.investigacion ? `Idea: ${lead.investigacion.idea}` : undefined,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    );
    return;
  }

  const confirmacion = (await deps.store.salientesDeLead(lead.id)).find((s) => s.tipo === 'confirmacion' && s.reunionId === reunion.id);
  const id = await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'recordatorio',
    paso: 0,
    casilla: p.casilla,
    asunto: p.asunto ?? 'Nuestra charla de hoy',
    cuerpo: `Hola, te recuerdo que hoy a las ${horaArgentina(reunion.inicio)} charlamos.\n\nLink: ${reunion.link}\n\n¡Nos vemos!\n${deps.firma}`,
    enRespuestaA: confirmacion?.messageId,
    reunionId: reunion.id,
  });
  const cuerpo = (await deps.store.saliente(id))?.cuerpo ?? '';
  const tarjeta = await deps.proponer(
    `⏰ Recordatorio para ${lead.nombre} (reunión ${horarioEnCastellano(reunion.inicio)}):\n\n${cuerpo}`,
    [
      { texto: '📤 Enviar', datos: `en:${id}` },
      { texto: '🗑 No enviar', datos: `no:${id}` },
    ],
  );
  if (tarjeta) await deps.store.actualizarSaliente(id, { telegramMsg: tarjeta });
}

// ------------------------------------------------------------ rebotes

const DIAS_DE_REBOTES = 7;
/** Con 3 rebotes o mas en la semana y mas de 5% de lo enviado, se frena. */
const TASA_MAXIMA_DE_REBOTE = 0.05;

/**
 * Un rebote marca al lead y cuenta para la casilla. Una casilla que rebota
 * mucho se frena 48 horas: seguir mandando la hace caer en spam para todos.
 */
export async function procesarRebote(r: Recibido, deps: Pick<DepsDeVentas, 'store' | 'avisar' | 'ahora'>) {
  const candidatos = [...new Set((r.cuerpo.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];
  let lead: Lead | undefined;
  for (const c of candidatos) {
    lead = await deps.store.leadPorEmail(c);
    if (lead) break;
  }
  if (!lead) return;
  await deps.store.actualizarLead(lead.id, { estado: 'rebotado' });
  await deps.store.cancelarSeguimientos(lead.id);
  await deps.store.registrarRebote(r.cuenta, lead.email);

  const desde = new Date(deps.ahora().getTime() - DIAS_DE_REBOTES * 24 * 3_600_000);
  const rebotes = await deps.store.rebotesDesde(r.cuenta, desde);
  const enviados = await deps.store.enviosDesde(r.cuenta, desde);
  if (rebotes >= 3 && rebotes / Math.max(1, enviados) > TASA_MAXIMA_DE_REBOTE) {
    const hasta = new Date(deps.ahora().getTime() + 48 * 3_600_000);
    await deps.store.guardarEstado(`casilla_pausada:${r.cuenta}`, { hasta: hasta.toISOString() });
    await deps.avisar(`🛑 Frené ${r.cuenta} 48 horas: rebotaron ${rebotes} de ${enviados} mails esta semana. Así no cae en spam.`);
  }
}

// ------------------------------------------------------------ el dia

/** Tope de borradores esperando aprobacion: mas que esto no se llega a leer. */
const TOPE_DE_BORRADORES = 15;
/**
 * Las vueltas de busqueda del dia: a las 7, 9, 11, 13 y 15 de Argentina. La
 * ultima a las 15 para que lo que encuentre llegue a salir antes de que cierre
 * la ventana de envio (19 hs).
 */
const PRIMERA_BUSQUEDA = 7;
const ULTIMA_BUSQUEDA = 15;
const CADA_HORAS = 2;

/**
 * Lo que Homero hace solo segun la hora. Se llama cada pocos minutos; cada
 * cosa se hace una vez por dia (la marca queda en homero.estado).
 */
export async function planificar(deps: DepsDeVentas): Promise<void> {
  if (deps.casillas.length === 0) return;
  const ahora = deps.ahora();
  const dia = diaArgentino(ahora);
  const { hora, minuto, diaSemana } = relojArgentino(ahora);
  const habil = diaSemana >= 1 && diaSemana <= 5;

  // Completar el cupo del dia: cada dos horas mira cuanto lugar queda y sale a
  // buscar lo que falta. Una sola busqueda por dia se quedaba corta cuando la
  // mitad de lo investigado se descartaba (sin mail, factibilidad baja).
  if (habil && hora >= PRIMERA_BUSQUEDA && hora < ULTIMA_BUSQUEDA + CADA_HORAS) {
    const vuelta = Math.floor((hora - PRIMERA_BUSQUEDA) / CADA_HORAS);
    const marca = `prospeccion:${dia}:${vuelta}`;
    if (!(await deps.store.leerEstado(marca))) {
      await deps.store.guardarEstado(marca, true);
      // Si la anterior sigue buscando o investigando, todavia no se sabe
      // cuantos borradores va a dar: se espera a la proxima vuelta.
      if ((await deps.store.tareasEnCurso(['agente_buscar', 'agente_vender', 'prospectar', 'investigar'])) === 0) {
        const { quedan } = await lugaresHoy(deps);
        const { borradores } = await deps.store.pipeline();
        const faltan = Math.min(TOPE_DE_BORRADORES - borradores, quedan - borradores);
        if (faltan > 0) {
          await deps.store.encolar({
            tipo: 'agente_buscar',
            // El doble: el vendedor descarta los que no encajan.
            payload: { cantidad: Math.min(50, faltan * 2) },
            requiereIa: true,
            clave: `buscar:${dia}:${vuelta}`,
          });
        }
      }
    }
  }

  if (habil && (hora > 20 || (hora === 20 && minuto >= 30)) && !(await deps.store.leerEstado(`resumen:${dia}`))) {
    await deps.store.guardarEstado(`resumen:${dia}`, true);
    await deps.store.encolar({ tipo: 'resumen_diario', payload: {}, requiereIa: false, clave: `resumen:${dia}` });
  }
}

export async function resumenDiario(deps: DepsDeVentas): Promise<void> {
  const ahora = deps.ahora();
  const m = await deps.store.metricasDesde(inicioDelDia(ahora));
  const p = await deps.store.pipeline();
  const proximas = (await deps.store.reunionesDesde(ahora)).slice(0, 5);
  const stats = (await deps.store.rendimientoPorRubro()).filter((s) => s.contactados > 0);
  const lineas = [
    '📊 Resumen de hoy',
    `Leads nuevos: ${m.leads} · Mails enviados: ${m.enviados} · Respuestas: ${m.respuestas} · Reuniones agendadas: ${m.reuniones}`,
    `Esperando tu aprobación: ${p.borradores} · Aprobados por salir: ${p.aprobados}`,
  ];
  if (proximas.length > 0) {
    lineas.push('', 'Próximas reuniones:');
    for (const r of proximas) {
      const lead = await deps.store.lead(r.leadId);
      lineas.push(`• ${horarioEnCastellano(r.inicio)}: ${lead?.nombre ?? '?'}`);
    }
  }
  if (stats.length > 0) {
    lineas.push('', 'Por rubro (respuestas / contactados):');
    for (const s of stats.sort((a, b) => b.respuestas / b.contactados - a.respuestas / a.contactados)) {
      const nombre = RUBROS.find((r) => r.id === s.rubro)?.nombre ?? s.rubro;
      lineas.push(`• ${nombre}: ${s.respuestas}/${s.contactados}${s.reuniones ? ` · ${s.reuniones} reuniones` : ''}`);
    }
  }
  await deps.avisar(lineas.join('\n'));
}

/** Para /rubros. */
export async function tablaDeRubros(store: Store): Promise<string> {
  const stats = await store.rendimientoPorRubro();
  return RUBROS.map((r) => {
    const s = stats.find((x) => x.rubro === r.id);
    return `• ${r.id} (${r.nombre}): ${s?.respuestas ?? 0}/${s?.contactados ?? 0}${s?.reuniones ? `, ${s.reuniones} reuniones` : ''}`;
  }).join('\n');
}

export type { Saliente };
