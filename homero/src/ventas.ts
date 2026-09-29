import { z } from 'zod';
import {
  diaArgentino,
  finDe,
  horarioEnCastellano,
  horariosParaOfrecer,
  invitacionIcs,
  linkDeReunion,
  sigueLibre,
} from './agenda.js';
import type { Casilla } from './config.js';
import { cupoDelDia, enviarMail, type DepsDeEnvio } from './envio.js';
import { linkDeFicha, type Fuente } from './fuentes.js';
import { horaArgentina, inicioDelDia, relojArgentino, sumarDiasHabiles } from './horas.js';
import {
  leerAnalisis,
  leerBorrador,
  promptDeBorrador,
  promptDeRespuesta,
  type Analisis,
} from './prompts.js';
import { elegirCiudad, elegirRubro, rubroPorId, RUBROS } from './rubros.js';
import type { Lead, Recibido, Saliente, Store } from './store.js';

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
  fuente: Fuente;
  nombreDeFuente: string;
  leerSitio: (web: string) => Promise<{ texto: string; mails: string[]; paginas?: string[] } | undefined>;
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

// ------------------------------------------------------------ prospectar

const PayloadDeProspeccion = z.object({
  cantidad: z.number().int().positive(),
  rubro: z.string().optional(),
  ciudad: z.string().optional(),
  vuelta: z.number().int().default(0),
});

/**
 * Busca negocios y encola la investigacion de cada uno. Si la busqueda trae
 * pocos, prueba otra combinacion de rubro y ciudad (hasta tres vueltas).
 */
export async function prospectar(payload: unknown, deps: DepsDeVentas): Promise<void> {
  const p = PayloadDeProspeccion.parse(payload);
  const rubro =
    (p.rubro && rubroPorId(p.rubro)) || elegirRubro(await deps.store.rendimientoPorRubro(), deps.azar);
  const ciudad = p.ciudad ?? elegirCiudad(await deps.store.busquedasDeRubro(rubro.id));

  const hallazgos = await deps.fuente(rubro, ciudad);
  await deps.store.registrarBusqueda({
    rubro: rubro.id,
    ciudad,
    fuente: deps.nombreDeFuente,
    hallados: hallazgos.length,
  });

  let nuevos = 0;
  for (const h of hallazgos) {
    if (nuevos >= p.cantidad) break;
    if (!h.web && !h.email) continue;
    const id = await deps.store.crearLead({
      nombre: h.nombre,
      rubro: rubro.id,
      ciudad,
      web: h.web,
      email: h.email,
      telefono: h.telefono,
      fuente: h.fuente,
      externo: h.externo,
    });
    if (!id) continue;
    await deps.store.encolar({
      tipo: 'investigar',
      payload: { leadId: id },
      requiereIa: true,
      clave: `investigar:${id}`,
    });
    nuevos++;
  }

  const faltan = p.cantidad - nuevos;
  if (faltan > 0 && p.vuelta < 2) {
    // Otra combinacion: sin rubro ni ciudad fijos, que elija de nuevo.
    await deps.store.encolar({
      tipo: 'prospectar',
      payload: { cantidad: faltan, vuelta: p.vuelta + 1 },
      requiereIa: false,
    });
  }
}

// ------------------------------------------------------------ investigar

/**
 * Lee la web, consigue el mail, y le pide a la IA el mail inicial con sus dos
 * seguimientos. Queda como borrador para que Gero lo apruebe (o sale solo en
 * modo automatico).
 */
