# Homero

El agente comercial. Busca pymes a las que les sirva automatizar un proceso con
IA, les escribe desde tres Gmail, hace el seguimiento, contesta con horarios,
agenda la reunión y le avisa a Gero por Telegram quién respondió y qué empresa es.

Es un servicio aparte de Punchi: su propio bot de Telegram, su propia cuenta de
Claude y su propio esquema (`homero.*`) en la misma base de Supabase.

## El día de Homero

| Cuándo | Qué hace |
|---|---|
| 7:00 (días hábiles) | Sale a buscar negocios: elige el rubro que mejor viene respondiendo (y cada tanto prueba otro) y la ciudad menos buscada |
| Durante el día | Lee la web de cada uno, consigue el mail, chequea que el dominio reciba mail y escribe el mail inicial con 2 seguimientos. Te pasa la tarjeta para aprobar |
| 9 a 19 (días hábiles) | Manda los aprobados separados entre 4 y 12 minutos y desparramados en la ventana. Respeta el cupo de calentamiento de cada casilla |
| Día 3 y día 7 hábil | Seguimientos en el mismo hilo, solo si no contestó |
| Cada 10 min | Lee las 3 bandejas. Si alguien contesta: corta los seguimientos, te manda quién es y qué dijo, y te propone la respuesta con 3 horarios |
| Cuando elige horario | Agenda, le manda la invitación (.ics) con link de Jitsi (y te copia), te avisa con el resumen de la empresa |
| 2 h antes | Le recuerda al cliente por mail (menos ausencias) |
| 30 min antes | Te manda por Telegram el resumen para entrar preparado |
| 20:30 | Resumen del día: leads, envíos, respuestas, reuniones y cómo responde cada rubro |

Lo que se hizo pensando en **más respuestas**:
- mails cortos (≤90 palabras), con algo específico de la web del negocio en la primera línea, una sola idea concreta y una sola pregunta al final;
- sin links ni adjuntos en los mails en frío (van a spam), firma de persona, salida fácil ("respondé no");
- 2 seguimientos en el mismo hilo (la mayoría de las respuestas llegan en el seguimiento);
- aprende qué rubro responde mejor y le da más volumen;
- chequeo de MX antes de escribir, freno de la casilla si rebota más del 5%: cuida la reputación de las casillas;
- si contesta otra persona de la empresa (se le escribió a info@ y contesta juan@), lo reconoce por el hilo y sigue con ella.

Y en **más reuniones**:
- responde en el mismo hilo sin esperar horario hábil ni cupo: contestar rápido a un interesado es lo que más cierra;
- ofrece 3 horarios concretos en días y horas distintos (lunes a viernes, 12 a 20), desde mañana;
- si elige uno, agenda solo con invitación de calendario; recordatorio el mismo día;
- un interesado que escribe por su cuenta (no estaba en la base) también entra al circuito.

## Cómo está armado

```
Telegram (polling) ───┐
3 Gmail (IMAP/SMTP) ──┤
Google Places / OSM ──┼── homero ── Claude (SDK, SIN herramientas, cuenta propia)
Webs de los negocios ─┤
Supabase (homero.*) ──┘
```

El modelo nunca tiene herramientas (`tools: []`): lee mails y webs de
desconocidos, así que solo puede devolver texto. Lo que se hace con ese texto
(mandar, anotar una baja, agendar) lo decide este proceso, con sus topes en el
código. Las webs se bajan con validación de host (nada de IPs privadas),
tiempo y tamaño acotados.

