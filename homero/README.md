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
| Durante el día | Lee la web de cada uno, consigue el mail, chequea que el dominio reciba mail y escribe el mail inicial y un seguimiento. Te pasa la tarjeta para aprobar |
| 9 a 19 (días hábiles) | Manda los aprobados separados entre 4 y 12 minutos y desparramados en la ventana. Respeta el cupo de calentamiento de cada casilla |
| A la semana (5 días hábiles) | UN solo seguimiento en el mismo hilo, solo si no contestó. Después, nada más |
| Cada 10 min | Lee las bandejas. Si alguien contesta: corta el seguimiento, te manda quién es, qué hace la empresa y qué dijo, y te muestra los horarios libres de tu agenda para que marques cuáles ofrecer. Con eso escribe la respuesta y te la pasa para enviar |
| Cuando elige horario | Agenda, le manda la invitación (.ics) con link de Jitsi (y te copia), te avisa con el resumen de la empresa |
| 2 h antes | Le recuerda al cliente por mail (menos ausencias) |
| 30 min antes | Te manda por Telegram el resumen para entrar preparado |
| 20:30 | Resumen del día: leads, envíos, respuestas, reuniones y cómo responde cada rubro |

Lo que se hizo pensando en **más respuestas**:
- mails cortos (≤90 palabras), con algo específico de la web del negocio en la primera línea, una sola idea concreta y una sola pregunta al final;
- sin links ni adjuntos en los mails en frío (van a spam), firma de persona; si alguien pide que no le escriban, Homero lo entiende de su respuesta y no le escribe más;
- un seguimiento a la semana en el mismo hilo (muchas respuestas llegan recién ahí);
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
| `/presupuesto [monto]` | Anuncios: cómo va el mes; con monto, cambia el presupuesto mensual (`/presupuesto 80000`) |
| `/pausa` / `/seguir` | Frena o retoma (las bandejas se siguen leyendo) |
| `/probar_ia` / `/probar_mail <destino> [1-3]` | Pruebas |

En las tarjetas: **Aprobar / Descartar** (mail nuevo con sus seguimientos) y
**Enviar / No enviar** (respuesta). Para cambiar el texto, **respondé a la
tarjeta** con el texto nuevo y después tocá el botón.

Rubros: `contable`, `distribuidora`, `inmobiliaria`, `consultorio`, `taller`,
`gastronomia`, `logistica`, `veterinaria`, `gimnasio`, `ferreteria`
(`src/rubros.ts`, cada uno con sus ideas de automatización).

## Desde punchi.dev

Todo lo de Telegram también se maneja desde la web (sección **Homero**): borradores,
respuestas con horarios, reuniones, leads, rubros, búsqueda, pausa, modo y ensayo.
La web llama a la API interna de Homero (`src/api.ts`) a través del panel, que solo
deja pasar al dueño (`HOMERO_USUARIO_ID`). Cada acción usa la misma función que el
botón de Telegram y le saca los botones a la tarjeta del chat.

## Demos con Punchi

En cada reunión confirmada aparece **🧪 Armar demo con Punchi** (Telegram: después de
enviar la confirmación y en `/reuniones`; web: pestaña Reuniones).

1. Claude escribe un pliego con lo que se sabe de la empresa y te lo pasa.
2. Lo editás (respondiendo a la tarjeta, o en la web) y tocás **🚀 Enviar a Punchi**.
3. El bridge abre la corrida (`proyecto=<empresa>-demo publico=si`) y la arranca sola,
   sin pedir confirmación del plan. El avance llega por el chat de Punchi.
4. Homero pregunta cada 5 minutos cómo va y te avisa con la URL cuando está publicada.

Punchi hace una corrida a la vez por chat: si está ocupado, la demo queda con el
pliego y el motivo, y se reintenta con el mismo botón.

## Variables

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | En el compose sale de `HOMERO_TELEGRAM_BOT_TOKEN` |
| `HOMERO_CHAT_ID` | — | Sin esto no obedece a nadie |
| `DATABASE_URL` | — | La misma del bridge |
| `HOMERO_MODELO` | `sonnet` | |
| `HOMERO_REMITENTE` | `Geronimo Enrici` | Nombre que ve el destinatario |
| `HOMERO_FIRMA` | `Geronimo Enrici\nSincro_ar` | Cómo firma los mails (`\n` = salto de línea) |
| `HOMERO_EMAIL_GERO` | — | Te copia las invitaciones de reunión |
| `GOOGLE_PLACES_API_KEY` | — | Sin esto, OpenStreetMap |
| `HOMERO_BANDEJA_MIN` | `10` | Cada cuánto lee las bandejas |
| `HOMERO_GMAIL_{1,2,3}_{USER,PASS}` | — | Van de a pares |
| `HOMERO_API_TOKEN` | — | La API interna para punchi.dev. Sin esto no se levanta |
| `HOMERO_API_PUERTO` | `8095` | |
| `BRIDGE_URL` / `BRIDGE_API_TOKEN` | — | Para las demos. Sin las dos no hay botón de demo |
| `META_TOKEN` | — | Token del usuario del sistema `homero`. Sin esto no hay nada de Meta (se avisa una vez en el log) |
| `META_AD_ACCOUNT_ID` | — | La cuenta publicitaria, con o sin `act_` (`act_980029277705534`) |
| `META_PAGE_ID` | — | La página de Sincro (`61595291607526`) |
| `META_APP_ID` | — | La app (`1410095257330902`); hoy solo informativo |
| `META_API_VERSION` | `v23.0` | Fija: antes de cambiarla, correr `scripts/meta-humo.ts` |

