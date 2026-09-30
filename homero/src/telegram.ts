import { Bot, InlineKeyboard } from 'grammy';
import { diaArgentino, horarioEnCastellano } from './agenda.js';
import { PAUSA_IA, PAUSA_MANUAL } from './cola.js';
import type { Config } from './config.js';
import { cupoDelDia } from './envio.js';
import { horaArgentina, inicioDelDia } from './horas.js';
import { ErrorDeCuenta, ErrorDeLimite, pedirTexto } from './ia.js';
import { SISTEMA } from './prompts.js';
import { CIUDADES, rubroPorId, RUBROS, zonaPorNombre } from './rubros.js';
import type { Store } from './store.js';
import { ENSAYO, MODO, modoActual, tablaDeRubros, type Boton } from './ventas.js';

export const NOMBRE = 'Homero';

/** Lo que aparece en el boton de menu de Telegram, al lado del campo de texto. */
export const COMANDOS = [
  { command: 'estado', description: 'Cómo vengo: pausas, cupo y borradores' },
  { command: 'hoy', description: 'Números del día' },
  { command: 'buscar', description: 'Salir a buscar ya: /buscar [rubro] [zona]' },
  { command: 'prioridad', description: 'Los 5 borradores con más factibilidad' },
  { command: 'cortar', description: 'Cancelar las búsquedas pendientes' },
  { command: 'pausa', description: 'Frenar todo (las bandejas se siguen leyendo)' },
  { command: 'seguir', description: 'Retomar después de /pausa' },
  { command: 'reuniones', description: 'Las próximas reuniones' },
  { command: 'ocupado', description: 'Bloquear un día: /ocupado 30/9' },
  { command: 'libre', description: 'Liberar un día: /libre 30/9' },
  { command: 'rubros', description: 'Cómo responde cada rubro' },
  { command: 'ensayo', description: 'Modo ensayo: /ensayo [mail] | off' },
  { command: 'modo', description: 'Pedir OK o automático: /modo aprobar | auto' },
  { command: 'probar_ia', description: 'Probar que Claude responde' },
  { command: 'probar_mail', description: 'Mail de prueba: /probar_mail tu@mail.com' },
  { command: 'start', description: 'Ayuda' },
];

/**
 * Lo que los botones y comandos le piden al resto de Homero. Se inyecta
 * despues de armar el bot porque esas acciones necesitan el `proponer` del
 * propio bot.
 */
export interface Acciones {
  aprobarLead(id: number): Promise<boolean>;
  descartarLead(id: number): Promise<void>;
  aprobarSaliente(id: number): Promise<boolean>;
  descartarSaliente(id: number): Promise<void>;
  /** Manda la muestra de cada borrador pendiente. Devuelve cuantas. */
  mandarMuestras(a: string): Promise<number>;
  /** A donde van las muestras ahora, o nada si el ensayo esta apagado. */
  ensayo(): Promise<string | undefined>;
  /** Apaga el ensayo y libera los horarios de prueba. Devuelve cuantos. */
  apagarEnsayo(): Promise<number>;
  /** Reenvia los borradores pendientes con el boton de Aprobar. Devuelve cuantos. */
  reproponerBorradores(): Promise<number>;
  /** Reenvia los `n` borradores de mayor factibilidad. Devuelve cuantos. */
  prioridad(n: number): Promise<number>;
  /** Cuantos mails nuevos entran hoy. */
  lugaresHoy(): Promise<{ quedan: number; cupo: number; ventanaAbierta: boolean }>;
  /** Marca o desmarca un horario para ofrecer. Devuelve los botones nuevos. */
  alternarHorario(leadId: number, i: number): Promise<Boton[] | undefined>;
  armarRespuesta(leadId: number): Promise<'encolada' | 'sin_horarios' | 'vencida'>;
  noResponder(leadId: number): Promise<void>;
}

/** Hasta tres botones van en una fila; con mas, uno por renglon. */
export function teclado(botones: Boton[]): InlineKeyboard {
  const t = new InlineKeyboard();
  botones.forEach((b, i) => {
    t.text(b.texto, b.datos);
    if (botones.length > 3 && i < botones.length - 1) t.row();
  });
  return t;
}

/**
 * Si este chat puede darle ordenes a Homero.
 *
 * Un solo dueño, por id de chat. Sin `HOMERO_CHAT_ID` no obedece a nadie: solo
 * contesta /start con el id, que es lo que hace falta para configurarlo.
 */
