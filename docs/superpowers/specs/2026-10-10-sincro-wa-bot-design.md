# sincro-wa: el bot general de WhatsApp

Fecha: 2026-10-10. Estado: diseño aprobado en charla, falta revisión del spec.

## Por qué

Homero necesita atender leads por WhatsApp y las apps de los clientes quieren
WhatsApp para recibir facturas, mandar avisos y atender. Hacer un bot por app
repite la misma integración con Meta una y otra vez. Un solo bot con un catálogo de
capacidades conecta cada número una vez y le da a cada app solo lo que pidió.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: **Cloud API oficial de Meta**, nada de librerías no oficiales.
- Dijo: el número de Sincro es el WhatsApp Business de Gero (+54 9 11 4187-9467),
  migrado entero a la API (sin coexistencia). Ya está: CONNECTED, TIER_250,
  phone_number_id `1405287685995571`, WABA `1786410379074282`.
- Dijo: las apps de clientes usan **el número del cliente**, conectado con un
  botón "Conectar WhatsApp" (Embedded Signup v4). Para eso Sincro tiene que ser
  Tech Provider (requiere el portfolio verificado, que hoy no está).
- Dijo: **SincroResto queda afuera** del bot.
- Dijo: **un solo bot** (`sincro-wa`) en el VPS OVH con Coolify, con un catálogo de
  capacidades. Cada app se vincula a las que quiere y expone `/bot/...` por cada una.
  Primeras: leads de Homero, recibir facturas con IA, avisos y recordatorios,
  atender con IA.
- Dijo: Homero por WhatsApp es **todo automático**. Esto reemplaza las reglas
  viejas de "respuestas con aprobación" y "no WhatsApp automáticos". Cada charla
  se avisa por Telegram.
- Dijo: la API es **privada**. Lo único público es el webhook de Meta.
- Dijo: sección **WhatsApp en Homero** con negocios, mensajes, plantillas, bajas,
  costos y alertas.
- Dijo: la alerta de "no llegan mensajes" salta a las **6 h**.
- Dijo: el **tope de gasto lo define cada cliente al vincular la cuenta**. Se ve en
  el apartado de ese negocio en Homero, junto con su gasto, y **Gero lo puede
  cambiar**.
- Dijo: al llegar al 100 % del tope, el bot **frena lo que se paga**
  (plantillas fuera de la ventana de 24 h) y **sigue contestando lo gratis**
  (servicio dentro de la ventana). Avisa a Gero.
- Dijo: **el cliente no ve gasto ni tope**. Si quiere saber algo, le pregunta a
  Gero.
- Dijo: el botón **"Conectar WhatsApp" lo pone Punchi** en la app cuando la arma.
- Dijo, y es **regla de diseño clave**: **no se da más de lo que se pidió**. Cada app
  tiene solo las capacidades que el cliente pidió. Un taller que solo recibe
  facturas no puede mandar promociones ni avisos. Dentro de "Conectar WhatsApp" se
  muestran los permisos que va a tener esa app.
- Se asume: los costos se muestran en ARS (lo que cobra Meta) y en USD, pasados con
  el **dólar tarjeta** que ya usa el Administrador de Homero.
- Éxito:
  - Un lead escribe al número de Sincro y Homero le contesta solo en segundos.
  - Un cliente manda la foto de una factura y queda cargada en su app.
  - Una app manda un recordatorio con plantilla y sabe si llegó, si lo leyeron o si
    falló.
  - Gero abre WhatsApp en Homero y ve, por negocio, el estado, el gasto del mes
    contra el tope y las alertas.

## 1. Piezas y dónde viven

```
                 Meta (Cloud API)
                       │  webhook (todos los números)
                       ▼
 ┌──────────── VPS OVH (Coolify) ────────────┐
 │  sincro-wa  (Node + Postgres propio)       │
 │   ├─ Puerta: verifica la firma de Meta y   │
 │   │   manda por la API de Meta             │
 │   ├─ Ruteo: phone_number_id → negocio      │
 │   ├─ Capacidades (catálogo)                │
 │   ├─ Reglas comunes: bajas, ventana 24 h,  │
 │   │   tope de gasto, registro              │
 │   └─ IA: Claude, consumo por negocio       │
 └──────────────┬─────────────────────────────┘
                │ VPN (Tailscale)
        ┌───────┴─────────────────┐
        ▼                         ▼
  Apps de clientes          Homero (Toshiba)
  (exponen /bot/...)        sección "WhatsApp"
```

