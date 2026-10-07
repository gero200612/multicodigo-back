# Homero: agentes pensantes y fondo común de cuentas

Fecha: 2026-10-07. Estado: diseño aprobado en charla, falta revisión del spec.

## Por qué

Hoy Homero es un guion: el código elige rubro y ciudad, busca en OpenStreetMap,
y Claude solo redacta (`ia.ts`: `tools: []`, `maxTurns: 1`, prompt fijo de
`prompts.ts`). Gero quiere agentes que **piensen**: que reciban un objetivo y
decidan cómo cumplirlo.

El caso que lo dejó a la vista: desde el 2026-10-06 **todas** las búsquedas en
OSM devuelven 0 (`homero.busquedas` 62–76, zonas del conurbano sin datos). Sin
negocios nuevos no sale ningún mail nuevo, y el guion no tiene otro camino: prueba
otra combinación de la misma lista tres veces y se rinde en silencio.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: agentes pensantes, no que sigan una instrucción. Los tres (buscador,
  vendedor, atención). Atención piensa y escribe sola, Gero aprueba con un botón.
  Las cuentas de Claude son un **fondo común** de todos los bots; si una se queda
  sin uso se sigue con otra. Con todas ocupadas, **Punchi primero**.
- Se asume: sigue `modo auto` para mails nuevos; los topes que cuidan las
  casillas quedan en código; se arranca probando en ensayo.
- Éxito: salen mails todos los días aunque una fuente se seque, cada mail sale de
  algo que el agente investigó y razonó, y Gero puede leer por qué decidió lo que
  decidió.

## 1. Los tres agentes

Cada agente es una **corrida**: objetivo + herramientas + su libreta, varios
turnos, y termina con un informe. Se dispara desde la cola `homero.tareas` que ya
existe (reinicios y límites retoman igual que hoy); lo que cambia es qué pasa
adentro de la tarea.

### Buscador (`agente_buscar`)
- **Cuándo:** donde hoy se encola `prospectar` (7:00 y cada 2 h por `planificar`
  mientras falte cupo del día).
- **Objetivo:** "Conseguí N negocios nuevos que valga la pena contactar, en tu
  zona" (N = lo que falta del cupo × 2, como hoy).
- **Herramientas:** `WebSearch`, `WebFetch`; de Homero: `rubros_y_rendimiento`
  (respuestas/contactados por rubro y zona), `busquedas_anteriores`,
  `ya_conocido(dominio|email)` (incluye cadenas y bajas), `anotar_negocio(nombre,
  rubro, ciudad, web, email?, telefono?, por_que)`, `libreta_leer/escribir`.
- **Libertad:** elige fuente (buscador web, directorios, Instagram, colegios
  profesionales, cámaras), rubro y zona; puede usar rubros que no están en
  `rubros.ts` (quedan como texto libre).
- **Cierre:** `anotar_negocio` crea el lead y encola su `agente_vender`. Tope de
  anotados por corrida = N.
- OSM queda como herramienta más (`buscar_en_mapa`), no como el camino.

### Vendedor (`agente_vender`, uno por lead)
- **Objetivo:** "Decidí si a este negocio le sirve lo que vende Gero y, si sí,
  escribile el mejor mail posible."
- **Herramientas:** `WebSearch`, `WebFetch`; de Homero: `ficha_del_negocio`,
  `mails_que_funcionaron` (enviados con respuesta, anonimizados),
  `dejar_mail_listo(asunto, mensaje, seguimiento, factibilidad, por_que)`,
  `descartar(motivo)`, `libreta_leer/escribir`.
- Sin plantilla de cinco partes ni ideas fijas por rubro. `SISTEMA` queda como
  identidad y reglas (qué vende Gero, no inventar precios, rioplatense), no como
  guion.
- `dejar_mail_listo` hace lo mismo que hoy `investigar` al final: crea salientes
  (inicial + seguimiento); en `modo auto` se aprueban y los manda `enviarMail` con
  sus topes; en ensayo va la muestra a Gero.

### Atención (`agente_atender`, uno por respuesta recibida)
- **Objetivo:** "Entendé qué quiere esta persona y armá la mejor respuesta para
  llevarla a una reunión."
- **Herramientas:** de Homero: `hilo_completo`, `ficha_del_negocio`,
  `horarios_libres`, `proponer_respuesta(texto, horarios_ofrecidos[])`,
  `proponer_confirmacion(horario)`, `anotar_baja`, `avisar_a_gero(texto)`,
  `libreta_leer/escribir`. Sin `WebSearch`; `WebFetch` solo al dominio del
  propio negocio (lo valida `canUseTool` contra la web del lead).
- Reemplaza el circuito "Gero marca horarios → Armar respuesta": la respuesta le
  llega a Gero ya armada, con un solo **Enviar / No enviar** (Telegram y web).
  `proponer_confirmacion` arma la confirmación con .ics; se reserva recién al
  tocar Enviar (hoy reserva antes; pasa a reservar al enviar y, si el horario ya
  no está libre, se le avisa a Gero).
- Cortar seguimientos al recibir respuesta sigue siendo código, antes de lanzar
  el agente.

### Lo que no se vuelve agente
Patán (`presupuestar`), resumen diario, pliego de demos, `/probar_ia`: siguen
siendo pedidos de un turno, pero pasan por el fondo común (sección 3).

## 2. Lo que el agente no puede saltear

El modelo lee texto de terceros, así que todo efecto pasa por una herramienta de
Homero que aplica sus reglas sin importar lo que pida el modelo:

- Mails nuevos: `enviarMail` sin cambios (bajas, horario 9–19 hábil, cupo con
  calentamiento, casilla pausada por rebotes >5%). Un solo seguimiento.
