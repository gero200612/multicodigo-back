import { Bot } from 'grammy';
import { PAUSA_IA, PAUSA_MANUAL } from './cola.js';
import type { Config } from './config.js';
import { cupoDelDia } from './envio.js';
import { horaArgentina, inicioDelDia } from './horas.js';
import { ErrorDeCuenta, ErrorDeLimite, pedirTexto } from './ia.js';
import { SISTEMA } from './prompts.js';
import type { Store } from './store.js';

export const NOMBRE = 'Homero';

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

export function crearBot(config: Config, store: Store, ahora: () => Date = () => new Date()) {
  const bot = new Bot(config.telegramToken);

  // Texto plano SIEMPRE, sin parse_mode: los avisos llevan pedazos de mails de
  // desconocidos, y con HTML un mail podria meter links o formato en el chat.
  const avisar = async (texto: string) => {
    if (config.chatId === undefined) {
      console.warn(`[homero] sin HOMERO_CHAT_ID, no puedo avisar: ${texto.slice(0, 120)}`);
      return;
    }
    for (const parte of partir(texto)) await bot.api.sendMessage(config.chatId, parte);
  };

  bot.command('start', async (ctx) => {
    if (config.chatId === undefined) {
      await ctx.reply(`Hola, soy ${NOMBRE}. Tu chat id es ${ctx.chat.id}. Ponelo en HOMERO_CHAT_ID y reiniciame.`);
      return;
    }
    if (!esDuenio(config.chatId, ctx.chat.id)) return;
    await ctx.reply(
      `Hola Gero, soy ${NOMBRE}. Comandos:\n/estado\n/pausa\n/seguir\n/probar_ia\n/probar_mail <destino> [casilla 1-3]`,
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
    lineas.push(
      pausaIa
        ? `🧠 Claude en pausa (${pausaIa.motivo}) hasta ${horaArgentina(new Date(pausaIa.hasta))}.`
        : '🧠 Claude disponible.',
    );
    const t = await store.contarTareas();
    lineas.push(`📋 Tareas: ${t.pendientes} pendientes, ${t.fallidas} fallidas.`);
    if (config.casillas.length === 0) lineas.push('✉️ Sin casillas configuradas.');
    for (const c of config.casillas) {
      const hoy = await store.enviosDesde(c.email, inicioDelDia(ahora()));
      const cupo = cupoDelDia(await store.primerEnvio(c.email), ahora());
      lineas.push(`✉️ ${c.email}: ${hoy}/${cupo} hoy`);
    }
    await ctx.reply(lineas.join('\n'));
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
      const r = await pedirTexto('Presentate en una sola oración.', {
        sistema: SISTEMA,
        modelo: config.modelo,
      });
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

  bot.catch((err) => console.error('[homero] error del bot:', err.error));

  return { bot, avisar };
}