- **Público:** solo `https://wa.apps.punchi.dev/webhook`. Acepta únicamente pedidos
  con firma válida de Meta (`X-Hub-Signature-256` con el app secret) y rechaza el
  resto. El `GET` de verificación usa un verify token propio.
- **Privado (por VPN):** toda la API para apps y para Homero. Coolify no la expone
  a internet.
- **Clave por negocio:** cada app la tiene en su entorno como `SINCRO_WA_KEY`. El bot
  guarda solo el hash. La clave define qué número puede usar esa app (solo el suyo)
  y qué capacidades (ver §3.0). Homero tiene una clave de administrador aparte.
- **Token de Meta:** el bot usa el token del system user (el mismo que está en
  `/root/mc.env`), guardado en su propio entorno. Para los números de clientes usa
  el token que da el Embedded Signup, guardado cifrado.
- **Regla de logs:** nunca imprimir un token. Todo error de Graph pasa por un filtro
  que tapa `EAA…`, porque Meta devuelve el token entero en "Malformed access token".

## 2. Reglas comunes a todas las capacidades

- **Registro:** todo mensaje que entra o sale queda guardado con su negocio,
  categoría (marketing, utilidad, autenticación o servicio), costo estimado y,
  cuando llega, costo real.
- **Bajas:** si alguien escribe "baja", "no me escribas más" o algo parecido, el bot
  deja de escribirle desde ese número. Ninguna app puede saltear una baja. Se
  revierte solo si la persona vuelve a escribir y pide volver.
- **Ventana de 24 h:** la controla el bot. Texto libre fuera de la ventana se
  rechaza con `409 fuera_de_ventana` y se le indica a la app que use una plantilla.
- **Tope de gasto:** ver §5.
- **Tope de Meta:** si el número está cerca de su tope diario de envíos, el bot
  frena los envíos que no son respuesta y avisa.

## 3. Capacidades

Cada capacidad es una entrada en el catálogo: un nombre, qué eventos de WhatsApp
le pasa a la app, qué endpoints del bot puede usar la app y qué endpoint tiene que
exponer la app. Agregar una (por ejemplo, pedidos) es sumar una entrada al catálogo y
el endpoint en la app, sin rehacer el bot.

Catálogo inicial: `leads` (solo Homero), `facturas`, `avisos`, `atender` y
`promociones`. `promociones` existe solo para dárselo a quien lo pidió (plantillas de
marketing).

### 3.0 Permisos: no se da más de lo que se pidió

Esta es la regla que manda sobre todo el diseño.

- **Quién decide:** Punchi, cuando arma la app, a partir de lo que pidió el
  cliente (el análisis funcional). Da de alta el negocio en el bot con **exactamente**
  esas capacidades, recibe la `SINCRO_WA_KEY` y pone el botón "Conectar WhatsApp" en
  la app. Si el cliente no pidió WhatsApp, la app no tiene botón ni clave.
- **Qué ve el cliente al conectar:** la pantalla de "Conectar WhatsApp" lista en
  palabras simples lo que esa app va a poder hacer con su número. Por ejemplo:
  "Recibir facturas que te manden por WhatsApp y contestar que quedaron cargadas".
  También pide el tope de gasto mensual. Recién después abre el Embedded Signup de
  Meta.
- **El bot niega todo por defecto:**
  - La clave que crea Punchi lleva adentro solo las APIs de sus capacidades. Para esa
    clave, el resto de las APIs **no existe**: responden `404`, como si no
    estuvieran publicadas, y el intento queda registrado.
  - Solo le pasa a la app los eventos de sus capacidades. Por ejemplo, un taller con
    solo `facturas` no recibe charlas para atender.
  - Las plantillas quedan atadas a la capacidad. `facturas` no puede crear ni mandar
    plantillas. `avisos` solo puede usar plantillas de utilidad. Marketing requiere
    `promociones`. Si Meta pasa una plantilla de utilidad a marketing, el bot la
    bloquea para esa app y avisa a Gero.
- **La app nunca ve el token de Meta:** lo guarda el bot, cifrado. La app solo tiene
  su clave del bot, así que no puede hablar con Meta por su cuenta ni saltear estos
  límites.
- **Los permisos de Meta no alcanzan solos:** el Embedded Signup le pide al cliente
  los mismos permisos de WhatsApp a todos (`whatsapp_business_management` y
  `whatsapp_business_messaging`), y Meta no deja recortarlos por función. El límite
  real lo pone el bot.
- **Cambiar permisos:** solo Gero, desde Homero, y el cambio queda registrado. La app
  no puede pedir ni sumar capacidades. Si el cliente quiere algo más, se lo pide a
  Gero.