export function esDuenio(chatIdConfigurado: number | undefined, chatId: number | undefined): boolean {
  return chatIdConfigurado !== undefined && chatId === chatIdConfigurado;
}

/** Telegram corta en 4096; se parte en renglones para no cortar una palabra. */
export function partir(texto: string, largo = 4000): string[] {
  const partes: string[] = [];
  let actual = '';
  for (const linea of texto.split('\n')) {
    if (actual && actual.length + linea.length + 1 > largo) {
      partes.push(actual);
      actual = '';
    }
    actual = actual ? `${actual}\n${linea}` : linea;
    while (actual.length > largo) {
      partes.push(actual.slice(0, largo));
      actual = actual.slice(largo);
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

/** `30/9` o `30/09/2026` -> `2026-09-30`, tomando el año actual si falta. */
export function leerDia(texto: string, ahora: Date): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(texto.trim());
  if (!m) return undefined;
  const anio = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(diaArgentino(ahora).slice(0, 4));
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

export function crearBot(config: Config, store: Store, ahora: () => Date = () => new Date()) {
  const bot = new Bot(config.telegramToken);
  let acciones: Acciones | undefined;

  // Texto plano SIEMPRE, sin parse_mode: los avisos llevan pedazos de mails y
  // webs de desconocidos, y con HTML podrian meter links o formato en el chat.
  const avisar = async (texto: string) => {
    if (config.chatId === undefined) {
      console.warn(`[homero] sin HOMERO_CHAT_ID, no puedo avisar: ${texto.slice(0, 120)}`);
      return;
    }
    for (const parte of partir(texto)) await bot.api.sendMessage(config.chatId, parte);
  };

  /** Una tarjeta con botones. Los botones van en el ultimo pedazo. */
  const proponer = async (texto: string, botones: Boton[]) => {
    if (config.chatId === undefined) return undefined;
    const partes = partir(texto);
    let ultimo: number | undefined;
    for (const [i, parte] of partes.entries()) {
      const m = await bot.api.sendMessage(
        config.chatId,
        parte,
        i === partes.length - 1 ? { reply_markup: teclado(botones) } : {},
      );
      ultimo = m.message_id;
    }
    return ultimo;
  };

  bot.command('start', async (ctx) => {
    if (config.chatId === undefined) {
      await ctx.reply(`Hola, soy ${NOMBRE}. Tu chat id es ${ctx.chat.id}. Ponelo en HOMERO_CHAT_ID y reiniciame.`);
      return;
    }
    if (!esDuenio(config.chatId, ctx.chat.id)) return;
    await ctx.reply(
      [
        `Hola Gero, soy ${NOMBRE}. Comandos:`,
        '/estado · cómo vengo',
        '/hoy · números del día',
        '/reuniones · las próximas',
        '/ensayo [mail] | off · te mando a vos los mails en vez de al cliente',
        '/modo aprobar | auto · si te pido OK para cada mail',
        '/buscar [rubro] [ciudad] · salgo a buscar ya',
        '/rubros · cómo responde cada rubro',
        '/ocupado 30/9 · /libre 30/9 · días sin reuniones',
        '/prioridad [n] · los borradores con más factibilidad',
        '/cortar · cancela las búsquedas pendientes',
        '/pausa · /seguir',
        '/probar_ia · /probar_mail <destino> [1-3]',
      ].join('\n'),
    );
  });

  // Todo lo que sigue es solo para el dueño. Al resto no se le contesta nada.
  bot.use(async (ctx, next) => {
    if (esDuenio(config.chatId, ctx.chat?.id)) await next();
  });

  bot.command('estado', async (ctx) => {
    const lineas: string[] = [];
    const pausaIa = await store.leerEstado<{ hasta: string; motivo: string }>(PAUSA_IA);
    const pausaManual = await store.leerEstado(PAUSA_MANUAL);
    lineas.push(pausaManual ? '⏸ En pausa (manual). /seguir para retomar.' : '▶️ Andando.');
    const ensayo = await acciones?.ensayo();
    lineas.push(ensayo ? `🧪 Ensayo: los mails van a ${ensayo}, no a clientes. /ensayo off para arrancar.` : '🚀 Ensayo apagado: los aprobados salen a clientes.');
    lineas.push(`Modo: ${(await modoActual(store)) === 'auto' ? 'automático' : 'te pido aprobación'}`);
    lineas.push(
      pausaIa
        ? `🧠 Claude en pausa (${pausaIa.motivo}) hasta ${horaArgentina(new Date(pausaIa.hasta))}.`
        : '🧠 Claude disponible.',
    );
    const t = await store.contarTareas();
    const p = await store.pipeline();
    lineas.push(`📋 Tareas: ${t.pendientes} pendientes, ${t.fallidas} fallidas.`);
    lineas.push(`✉️ Esperando tu OK: ${p.borradores} · aprobados por salir: ${p.aprobados}`);
    lineas.push(`🔎 Busco en: ${config.placesKey ? 'Google Places' : 'OpenStreetMap'}`);
    if (config.casillas.length === 0) lineas.push('✉️ Sin casillas configuradas.');
    for (const c of config.casillas) {
      const hoy = await store.enviosDesde(c.email, inicioDelDia(ahora()));
      const cupo = cupoDelDia(await store.primerEnvio(c.email), ahora());
      const pausa = await store.leerEstado<{ hasta: string }>(`casilla_pausada:${c.email}`);
      const frenada = pausa && new Date(pausa.hasta).getTime() > ahora().getTime() ? ' 🛑 frenada por rebotes' : '';
      lineas.push(`   ${c.email}: ${hoy}/${cupo} hoy${frenada}`);
    }
    await ctx.reply(lineas.join('\n'));
  });

  bot.command('hoy', async (ctx) => {
    const m = await store.metricasDesde(inicioDelDia(ahora()));
    await ctx.reply(
      `Hoy: ${m.leads} leads nuevos, ${m.enviados} mails enviados, ${m.respuestas} respuestas, ${m.reuniones} reuniones agendadas.`,
    );
  });

  bot.command('reuniones', async (ctx) => {
    const rs = await store.reunionesDesde(ahora());
    if (rs.length === 0) {
      await ctx.reply('No hay reuniones agendadas.');
      return;
    }
    const lineas = [];
    for (const r of rs.slice(0, 15)) {
      const lead = await store.lead(r.leadId);
      lineas.push(`📅 ${horarioEnCastellano(r.inicio)}: ${lead?.nombre ?? '?'}\n   ${r.link}`);
    }
    await ctx.reply(lineas.join('\n'));
  });

  bot.command('ensayo', async (ctx) => {
    const pedido = (ctx.match ?? '').trim();
    if (pedido.toLowerCase() === 'off') {
      const liberadas = (await acciones?.apagarEnsayo()) ?? 0;
      await ctx.reply(
        '🚀 Ensayo apagado. Ya no te mando los borradores por mail, y lo que apruebes le llega al cliente.' +
          (liberadas > 0 ? `\nLiberé ${liberadas} horario(s) que habían tomado las pruebas.` : ''),
      );
      const n = (await acciones?.reproponerBorradores()) ?? 0;
      if (n > 0) await ctx.reply(`Te reenvío ${n} borrador(es) que tenías pendientes, ahora con ✅ Aprobar.`);
      return;
    }
    if (pedido && !/^\S+@\S+\.\S+$/.test(pedido)) {
      await ctx.reply('Uso: /ensayo tu@mail.com · /ensayo off · /ensayo (para ver cómo está)');
      return;
    }
    if (pedido) await store.guardarEstado(ENSAYO, { a: pedido.toLowerCase() });
    else if ((await store.leerEstado<{ apagado?: boolean }>(ENSAYO))?.apagado) await store.guardarEstado(ENSAYO, null);
    const a = await acciones?.ensayo();
    if (!a) {
      await ctx.reply('No tengo a qué mail mandarte las muestras: /ensayo tu@mail.com');
      return;
    }
    const n = (await acciones?.mandarMuestras(a)) ?? 0;
    await ctx.reply(
      `🧪 Ensayo prendido: cada mail nuevo te llega a ${a} tal cual lo recibiría el cliente, con de dónde saqué la info. Al cliente no sale nada.` +
        (n > 0 ? `\nTe acabo de mandar ${n} muestra(s) de los borradores que ya tenía.` : ''),
    );
  });

  bot.command('modo', async (ctx) => {
    const pedido = (ctx.match ?? '').trim().toLowerCase();
    if (pedido !== 'aprobar' && pedido !== 'auto') {
      await ctx.reply(`Modo actual: ${await modoActual(store)}. Uso: /modo aprobar | /modo auto`);
      return;
    }
    await store.guardarEstado(MODO, pedido);
    await ctx.reply(
      pedido === 'auto'
        ? '🤖 Modo automático: mando los mails y respuestas sin pedirte OK. Te sigo avisando todo.'
        : '✋ Modo aprobación: cada mail nuevo y cada respuesta te la paso antes.',
    );
  });

  bot.command('buscar', async (ctx) => {
    const partes = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const rubro = partes[0] ? rubroPorId(partes[0]) : undefined;
    if (partes[0] && !rubro) {
      await ctx.reply(`No conozco ese rubro. Opciones: ${RUBROS.map((r) => r.id).join(', ')}`);
      return;
    }
    const pedida = partes.slice(1).join(' ') || undefined;
    const ciudad = pedida ? zonaPorNombre(pedida)?.nombre ?? pedida : undefined;
    if (ciudad && !CIUDADES.includes(ciudad)) {
      await ctx.reply(`Ojo: "${ciudad}" no está en mi zona (${CIUDADES.slice(0, 4).join(', ')}…), la busco igual.`);
    }
    await store.encolar({
      tipo: 'prospectar',
      payload: { cantidad: 3, rubro: rubro?.id, ciudad },
      requiereIa: false,
    });
    await ctx.reply(`🔎 Salgo a buscar ${rubro?.nombre ?? 'el rubro que mejor viene respondiendo'}${ciudad ? ` en ${ciudad}` : ''}. Te paso los borradores.`);
  });

  bot.command('rubros', async (ctx) => {
    await ctx.reply(`Respuestas / contactados por rubro:\n${await tablaDeRubros(store)}`);
  });

  for (const [comando, ocupado] of [
    ['ocupado', true],
    ['libre', false],
  ] as const) {
    bot.command(comando, async (ctx) => {
      const dia = leerDia(ctx.match ?? '', ahora());
      if (!dia) {
        await ctx.reply(`Uso: /${comando} 30/9`);
        return;
      }
      await store.marcarOcupado(dia, ocupado);
      await ctx.reply(ocupado ? `🚫 El ${dia} no ofrezco reuniones.` : `✅ El ${dia} vuelvo a ofrecer reuniones.`);
    });
  }

  bot.command('prioridad', async (ctx) => {
    const n = Math.min(20, Math.max(1, Number((ctx.match ?? '').trim()) || 5));
    await ctx.reply(`⭐ Te paso los ${n} borradores con más factibilidad, del mejor al peor:`);
    const enviados = (await acciones?.prioridad(n)) ?? 0;
    const l = await acciones?.lugaresHoy();
    await ctx.reply(
      enviados === 0
        ? 'No hay borradores esperando.'
        : `Listo. ${l ? `Hoy entran ${l.quedan} mail(s) nuevo(s) más (cupo ${l.cupo}).` : ''}`,
    );
  });

  bot.command('cortar', async (ctx) => {
    const n = await store.cancelarTareas(['prospectar', 'investigar']);
    await ctx.reply(
      n > 0
        ? `✂️ Corté ${n} búsqueda(s) e investigación(es) pendientes. Lo que ya estaba escrito queda como estaba.`
        : 'No había búsquedas pendientes.',
    );
  });

  bot.command('pausa', async (ctx) => {
    await store.guardarEstado(PAUSA_MANUAL, { desde: ahora().toISOString() });
    await ctx.reply('⏸ Pausado. No mando ni resumo nada hasta /seguir. Las bandejas se siguen leyendo.');
  });

  bot.command('seguir', async (ctx) => {
    await store.guardarEstado(PAUSA_MANUAL, null);
    await ctx.reply('▶️ Sigo.');
  });

  bot.command('probar_ia', async (ctx) => {
    await ctx.reply('Probando Claude…');
    try {
      const r = await pedirTexto('Presentate en una sola oración.', { sistema: SISTEMA, modelo: config.modelo });
      await ctx.reply(`🧠 ${r}`);
    } catch (err) {
      if (err instanceof ErrorDeLimite) await ctx.reply(`⏸ Sin uso de Claude. Resetea: ${err.resets ?? 'no dijo'}.`);
      else if (err instanceof ErrorDeCuenta) await ctx.reply('⚠️ La cuenta de Claude no está cargada o venció.');
      else await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('probar_mail', async (ctx) => {
    const [destino, n] = (ctx.match ?? '').trim().split(/\s+/);
    const casilla = config.casillas[Number(n ?? '1') - 1];
    if (!destino || !/^\S+@\S+\.\S+$/.test(destino)) {
      await ctx.reply('Uso: /probar_mail tu@mail.com [1-3]');
      return;
    }
    if (!casilla) {
      await ctx.reply('Esa casilla no está configurada.');
      return;
    }
    await store.encolar({
      tipo: 'enviar_mail',
      requiereIa: false,
      payload: {
        casilla: casilla.email,
        para: destino,
        asunto: `Prueba de ${NOMBRE}`,
        texto: `Hola, esto es una prueba de ${NOMBRE} desde ${casilla.email}. Si te llegó, el envío anda. Respondé este mail para probar la lectura.`,
        prueba: true,
      },
    });
    await ctx.reply(`Encolado: prueba desde ${casilla.email} a ${destino}.`);
  });

  // Los botones de las tarjetas.
  bot.on('callback_query:data', async (ctx) => {
    const [accion, crudo, extra] = ctx.callbackQuery.data.split(':');
    const id = Number(crudo);
    if (!acciones || !Number.isInteger(id)) {
      await ctx.answerCallbackQuery({ text: 'No entendí ese botón.' });
      return;
    }
    // Marcar un horario no cierra la tarjeta: se redibujan los botones.
    if (accion === 'ho') {
      const botones = await acciones.alternarHorario(id, Number(extra));
      if (!botones) {
        await ctx.answerCallbackQuery({ text: 'Esta elección ya no está vigente.' });
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: teclado(botones) }).catch(() => undefined);
      return;
    }
    if (accion === 'ar') {
      const r = await acciones.armarRespuesta(id);
      if (r === 'sin_horarios') {
        await ctx.answerCallbackQuery({ text: 'Marcá al menos un horario.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: r === 'encolada' ? '✍️ La escribo y te la paso.' : 'Ya no está vigente.' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      if (r === 'encolada') {
        await ctx.reply('✍️ Escribo la respuesta con esos horarios y te la paso para enviar.', {
          reply_parameters: { message_id: ctx.callbackQuery.message!.message_id },
        }).catch(() => undefined);
      }
      return;
    }
    let resultado: string;
    switch (accion) {
      case 'nr':
        await acciones.noResponder(id);
        resultado = '🗑 No le respondo.';
        break;
      case 'ap': {
        if (!(await acciones.aprobarLead(id))) {
          resultado = 'Ya estaba decidido.';
          break;
        }
        const l = await acciones.lugaresHoy();
        resultado = l.ventanaAbierta
          ? `✅ Aprobado. ${l.quedan > 0 ? `Te quedan ${l.quedan} lugar(es) para hoy (cupo ${l.cupo}).` : `Hoy ya está lleno el cupo (${l.cupo}): este sale el próximo día hábil.`}`
          : `✅ Aprobado. Hoy ya cerró la ventana de envío: sale el próximo día hábil desde las 9. Lugares para ese día: ${l.quedan} de ${l.cupo}.`;
        break;
      }
      case 'de':
        await acciones.descartarLead(id);
        resultado = '🗑 Descartado.';
        break;
      case 'en':
        resultado = (await acciones.aprobarSaliente(id)) ? '📤 Enviando.' : 'Ya estaba decidido.';
        break;
      case 'no':
        await acciones.descartarSaliente(id);
        resultado = '🗑 No se envía.';
        break;
      default:
        resultado = 'No entendí ese botón.';
    }
    await ctx.answerCallbackQuery({ text: resultado });
    // Se sacan los botones para que no se toquen dos veces.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.reply(resultado, { reply_parameters: { message_id: ctx.callbackQuery.message!.message_id } }).catch(() => undefined);
  });

  // Corregir un borrador: responderle a la tarjeta con el texto nuevo.
  bot.on('message:text', async (ctx) => {
    const citado = ctx.message.reply_to_message?.message_id;
    if (!citado) return;
    const s = await store.salientePorTelegram(citado);
    if (!s || s.estado !== 'borrador') {
      await ctx.reply('Ese mensaje ya no se puede cambiar.');
      return;
    }
    await store.actualizarSaliente(s.id, { cuerpo: ctx.message.text });
    await ctx.reply('✏️ Listo, lo cambié. Tocá el botón de la tarjeta para mandarlo.');
  });

  bot.catch((err) => console.error('[homero] error del bot:', err.error));

  return {
    bot,
    avisar,
    proponer,
    conectar: (a: Acciones) => {
      acciones = a;
    },
  };
}