## Anuncios en Meta

Spec: `docs/superpowers/specs/2026-10-08-homero-anuncios-meta-design.md`. Anuncios
de Instagram y Facebook con formulario adentro, una sola campaña `OUTCOME_LEADS`
y un conjunto por anuncio (Argentina, 25 a 65).

| Cuándo | Qué hace |
|---|---|
| 10:00 | El **publicista** (agente con libreta, como los otros) mira los resultados, propone anuncios nuevos y reparte el diario entre los aprobados. Corre otra vez cada vez que aprobás uno |
| Al proponer | Te llega la imagen (1080×1080, plantilla de Sincro) y la tarjeta: **✅ Aprobar / ✏️ Cambiar / 🗑 Descartar**. Con Cambiar, tu próximo mensaje (o una respuesta a la tarjeta) es lo que hay que cambiar, y lo rehace |
| Al aprobar | Recién ahí se crea en Meta (imagen, formulario, conjunto, creativo, anuncio), por la cola: si Meta falla, reintenta desde donde quedó |
| Cada 5 min | Lee los formularios. Cada consulta entra a `homero.leads` como `caliente` (sin duplicar por `leadgen_id`, mail o teléfono), te avisa con link de WhatsApp y le sale un mail en minutos con tres horarios, sin esperar ventana ni cupo |
| Cada hora | Lee los insights del mes a `homero.gastos`. Al 90% del presupuesto pausa todo y avisa |
| 20:00 | Resumen: gasto de hoy y del mes contra el presupuesto, consultas, costo por consulta, reuniones y el mejor anuncio |

El tope lo pone el código, no el agente: antes de cada cambio de diario,
`gastado del mes + suma de diarios × días que faltan ≤ presupuesto del mes`
(default $50.000, `/presupuesto` para cambiarlo). Si no entra, se rechaza con el
diario que entra. El límite de gasto de la cuenta en Meta queda como segundo tope.

Prueba de humo, solo lectura (cuenta, moneda, token de página, formularios,
Instagram, intereses, insights), con el token real y sin imprimirlo:

```bash
docker exec homero node --experimental-strip-types scripts/meta-humo.ts
```

| Ruta (API interna) | Qué hace |
|---|---|
| `GET /anuncios` | Todos los anuncios con su gasto, impresiones, consultas, leads y reuniones del mes, más los números del mes |
| `GET /anuncios/:id/imagen` | El PNG del anuncio |
| `POST /anuncios/:id/aprobar` | Igual que ✅ en Telegram: lo deja aprobado y encola la publicación |
| `POST /anuncios/:id/descartar` | Igual que 🗑 |
| `POST /anuncios/:id/cambiar` | `{ pedido }`: igual que ✏️, el publicista lo rehace |
| `GET /anuncios/presupuesto` | `{ presupuesto, mes }` |
| `PUT /anuncios/presupuesto` | `{ monto }` en pesos por mes; devuelve `aviso` si pasa el límite de la cuenta en Meta |
| `GET /anuncios/resumen` | Los números del resumen de las 20 y su texto |

La fuente de la imagen es Inter (`assets/fuentes`, licencia OFL en `OFL.txt`).

## Desarrollo

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Patán: los presupuestos

Vive adentro de Homero (misma base, cola y cuenta de Claude); en punchi.dev es
su propia sección, `/patan`. Para cada demo ya mandada a Punchi, Gero pega sus
notas de la reunión y toca "Armar presupuesto": la tarea `presupuestar` le pide
a Claude el alcance y una estimación del ahorro mensual del cliente (horas ×
costo de la hora). Los PRECIOS no los pone Claude: salen de la regla
(`patan:regla` en `homero.estado`, editable desde la web):

- armado = ahorro mensual × `mesesDeAhorro`, nunca menos que `pisoArmado`;
- abono = ahorro mensual × `porcentajeAbono`, nunca menos que `pisoAbono`, con `horasSoporte` incluidas.

La cuenta del ahorro queda en `justificacion` y la ve solo Gero; el PDF (se
genera en el navegador) dice únicamente lo que se cobra.

| Ruta | Qué hace |
|---|---|
| `GET /patan` | Las demos presupuestables con su empresa, reunión y presupuesto, y la regla |
| `POST /patan/demos/:id/armar` | `{ notas }`: encola el presupuesto (rehacerlo pisa el anterior) |
| `PATCH /patan/presupuestos/:id` | `{ contenido }`: Gero lo edita antes de bajar el PDF |
| `PATCH /patan/regla` | `{ regla }` |
