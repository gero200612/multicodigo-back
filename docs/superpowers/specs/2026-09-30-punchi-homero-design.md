# Punchi + Homero en punchi.dev, y demos de Homero a Punchi

Fecha: 2026-09-30 · Repos: `multicodigo-back`, `multicodigo-front`, `multicodigo-vm`
Rama en los tres: `punchi-homero` (main autodespliega: no se mergea sin OK).

## Qué quiere Gero

1. Entrar a punchi.dev y elegir a dónde ir: **Punchi** (lo que ya existe) u
   **Homero** (el agente comercial, hoy solo en Telegram).
2. Manejar Homero **entero desde la web**: lo mismo que hoy hace con los
   botones y comandos de Telegram. Telegram sigue funcionando igual y queda
   como canal de avisos.
3. Antes de una reunión que agendó Homero, tocar **"Armar demo"**: Homero
   escribe un pliego con lo que sabe de la empresa, Gero lo revisa/edita, y
   Punchi hace una **corrida completa** (front + back, desplegada con URL) que
   arranca sola, sin la confirmación de plan de siempre.

Fuera de alcance: acceso de otros usuarios a Homero, cambios al motor de
corridas, rediseño del dashboard de Punchi.

## Arquitectura

```
front (Vercel, punchi.dev)
  └─ panel-api (.NET, JWT)  /api/homero/*  ──► homero :8095 (red puente, NO expuesto)
                                                  │
                                                  └─ POST /interno/corrida/desde-homero ──► bridge :3000
```

- Homero suma un servidor HTTP (fastify, como el bridge) en la red `puente`,
  protegido con un token compartido `HOMERO_API_TOKEN` (header
  `Authorization: Bearer`), igual que `BRIDGE_API_TOKEN`.
- panel-api reenvía `/api/homero/*` solo al **dueño**: el usuario cuyo
  `telegram chat_id` vinculado es `HOMERO_CHAT_ID`. Cualquier otro recibe 403.
  Así no hace falta una tabla de permisos nueva.
- Cada endpoint de Homero llama a **las mismas funciones** de `ventas.ts` que
  usan los botones de Telegram. Nada de lógica de ventas en C# ni en el front.
- Cuando algo se decide desde la web, la tarjeta de Telegram correspondiente
  pierde sus botones (se edita con `telegram_msg`), para que no se decida dos
  veces. Si se decide en Telegram, la web lo ve al refrescar.

## API de Homero (interna)

Lectura:
- `GET /estado` — modo, ensayo, pausas, cupo de hoy por casilla, tareas en cola.
- `GET /hoy` — números del día (lo del resumen diario).
- `GET /borradores` — leads en `borrador` con su mail inicial y seguimiento,
  investigación (resumen, dolor, idea, links) y factibilidad.
- `GET /respuestas` — respuestas esperando: qué dijo, análisis, horarios
  libres con los marcados, y borrador de respuesta si ya existe.
- `GET /reuniones` — próximas y pasadas recientes, con la demo si la hay.
- `GET /leads?estado=&rubro=&q=` — paginado.
- `GET /rubros` — contactados / respuestas por rubro.

Acciones (todas devuelven el objeto actualizado o `{ok:false, motivo}`):
- `POST /leads/:id/aprobar` · `POST /leads/:id/descartar`
- `PATCH /salientes/:id` `{asunto?, cuerpo}` — solo si está en `borrador`.
- `POST /salientes/:id/enviar` · `POST /salientes/:id/descartar`
- `POST /respuestas/:leadId/horarios/:i` (alternar) ·
  `POST /respuestas/:leadId/armar` · `POST /respuestas/:leadId/no-responder`
- `POST /buscar` `{rubro?, ciudad?}` · `POST /prioridad` `{n}`
- `POST /modo` `{modo:'aprobar'|'auto'}` · `POST /ensayo` `{a?:string|null}`
- `POST /pausa` · `POST /seguir`
- `POST /dias/:fecha/ocupado` · `DELETE /dias/:fecha/ocupado`
- Demos: ver abajo.

Los comandos de Telegram que hoy tienen lógica inline en `telegram.ts`
(`/buscar`, `/modo`, `/pausa`, `/ocupado`…) se mueven a funciones de un módulo
`comandos.ts` que llaman los dos lados, para no duplicar.

## Demos: Homero → Punchi

Tabla nueva `homero.demos`:

