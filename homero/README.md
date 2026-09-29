# Homero

El agente comercial. Busca clientes para automatizaciones con IA, les escribe
desde tres Gmail, hace el seguimiento, agenda reuniones y le avisa a Gero por
Telegram quién respondió y qué empresa es.

Es un servicio aparte de Punchi: su propio bot de Telegram, su propia cuenta de
Claude y su propio esquema (`homero.*`) en la misma base de Supabase.

## Estado: fase 1

| Fase | Qué | Estado |
|---|---|---|
| 1 | Servicio, bot, esquema, leer y mandar con Gmail, espera por límite | ✅ |
| 2 | Buscar negocios (Google Places), leer sus webs, redactar, aprobación por Telegram | pendiente |
| 3 | Agenda propia, invitación .ics, link de Jitsi, resumen de empresa antes de la reunión | pendiente |
| 4 | Rotar las 3 casillas, frenar ante rebotes, modo automático, métricas | pendiente |

Hoy Homero:
- lee las bandejas cada 10 minutos y te manda por Telegram un resumen de cada
  respuesta (qué empresa es, qué dijo, qué conviene hacer);
- si alguien pide la baja, lo anota y nunca más le escribe;
- manda mails respetando horario (lunes a viernes de 9 a 19) y cupo por casilla
  (arranca en 5 por día y sube de a 3 cada dos días, hasta 25);
- si Claude se queda sin uso, **espera al reset y sigue**, sin tope de horas.
  Mientras espera sigue mandando lo que ya estaba escrito.

## Cómo está armado

```
Telegram (polling) ─┐
3 Gmail (IMAP/SMTP) ┼─ homero ── Claude (SDK, SIN herramientas, cuenta propia)
Supabase (homero.*) ┘
```

El modelo nunca tiene herramientas (`tools: []`): lee mails de desconocidos, así
que solo puede devolver texto. Lo que se hace con ese texto (mandar, anotar una
baja, avisar) lo decide este proceso, con sus topes en el código.

Todo pasa por la cola `homero.tareas`: un reinicio o un límite retoma en la
tarea exacta. La pausa por límite vive en `homero.estado`, así que sobrevive a
un reinicio.

## Puesta en marcha (una vez)

1. **Bot de Telegram:** en @BotFather, `/newbot`, llamalo Homero. Guardá el token.
2. **Gmail:** en cada casilla, activá la verificación en 2 pasos y creá una
   contraseña de aplicación (Cuenta de Google → Seguridad → Contraseñas de
   aplicaciones). Pegala **sin espacios**.
3. **Cuenta de Claude:** cargala en un slot libre desde el panel, como siempre
   (por ejemplo `c8`). Después, en el servidor, pasala a Homero y sacala del slot
   para que Punchi no la use por relevo:
   ```bash
   mkdir -p /srv/homes/homero/.claude
   cp /srv/homes/c8/.claude/.credentials.json /srv/homes/homero/.claude/
   chown -R 1001:1001 /srv/homes/homero
   ```
   Y en el panel, borrá la cuenta de ese slot.
4. **`/root/mc.env`** (valores sin comillas, ver la nota de PowerShell):
   ```
   COMPOSE_PROFILES=homero
   HOMERO_TELEGRAM_BOT_TOKEN=...
   HOMERO_GMAIL_1_USER=sincro.ventas@gmail.com
   HOMERO_GMAIL_1_PASS=abcdefghijklmnop
   HOMERO_GMAIL_2_USER=...
   HOMERO_GMAIL_2_PASS=...
   HOMERO_GMAIL_3_USER=...
   HOMERO_GMAIL_3_PASS=...
   ```
5. Deploy. Escribile `/start` al bot: te contesta con tu chat id. Agregá
   `HOMERO_CHAT_ID=<ese número>` a `mc.env` y volvé a desplegar.
6. Probá: `/estado`, `/probar_ia`, `/probar_mail tu@mail.com`. Respondé el mail
   de prueba y en unos minutos te llega el resumen.

## Comandos

| Comando | Qué hace |
|---|---|
| `/estado` | Pausas, tareas pendientes, envíos de hoy por casilla |
| `/pausa` / `/seguir` | Frena o retoma los envíos y resúmenes (las bandejas se siguen leyendo) |
| `/probar_ia` | Hace una pregunta corta a Claude |
| `/probar_mail <destino> [1-3]` | Manda un mail de prueba desde esa casilla |

## Variables

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | En el compose sale de `HOMERO_TELEGRAM_BOT_TOKEN` |
| `HOMERO_CHAT_ID` | — | Sin esto no obedece a nadie |
| `DATABASE_URL` | — | La misma del bridge |
| `HOMERO_MODELO` | `sonnet` | |
| `HOMERO_REMITENTE` | `Gero · Sincro` | Nombre que ve el destinatario |
| `HOMERO_BANDEJA_MIN` | `10` | Cada cuánto lee las bandejas |
| `HOMERO_GMAIL_{1,2,3}_{USER,PASS}` | — | Van de a pares |

## Desarrollo

```bash
pnpm install
pnpm test
pnpm typecheck
```