### 3.1 Leads (Homero, número de Sincro)

- La lógica de venta queda en Homero: catálogo, horarios, reuniones e IA de ventas.
  Para el negocio Sincro, Homero es la app.
- Cuando entra un mensaje, el bot se lo pasa a Homero por la VPN con
  `POST /bot/leads/mensaje`. Si viene de un anuncio de clic a WhatsApp, incluye el
  anuncio (`referral`).
- Homero arma la respuesta y la manda con `POST /mensajes`. Avisa cada charla por
  Telegram.
- Todo automático, sin aprobación.

### 3.2 Recibir facturas con IA

1. El cliente manda una foto o un PDF al número de su negocio.
2. El bot baja el archivo de Meta y lo lee con Claude: proveedor, número, fecha,
   vencimiento, total e impuestos.
3. Se lo pasa a la app con `POST /bot/facturas` (los datos y el archivo).
4. Contesta por WhatsApp, por ejemplo: "Cargada: Edesur, $48.230, vence el 18/10".
   Si no pudo leerla bien, pregunta lo que falta. Si la imagen no es una factura, lo
   dice.

### 3.3 Avisos y recordatorios

1. La app pide `POST /avisos` con el destinatario, la plantilla y los datos (por
   ejemplo, "turno mañana 10:00").
2. El bot revisa que la plantilla esté aprobada, que la persona no se haya dado de
   baja, que no se pase el tope de Meta ni el tope de gasto. Después lo manda.
3. Le avisa a la app cómo terminó (entregado, leído o falló, y por qué) con
   `POST /bot/estados`.
4. La app da de alta las plantillas a través del bot (`POST /plantillas`), solo de la
   categoría que le permiten sus capacidades (ver §3.0). El bot las manda a aprobar a
   Meta. El estado se ve en Homero y la app lo puede consultar.

### 3.4 Atender con IA

- La app le pasa al bot el contexto del negocio (horarios, servicios, preguntas
  frecuentes) y, si quiere, un endpoint `POST /bot/consulta` para datos en vivo
  (por ejemplo, turnos libres).
- El bot contesta con Claude dentro de la ventana de 24 h.
- Si no sabe o la persona pide hablar con alguien, avisa a la app
  (`POST /bot/derivar`) y deja de contestar en esa charla hasta que la app la
  libere.

## 4. Sección "WhatsApp" en Homero

Homero no guarda nada propio de WhatsApp: todo lo pide al bot por la VPN con la
clave de administrador. Solo la ve Gero, como el resto del panel.

1. **Negocios vinculados:** número, estado, calidad según Meta (verde, amarilla o
   roja), tope diario de Meta, capacidades activas y último uso de la clave. Tiene
   un botón para rotar la clave. Gero puede sumar o sacar capacidades desde acá
   (ver §3.0). **En el apartado de cada negocio están el gasto del
   mes y su tope, y Gero puede editar el tope desde ahí.**
2. **Mensajes:** por negocio y por día, separados por categoría, y las charlas con
   ventana abierta.
3. **Plantillas:** estado en Meta (pendiente, aprobada o rechazada) y el motivo del
   rechazo.
4. **Bajas:** quién pidió que no le escriban y desde qué número. Solo lectura.
5. **Costos del mes por negocio:** Meta + IA = total, en ARS y USD.

## 5. Costos y tope de gasto

**Meta**
- La tabla de precios vive en el bot, con la fecha de carga, y se puede editar.
  Arranca con los valores oficiales de Argentina (2026-10-10): marketing $89,5620,
  utilidad $37,6798, autenticación $37,6798, servicio gratis.
- Al mandar un mensaje se guarda un **estimado** según la categoría de la plantilla.
- El estado `sent`/`delivered` que manda Meta trae `pricing` (`billable` y
  `category`). Con eso el bot **corrige al costo real**: quedan bien los casos
  gratis, como una plantilla de utilidad dentro de la ventana o las 72 h que siguen
  a un anuncio de clic a WhatsApp.
- Meta le cobra a cada cliente en su cuenta. Lo del bot es control nuestro y no
  reemplaza la factura de Meta.

**IA**
- Cada llamada a Claude se registra con el negocio y los tokens usados. Usa el
  mismo fondo común de cuentas que Homero.
- Se pasa a pesos con el dólar tarjeta del Administrador.

**Tope de gasto mensual**
- Lo define el cliente en el paso "Conectar WhatsApp" de su app: un monto en ARS por
  mes. Es obligatorio para terminar la vinculación.