- Respuestas y confirmaciones: siempre con el botón de Gero. Un interruptor para
  pasarlas a automático queda **fuera de alcance** de este spec.
- Por corrida: máximo de turnos (buscador 40, vendedor 20, atención 12), de
  minutos (15/8/5) y de llamadas a herramientas que escriben (buscador: N
  anotados; vendedor: un `dejar_mail_listo` o un `descartar`; atención: una
  propuesta).
- Las herramientas de Homero solo aceptan el token de **esa** corrida, que vence
  al terminar, y solo operan sobre el lead de la corrida (vendedor, atención).
- Lo que venga de webs o mails se le marca al modelo como `<no_confiable>`, como
  hoy.

## 3. Fondo común de cuentas (gateway)

Se deshace la separación por bot del 2026-10-03 (`agentes.bot`, migración 038;
`cuenta.ts` de Homero; ceder/recuperar del login). Queda **un solo fondo de
slots**, y **el gateway es el único proceso que usa credenciales**: Homero no
vuelve a tener cuentas.

- **Ruta nueva del gateway** `POST /comercial/corrida` (token propio de Homero,
  `HOMERO_GATEWAY_TOKEN`): recibe sistema, objetivo, lista de herramientas
  integradas permitidas, URL+token del MCP de Homero, topes y modelo. Devuelve el
  informe final y el registro de pasos.
- **Elección de slot:** un slot sin tenencia (`tenencia.ts`) y con cuenta usable.
  **Punchi primero:** Homero nunca toma el último slot libre, y un pedido de
  Punchi en espera se atiende antes que uno de Homero. Si no hay slot, el gateway
  contesta "sin lugar" y la tarea vuelve a la cola con reintento (como el límite
  de uso hoy).
- **Relevo:** si la cuenta se queda sin uso a mitad de corrida, el gateway la
  marca y sigue en otro slot. No se puede reanudar la sesión del SDK en otra
  cuenta (vive en el HOME), así que la corrida nueva arranca con el objetivo +
  el registro de lo ya hecho (las herramientas de escritura quedan en la base de
  Homero, así que no se repite nada). Si no queda ninguna, "sin uso" con la hora
  de reset más cercana; Homero espera sin tope, como hoy.
- **Modo comercial del agente:** el contenedor del slot corre `runClaude` con un
  perfil distinto: sin worktree (cwd vacío y efímero), `tools` =
  `WebSearch`, `WebFetch` + `mcp__homero__*`; sin Bash, Read/Write/Edit, git, ni
  los MCP de Punchi (git, drive, corrida). `settingSources: []`.
- **Red:** los slots en modo comercial no pueden llegar a la red interna (gateway,
  bridge, panel, base, login, dockerproxy). Salida a internet sí, privadas no,
  salvo el MCP de Homero en una red propia `enlace_comercial` (Homero + slots).
  `WebFetch` hacia IPs privadas queda bloqueado en la red, no en el prompt.
- **Pedidos de un turno** (Patán, resumen, pliego): Homero llama la misma ruta
  con `maxTurns: 1` y sin herramientas.
- La cuenta propia de Homero (`/srv/homes/homero`) y la de Patán se registran
  como slots del fondo.
- Panel: se saca el selector de bot por slot; las cuentas se ven como un solo
  grupo. `puede_usar_slot` (migración 041) sigue valiendo para Punchi; Homero
  corre como el usuario `HOMERO_USUARIO_ID`.

## 4. Libreta, razonamiento y fallas

- `homero.libretas (agente, contenido, actualizada)`: la lee al arrancar y la
  reescribe al final (máx. ~1500 palabras; si se pasa, el agente la resume). Se
  ve y edita desde la web.
- `homero.corridas (id, agente, objetivo, lead_id, estado, slot, turnos,
  pasos jsonb, informe, error, inicio, fin)`: cada búsqueda, página leída,
  herramienta usada y el razonamiento entre pasos.
- Web `/homero`: pestaña **Agentes** (corridas con su razonamiento + libretas).
  Resumen de las 20:30: una línea de qué cambió el buscador.
- Una corrida que no cierra con su herramienta de salida (ni mail ni descarte,
  por ejemplo) queda `fallida` con el motivo. Tres fallidas seguidas del mismo
  agente → aviso por Telegram. Una búsqueda que no anota nada no es falla, pero
  queda en el informe y en la libreta.
- Una tarea en `corriendo` cuyo proceso murió se rescata al arrancar Homero
  (vuelve a `pendiente`).

## 5. Orden y pruebas

1. **Fondo común + modo comercial + red** (multicodigo-vm, bridge, panel).
   Test: corrida de ejemplo con un MCP falso; un `WebFetch` a una IP interna
   falla; relevo con dos slots donde el primero devuelve límite; Punchi gana el
   último slot.
2. **MCP de Homero** con sus herramientas y tokens por corrida. Tests sin Claude
   (cada herramienta, sus topes, token vencido o de otro lead).
3. **Buscador** (ensayo). Test con stream simulado del SDK; prueba real: una
   corrida que anote negocios en zonas donde OSM daba 0.
4. **Vendedor** (ensayo): muestras a Gero.
5. **Atención** (ensayo): Gero responde las muestras como cliente.
6. `/ensayo off`.

Se borra lo que queda sin uso: `prospectar` por OSM como camino fijo,
`promptDeBorrador`, el circuito de elección de horarios, `cuenta.ts`.

## Fuera de alcance

- Respuestas a clientes en automático (queda para cuando Gero confíe).
- Un agente "jefe" que coordine a los otros.
- Google Places (Gero no lo quiere).