Todo pasa por la cola `homero.tareas`: un reinicio o un límite retoma en la
tarea exacta. Si Claude se queda sin uso, **espera al reset y sigue**, sin tope
de horas; mientras tanto sigue mandando lo que ya estaba escrito. La pausa vive
en `homero.estado`, así que sobrevive a un reinicio.

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
4. **`/root/mc.env`** (valores sin comillas):
   ```
   COMPOSE_PROFILES=homero
   HOMERO_TELEGRAM_BOT_TOKEN=...
   HOMERO_EMAIL_GERO=tu-mail-personal@gmail.com
   HOMERO_GMAIL_1_USER=sincro.ventas@gmail.com
   HOMERO_GMAIL_1_PASS=abcdefghijklmnop
   HOMERO_GMAIL_2_USER=...
   HOMERO_GMAIL_2_PASS=...
   HOMERO_GMAIL_3_USER=...
   HOMERO_GMAIL_3_PASS=...
   # Opcional, muy recomendado (ver abajo):
   GOOGLE_PLACES_API_KEY=...
   ```
5. Deploy. Escribile `/start` al bot: te contesta con tu chat id. Agregá
   `HOMERO_CHAT_ID=<ese número>` a `mc.env` y volvé a desplegar.
6. Probá: `/estado`, `/probar_ia`, `/probar_mail tu@mail.com`. Respondé el mail
   de prueba y en unos minutos te llega el resumen. Después `/buscar contable Rosario`.

### ¿Google Places o OpenStreetMap?

Sin `GOOGLE_PLACES_API_KEY` busca en OpenStreetMap: gratis y sin cuenta, pero
con poca cobertura en Argentina (probado: 1 estudio contable con web en
Rosario). Con Places trae hasta 20 por búsqueda con web y teléfono. Places pide
una cuenta de Google Cloud con tarjeta; el cupo gratis mensual alcanza para este
volumen. Poné un tope de presupuesto en la consola.

## Comandos

| Comando | Qué hace |
|---|---|
| `/estado` | Modo, pausas, tareas, borradores esperando, envíos de hoy por casilla |
| `/hoy` | Números del día |
| `/reuniones` | Las próximas, con link |
| `/ensayo [mail]` / `/ensayo off` | **Arranca prendido.** Cada borrador te llega a tu mail tal cual lo recibiría el cliente, con a quién iba y los links de dónde sacó la info. Al cliente no sale nada (ni con Aprobar) hasta `/ensayo off` |
| `/modo aprobar` / `/modo auto` | Si te pide OK para cada mail y respuesta (arranca en aprobar) |
| `/buscar [rubro] [ciudad]` | Sale a buscar ya (`/buscar taller Córdoba`) |
| `/rubros` | Respuestas / contactados de cada rubro |
| `/ocupado 30/9` / `/libre 30/9` | Días sin reuniones |
| `/pausa` / `/seguir` | Frena o retoma (las bandejas se siguen leyendo) |
| `/probar_ia` / `/probar_mail <destino> [1-3]` | Pruebas |

En las tarjetas: **Aprobar / Descartar** (mail nuevo con sus seguimientos) y
**Enviar / No enviar** (respuesta). Para cambiar el texto, **respondé a la
tarjeta** con el texto nuevo y después tocá el botón.

Rubros: `contable`, `distribuidora`, `inmobiliaria`, `consultorio`, `taller`,
`gastronomia`, `logistica`, `veterinaria`, `gimnasio`, `ferreteria`
(`src/rubros.ts`, cada uno con sus ideas de automatización).

## Variables

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | En el compose sale de `HOMERO_TELEGRAM_BOT_TOKEN` |
| `HOMERO_CHAT_ID` | — | Sin esto no obedece a nadie |
| `DATABASE_URL` | — | La misma del bridge |
| `HOMERO_MODELO` | `sonnet` | |
| `HOMERO_REMITENTE` | `Gero · Sincro` | Nombre que ve el destinatario |
| `HOMERO_FIRMA` | `Gero` | Cómo firma los mails |
| `HOMERO_EMAIL_GERO` | — | Te copia las invitaciones de reunión |
| `GOOGLE_PLACES_API_KEY` | — | Sin esto, OpenStreetMap |
| `HOMERO_BANDEJA_MIN` | `10` | Cada cuánto lee las bandejas |
| `HOMERO_GMAIL_{1,2,3}_{USER,PASS}` | — | Van de a pares |

## Desarrollo

```bash
pnpm install
pnpm test
pnpm typecheck
```