- Se guarda en el bot por negocio. Gero lo cambia desde Homero, y cada cambio queda
  registrado (quién, cuándo, de cuánto a cuánto).
- El cliente no ve el gasto ni el tope después de conectar. La app no los puede
  leer ni cambiar. Si el cliente pregunta, le contesta Gero.
- Al 80 %: aviso a Gero por Telegram.
- Al 100 %: el bot rechaza los envíos que se pagan con `402 tope_alcanzado` y sigue
  contestando lo gratis. La app recibe el 402 para no reintentar en vano, pero no
  le muestra nada al cliente. Vuelve a habilitar al empezar el mes siguiente o cuando
  Gero sube el tope.

## 6. Alertas por Telegram

- La calidad de un número baja a amarilla o roja.
- Un número llega al 80 % de su tope diario de Meta.
- Meta rechaza una plantilla.
- No llegan mensajes de Meta hace **6 h** en un número que normalmente tiene
  movimiento.
- Un negocio llega al 80 % o al 100 % de su tope de gasto.

## 7. Datos (Postgres propio del bot)

- `negocios`: nombre, app, URL base de la app, hash de la clave, capacidades,
  tope mensual ARS, activo.
- `numeros`: negocio, phone_number_id, WABA, token cifrado (si es de un cliente),
  calidad, tope de Meta.
- `contactos`: número, negocio, última entrada (para la ventana), baja sí/no y desde
  cuándo.
- `mensajes`: negocio, contacto, dirección, tipo, categoría, wamid, estado, costo
  estimado, costo real, fecha.
- `plantillas`: negocio, nombre, idioma, categoría, estado en Meta, motivo de
  rechazo.
- `uso_ia`: negocio, capacidad, modelo, tokens de entrada y salida, costo USD, fecha.
- `precios_meta`: categoría, precio ARS, vigente desde.
- `cambios`: negocio, qué cambió (tope o capacidades), antes, después, quién,
  cuándo.

## 8. Fallas

- **App caída:** el bot reintenta la entrega del evento con espera creciente durante
  1 h. Si sigue caída, avisa por Telegram. El mensaje queda guardado igual.
- **Meta caída o rechazo:** el bot devuelve el error a la app tal cual (con el token
  tapado) y registra el intento.
- **Webhook repetido:** Meta puede mandar el mismo evento dos veces. Se descarta por
  `wamid`.
- **IA falla leyendo una factura:** se contesta "No la pude leer, ¿me la mandás de
  nuevo más nítida?" y se avisa a la app.

## 9. Pruebas

- Firma del webhook: válida pasa, inválida o ausente da 401.
- Ruteo: un phone_number_id desconocido se descarta y se registra.
- Clave: la app A no puede mandar desde el número de B.
- Permisos: una app con solo `facturas` recibe 404 en `POST /avisos`,
  `POST /plantillas` y `POST /mensajes` fuera de una respuesta a factura, y no le
  llegan charlas para atender. Una app con `avisos` no puede crear plantillas de
  marketing. Una plantilla que Meta pasa a marketing queda bloqueada para una app
  sin `promociones`.
- Bajas: después de "baja", `POST /avisos` a ese contacto se rechaza.
- Ventana: texto libre a las 25 h se rechaza. Plantilla a las 25 h pasa.
- Tope: al 80 % salen los avisos y al 100 % lo pago da 402 mientras lo gratis sigue.
- Costos: un estado con `billable: false` deja el costo real en 0.
- De punta a punta con el número de Sincro: un mensaje real llega a Homero y vuelve
  la respuesta.

## 10. Orden de implementación

1. Bot base en el VPS: webhook con firma, ruteo, registro, envío. Número de Sincro
   apuntado al bot.
2. Leads de Homero (reemplaza cualquier entrada vieja de WhatsApp de Homero).
3. Costos, tope de gasto y la sección WhatsApp en Homero.
4. Avisos y plantillas.
5. Facturas con IA.
6. Atender con IA.
7. "Conectar WhatsApp" para clientes: Punchi lo suma al armar cada app que pidió
   WhatsApp, con la pantalla de permisos y el tope, y después el Embedded Signup v4.
   Se bloquea hasta que el portfolio esté verificado y Sincro sea Tech Provider.

## Fuera de alcance

- SincroResto.
- Librerías no oficiales de WhatsApp.
- Cobrarle al cliente lo que gasta en Meta: Meta le cobra directo en su cuenta.
- Bandeja para que una persona conteste desde Homero (solo se deriva a la app).