export async function investigar(payload: unknown, deps: DepsDeVentas): Promise<void> {
  const { leadId } = z.object({ leadId: z.number() }).parse(payload);
  const lead = await deps.store.lead(leadId);
  if (!lead || lead.estado !== 'nuevo') return;

  let texto = '';
  let mails: string[] = [];
  let paginas: string[] = [];
  if (lead.web) {
    const sitio = await deps.leerSitio(lead.web);
    if (sitio) ({ texto, mails, paginas = [] } = sitio);
  }
  const email = lead.email ?? mails[0];
  const descartar = () => deps.store.actualizarLead(lead.id, { estado: 'descartado' });

  if (!email) return descartar();
  // Un mail que rebota quema la casilla: si el dominio no recibe mail, ni se
  // intenta. Y a quien pidio la baja no se le escribe nunca.
  if ((await deps.store.esBaja(email)) || !(await deps.recibeMail(email))) return descartar();
  if (!lead.email) {
    if (await deps.store.leadPorEmail(email)) return descartar();
    await deps.store.actualizarLead(lead.id, { email });
  }

  const b = leerBorrador(await deps.pedirIa(promptDeBorrador(lead, rubroPorId(lead.rubro), texto, deps.firma)));
  if (!b) throw new Error('la IA no devolvio un borrador legible');
  if (!b.encaja) return descartar();

  const fuentes = [linkDeFicha(lead.externo), ...paginas].filter((f): f is string => !!f);
  await deps.store.actualizarLead(lead.id, {
    estado: 'borrador',
    investigacion: { resumen_empresa: b.resumen_empresa, dolor: b.dolor, idea: b.idea, fuentes },
  });
  const inicial = await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'inicial',
    paso: 0,
    asunto: b.asunto,
    cuerpo: b.mensaje,
  });
  await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'seguimiento',
    paso: 1,
    asunto: conRe(b.asunto),
    cuerpo: b.seguimiento,
  });

  const ensayo = await ensayoActivo(deps);
  if (ensayo) await mandarMuestra(lead.id, ensayo, deps);
  if (!ensayo && (await modoActual(deps.store)) === 'auto') {
    await aprobarLead(lead.id, deps);
    return;
  }
  const rubro = rubroPorId(lead.rubro);
  const tarjeta = [
    `✉️ NUEVO: ${lead.nombre} (${rubro?.nombre ?? lead.rubro}, ${lead.ciudad})`,
    `Para: ${email}`,
    `Qué hacen: ${b.resumen_empresa}`,
    `Idea: ${b.idea}`,
    fuentes.length ? `De dónde saqué la info:\n${fuentes.map((f) => `• ${f}`).join('\n')}` : undefined,
    '',
    `Asunto: ${b.asunto}`,
    '',
    b.mensaje,
    '',
    `— Seguimiento (a la semana, si no contesta): ${b.seguimiento}`,
    '',
    ensayo
      ? `🧪 Ensayo: te lo mandé a ${ensayo} tal cual le llegaría. Al cliente no sale nada hasta /ensayo off.`
      : 'Para cambiar el primer mail, respondé a este mensaje con el texto nuevo.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
  // En ensayo no hay boton de aprobar: nada puede salirle a un cliente.
  const botones: Boton[] = ensayo
    ? [{ texto: '🗑 Descartar', datos: `de:${lead.id}` }]
    : [
        { texto: '✅ Aprobar', datos: `ap:${lead.id}` },
        { texto: '🗑 Descartar', datos: `de:${lead.id}` },
      ];
  const msg = await deps.proponer(tarjeta, botones);
  if (msg) await deps.store.actualizarSaliente(inicial, { telegramMsg: msg });
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
 * Le manda a Gero el mail de un lead tal cual lo recibiria el cliente (mismo
 * remitente, asunto y cuerpo), con un encabezado de a quien iba, de donde salio
 * la informacion y el seguimiento. No cuenta para el cupo ni toca al lead.
 */
export async function mandarMuestra(leadId: number, a: string, deps: DepsDeVentas): Promise<boolean> {
  const lead = await deps.store.lead(leadId);
  if (!lead || deps.casillas.length === 0) return false;
  const salientes = await deps.store.salientesDeLead(leadId);
  const inicial = salientes.find((s) => s.tipo === 'inicial');
  if (!inicial) return false;
  const seguimientos = salientes.filter((s) => s.tipo === 'seguimiento');
  const fuentes =
    lead.investigacion?.fuentes ?? [linkDeFicha(lead.externo), lead.web].filter((f): f is string => !!f);
  const rubro = rubroPorId(lead.rubro)?.nombre ?? lead.rubro;

  const encabezado = [
    '──────── ENSAYO: esto NO le llegó al cliente ────────',
    `Iba para: ${lead.email} (${lead.nombre}, ${rubro}, ${lead.ciudad})`,
    lead.telefono ? `Teléfono: ${lead.telefono}` : undefined,
    `Qué hacen: ${lead.investigacion?.resumen_empresa ?? '-'}`,
    `Idea propuesta: ${lead.investigacion?.idea ?? '-'}`,
    'De dónde saqué la info:',
    ...(fuentes.length ? fuentes.map((f) => `  • ${f}`) : ['  • (sin links)']),
    '──────── abajo, el mail tal cual ────────',
  ].filter((l) => l !== undefined);
  const cola = seguimientos.flatMap((s) => [
    '',
    '──────── seguimiento (a la semana, solo si no contesta, mismo hilo) ────────',
    s.cuerpo,
  ]);

  const casilla = casillaDeLead(deps.casillas, leadId);
  await deps.correo.enviar(casilla, deps.remitente, {
    para: a,
    asunto: `[ENSAYO] ${inicial.asunto}`,
    texto: [...encabezado, '', inicial.cuerpo, ...cola].join('\n'),
  });
  return true;
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
        invitados: [lead.email, ...(deps.emailGero ? [deps.emailGero] : [])],
      });
    }
  }

  const r = await enviarMail(
    deps,
    casilla,
    {
      para: lead.email,
      asunto: s.asunto,
      texto: s.cuerpo,
      enRespuestaA,
      ics,
      cc: s.tipo === 'confirmacion' ? deps.emailGero : undefined,
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

const ICONOS: Record<Analisis['tipo'], string> = {
  interesado: '🟢',
  pregunta: '🟡',
  eligio_horario: '📅',
  no_interesado: '⚪',
  baja: '🚫',
  automatico: '🤖',
  otro: '📩',
};

export function mensajeDeRespuesta(r: Recibido, a: Analisis, lead?: Lead): string {
  const rubro = lead ? rubroPorId(lead.rubro)?.nombre ?? lead.rubro : undefined;
  return [
    `${ICONOS[a.tipo]} RESPONDIÓ (${a.tipo.replace('_', ' ')}): ${lead?.nombre ?? a.empresa}`,
    lead ? `Rubro: ${rubro}, ${lead.ciudad}` : undefined,
    `De: ${r.de}`,
    lead?.investigacion ? `Qué hacen: ${lead.investigacion.resumen_empresa}` : `Empresa: ${a.empresa}`,
    lead?.investigacion ? `Le propusimos: ${lead.investigacion.idea}` : undefined,
    lead?.web ? `Web: ${lead.web}` : undefined,
    lead?.telefono ? `Tel: ${lead.telefono}` : undefined,
    `Qué dijo: ${a.resumen}`,
    `Sugerencia: ${a.sugerencia}`,
    `Casilla: ${r.cuenta}`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/**
 * Entiende una respuesta y actua: corta la secuencia, anota bajas, contesta
 * con horarios y, si eligio uno, agenda la reunion.
 */
export async function atenderRespuesta(r: Recibido, deps: DepsDeVentas): Promise<void> {
  const de = direccion(r.de);
  let lead = await deps.store.leadPorEmail(de);
  if (!lead && r.enRespuestaA) {
    // Le escribimos a info@ y contesto juan@: el hilo dice de quien es.
    const nuestro = await deps.store.salientePorMessageId(r.enRespuestaA);
    if (nuestro) lead = await deps.store.lead(nuestro.leadId);
    // Desde aca se le contesta a quien respondio, que es quien quiere hablar.
    if (lead) {
      await deps.store.actualizarLead(lead.id, { email: de });
      lead = { ...lead, email: de };
    }
  }
  const ahora = deps.ahora();
  const enviados = lead ? (await deps.store.salientesDeLead(lead.id)).filter((s) => s.estado === 'enviado') : [];
  const ofrecidos = lead ? await deps.store.oferta(lead.id) : undefined;
  const tomados = (await deps.store.reunionesDesde(new Date(ahora.getTime() - 3_600_000))).map((x) => x.inicio);
  const ocupados = await deps.store.diasOcupados();
  const libres = horariosParaOfrecer(ahora, tomados, ocupados);

  const a = leerAnalisis(
    await deps.pedirIa(
      promptDeRespuesta(r, {
        lead,
        loQueLeMandamos: enviados.at(-1)?.cuerpo,
        ofrecidos,
        libres,
        firma: deps.firma,
      }),
    ),
  );
  if (a.tipo === 'automatico') return;
  if (lead) await deps.store.cancelarSeguimientos(lead.id);

  if (a.tipo === 'baja') {
    await deps.store.agregarBaja(de, 'la pidió por mail');
    if (lead) await deps.store.actualizarLead(lead.id, { estado: 'baja' });
    await deps.avisar(mensajeDeRespuesta(r, a, lead));
    return;
  }
  if (a.tipo === 'no_interesado') {
    if (lead) await deps.store.actualizarLead(lead.id, { estado: 'cerrado' });
    await deps.avisar(mensajeDeRespuesta(r, a, lead));
    return;
  }

  if (a.tipo === 'eligio_horario' && lead && ofrecidos && a.horario_elegido) {
    const elegido = ofrecidos[a.horario_elegido - 1];
    if (elegido && sigueLibre(elegido, tomados, ocupados) && (await reservar(lead, elegido, r, deps))) return;
    await deps.avisar(
      `${mensajeDeRespuesta(r, a, lead)}\n\n⚠️ Eligió ${elegido ? horarioEnCastellano(elegido) : 'un horario'} pero ya no está libre. Respondele vos con otro.`,
    );
    return;
  }

  // Un interesado que escribio solo (no estaba en la base) se vuelve lead:
  // asi puede seguir el mismo camino hasta la reunion.
  if (!lead && (a.tipo === 'interesado' || a.tipo === 'pregunta')) {
    const id = await deps.store.crearLead({
      nombre: a.empresa !== 'desconocida' ? a.empresa : r.de,
      rubro: 'entrante',
      ciudad: '-',
      email: de,
      fuente: 'entrante',
    });
    lead = id ? await deps.store.lead(id) : undefined;
  }
  if (lead) await deps.store.actualizarLead(lead.id, { estado: 'respondio' });

  const resumen = mensajeDeRespuesta(r, a, lead);
  if (!lead || !a.respuesta || (a.tipo !== 'interesado' && a.tipo !== 'pregunta')) {
    await deps.avisar(resumen);
    return;
  }

  await deps.store.guardarOferta(lead.id, libres);
  const auto = (await modoActual(deps.store)) === 'auto';
  const id = await deps.store.crearSaliente({
    leadId: lead.id,
    tipo: 'respuesta',
    paso: 0,
    casilla: r.cuenta,
    asunto: conRe(r.asunto),
    cuerpo: a.respuesta,
    enRespuestaA: r.messageId,
  });
  if (auto) {
    await aprobarSaliente(id, deps);
    await deps.avisar(`${resumen}\n\n↩️ Le contesté:\n${a.respuesta}`);
    return;
  }
  const msg = await deps.proponer(
    `${resumen}\n\n↩️ Respuesta propuesta:\n${a.respuesta}\n\nPara cambiarla, respondé a este mensaje con el texto nuevo.`,
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
export async function reservar(lead: Lead, inicio: Date, r: Recibido, deps: DepsDeVentas): Promise<boolean> {
  const link = linkDeReunion();
  const reunionId = await deps.store.crearReunion({ leadId: lead.id, inicio, fin: finDe(inicio), link });
  if (!reunionId) return false;
  await deps.store.actualizarLead(lead.id, { estado: 'reunion' });

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
      `📅 ELIGIÓ HORARIO: ${lead.nombre}`,
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

/** Cuantos iniciales nuevos buscar por dia, como parte del cupo total. */
const PARTE_PARA_NUEVOS = 0.6;
/** Tope de borradores esperando aprobacion: mas que esto no se llega a leer. */
const TOPE_DE_BORRADORES = 15;

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

  if (habil && hora >= 7 && !(await deps.store.leerEstado(`prospeccion:${dia}`))) {
    await deps.store.guardarEstado(`prospeccion:${dia}`, true);
    let capacidad = 0;
    for (const c of deps.casillas) capacidad += cupoDelDia(await deps.store.primerEnvio(c.email), ahora);
    const { borradores, aprobados } = await deps.store.pipeline();
    const objetivo = Math.round(capacidad * PARTE_PARA_NUEVOS);
    const faltan = Math.min(TOPE_DE_BORRADORES - borradores, objetivo - borradores - aprobados);
    if (faltan > 0) {
      await deps.store.encolar({
        tipo: 'prospectar',
        payload: { cantidad: faltan },
        requiereIa: false,
        clave: `prospectar:${dia}`,
      });
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