| columna | |
|---|---|
| `id` | bigserial |
| `reunion_id` | FK `homero.reuniones`, UNIQUE (una demo por reunión) |
| `lead_id` | FK `homero.leads` |
| `proyecto` | nombre en Punchi (slug de la empresa + `-demo`, único) |
| `pliego` | texto |
| `estado` | `pliego` → `enviada` → `construyendo` → `lista` \| `fallida` |
| `corrida_id` | uuid de `public.corridas`, al enviarse |
| `url` | la URL publicada del front, al terminar |
| `error` | texto |

Flujo:
1. **Armar demo** (web o botón nuevo en la tarjeta de reunión de Telegram):
   encola la tarea `pliego_demo` (requiere IA). Claude, sin herramientas como
   siempre, recibe la investigación del lead, el hilo de mails y el rubro, y
   devuelve un pliego en el formato de las corridas (qué es la app, pantallas,
   datos de ejemplo del rubro, la automatización propuesta como protagonista;
   el stack lo fija Punchi). Queda en `estado='pliego'` y se avisa.
2. Gero lo lee/edita (web: editor de texto; Telegram: responder a la tarjeta,
   como los borradores) y toca **Enviar a Punchi**.
3. Homero llama `POST bridge /interno/corrida/desde-homero`
   `{proyecto, pliego, chatId: HOMERO_CHAT_ID}`. El bridge:
   - resuelve el usuario por ese chat vinculado;
   - `armarDesdeElNombre(..., publico=true)` (repos públicos: con privados el
     deploy se traba);
   - `abrirCorrida` y **arranca la cola sin el botón de confirmar**
     (`planificarCorrida` + `correrCola`, lo mismo que dispara hoy la
     confirmación);
   - responde `{corridaId}` o `{error}` (proyecto que ya existe, org ambigua,
     corrida ya abierta en ese chat).
   El chat de Punchi recibe los avisos de la corrida como cualquier otra.
4. Estado: Homero consulta `GET bridge /corridas?usuarioId=` cada 5 min para
   las demos `enviada/construyendo`; pasa a `lista` con la URL publicada del
   front cuando la corrida cierra con deploy, o a `fallida` con el motivo.
   Al quedar `lista` avisa por Telegram con el link y la hora de la reunión.

Límite conocido: el bridge permite **una corrida abierta por chat**. Si ya hay
una, la demo queda `pliego` con el error "Punchi está ocupado con X" y se
puede reintentar. No se agrega una cola de corridas en esta etapa.

## Front

- `/` — **Home**: dos tarjetas grandes con imagen (Punchi, Homero), nombre y
  una línea de estado (Punchi: corridas activas/slots; Homero: borradores y
  respuestas esperando, próxima reunión). La tarjeta de Homero solo aparece
  para el dueño.
- `/punchi` — el dashboard actual, sin cambios. `/proyectos`, `/archivos`,
  `/configuracion` siguen donde están, dentro de la sección Punchi.
- `/homero` — pestañas: **Borradores · Respuestas · Reuniones · Leads ·
  Rubros**, y arriba una barra con modo, ensayo, pausa, cupo de hoy y
  "Buscar ahora". Reuniones muestra la demo de cada una con su botón/estado.
- Un selector Punchi/Homero en la barra superior para cambiar sin volver a
  la home. Mismo look actual del panel; imágenes en `public/` (la de Punchi
  falta: placeholder hasta que llegue).
- Polling cada 20 s en la pestaña visible (como el dashboard).

## Infra (`multicodigo-vm`)

- `homero` entra también a la red `puente`; puerto 8095 sin publicar.
- Variables nuevas: `HOMERO_API_TOKEN` (homero, panel), `HOMERO_URL` (panel,
  `http://homero:8095`), `BRIDGE_URL` + `BRIDGE_API_TOKEN` (homero).
  Todas opcionales: sin ellas la web oculta Homero y el botón de demo no
  aparece; Telegram sigue igual.

## Errores

- Homero caído: panel responde 503 y la web muestra "Homero no responde" en
  la tarjeta y la sección; Punchi no se ve afectado.
- Acción sobre algo ya decidido (desde Telegram o otra pestaña): 409 con el
  motivo; la web refresca.
- Límite de Claude en `pliego_demo`: la tarea espera el reset como el resto.

## Pruebas

- Homero: tests del servidor HTTP (auth por token, cada acción llama a la
  función de ventas, 409 en decididos), `pliego_demo`, y el seguimiento de
  estado de demos con un bridge falso.
- Bridge: `/interno/corrida/desde-homero` abre y arranca sin confirmación;
  errores de proyecto existente y corrida abierta.
- panel-api: 403 a quien no es el dueño, reenvío y 503 con Homero caído.
- Front: home, rutas, y la sección Homero contra datos de muestra.
- Punta a punta en el servidor con el ensayo prendido.
