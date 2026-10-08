# Homero: anuncios en Meta con formulario y tope de gasto

Fecha: 2026-10-08. Estado: diseño aprobado en charla, falta revisión del spec.
Primero de dos specs (anuncios → reels).

## Por qué

El mail en frío tarda semanas en rendir (calentamiento de casillas). Gero quiere
"darle plata y que traiga clientes" sin crear cuentas él cada vez. Lo único donde
la plata trae consultas en días es la publicidad paga.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: Meta primero (Instagram y Facebook, anuncios con formulario dentro);
  Google después. Presupuesto inicial **$50.000 ARS por mes**. Marca **Sincro**
  (@sincro_ar). **Todo anuncio nuevo pasa por su aprobación**; mover plata entre
  anuncios aprobados y pausar los malos lo hace Homero solo.
- Ya armado (2026-10-08): página Sincro `61595291607526`, portfolio
  `1578551007142191`, cuenta publicitaria **Homer** `act_980029277705534` (ARS,
  límite de Meta $50.000/mes), app `1410095257330902`, usuario del sistema
  `homero` (Employee) y token con 12 permisos en `/root/mc.env` (`META_TOKEN`,
  `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_APP_ID`). Condiciones de lead ads
  aceptadas. Política de privacidad: `https://www.sincroresto.com/privacidad`.
- Se asume: el lead que llena un formulario de Meta **pidió** que lo contacten, así
  que el primer mail sale enseguida sin esperar cupo ni horario.
- Éxito: Gero ve todos los días cuánto se gastó, cuántas consultas entraron y
  cuánto costó cada una; nunca se gasta más del presupuesto del mes; cada consulta
  le llega a Telegram en minutos.

## 1. Cliente de Meta (`homero/src/meta.ts`)

Interfaz `Meta` (como `Correo` en `envio.ts`) para testear sin la API real, y una
implementación con `fetch` a `graph.facebook.com/v{N}` (versión fija en config).
Métodos: crear campaña / conjunto / formulario / creativo / anuncio, cambiar
estado y presupuesto diario, leer insights, leer leads de un formulario, subir
imagen. El token nunca se loguea ni va a la IA.

## 2. El agente publicista (`agente_publicitar`)

Corrida pensante como las otras (objetivo + herramientas + libreta), una por día
a las 10:00, más una extra cuando Gero aprueba un anuncio.

- **Objetivo:** "Conseguí consultas de pymes al menor costo posible con el
  presupuesto que queda del mes."
- **Herramientas:**
  - `ver_resultados`: por anuncio y por rubro, gasto, impresiones, consultas,
    costo por consulta, y lo que salió después de esas consultas (reuniones,
    ventas), cruzado con `homero.leads`.
  - `proponer_anuncio(rubro, titulo, texto, frase_imagen, preguntas)`: arma la
    imagen con la plantilla de Sincro y deja el anuncio **propuesto**. No gasta
    nada hasta que Gero aprueba.
  - `repartir_presupuesto({anuncioId: diario})` y `pausar_anuncio(id, motivo)`:
    solo sobre anuncios aprobados.
  - `escribir_libreta`.
- La campaña es una sola (`OUTCOME_LEADS`); cada anuncio aprobado es un conjunto
  con su presupuesto diario, segmentado a Argentina, 25–65 años, intereses de
  dueños de pymes y el rubro.

## 3. Tope de plata (lo controla el código)

- `homero.estado['presupuesto_mes']` = 50000 (ARS). Gero lo cambia con
  `/presupuesto 80000` en Telegram o desde el panel.
- Antes de **cada** cambio de presupuesto diario: gasto del mes (insights) + suma
  de diarios activos × días que faltan ≤ presupuesto del mes. Si no entra, se
  rechaza con el número que entraría.
- Al llegar al 90% del mes, se pausa todo y se avisa. El límite de la cuenta en
  Meta ($50.000) queda como segundo tope; si Gero sube el presupuesto por encima,
  Homero le recuerda subirlo también en Meta (con link).

## 4. Aprobación de anuncios

Tarjeta de Telegram (y la misma en el panel, `/homero/anuncios`): la imagen, el
título, el texto, las preguntas del formulario, el rubro y por qué lo propone.
Botones: **✅ Aprobar** (sale con el diario que propuso, dentro del tope),
**✏️ Cambiar** (Gero escribe qué cambiar; el publicista lo rehace en una corrida
corta), **🗑 Descartar**. Recién al aprobar se crea en Meta. Meta igual lo revisa.

## 5. Consultas que entran

- Cada 5 minutos Homero lee los leads nuevos de cada formulario (consulta, no
  webhook: no hay que exponer nada).
- Cada lead nuevo: entra a `homero.leads` con `fuente = 'meta'` y estado
  `caliente`, sin duplicar (por `leadgen_id`, y por mail o teléfono si ya existía).
- Aviso inmediato a Gero por Telegram: nombre, empresa, lo que contestó y un link
  `wa.me` para escribirle por WhatsApp.
- Mail automático en minutos desde una casilla: corto, en respuesta a lo que
  contestó, con tres horarios libres de `agenda.ts`. Opción `solicitado` en
  `enviarMail`: no espera horario ni cupo. Si responde, atención sigue igual (con
  aprobación).

## 6. Resumen diario

A las 20:00 por Telegram: gasto de hoy y del mes contra el presupuesto, consultas,
costo por consulta, reuniones y ventas que salieron de anuncios, y el anuncio que
mejor anduvo. Mismos números en el panel.

## 7. Tablas (`homero/migrations/008_anuncios.sql`)

`homero.anuncios` (id, meta_ids jsonb, rubro, titulo, texto, imagen bytea,
preguntas jsonb, estado `propuesto|aprobado|activo|pausado|descartado`, diario,
motivo, creado_en, aprobado_en) y `homero.gastos` (dia, anuncio_id, gasto,
impresiones, consultas) que llena una lectura de insights por hora.
`homero.leads.leadgen_id` único, y el `CHECK` de `homero.leads.estado` suma
`caliente`.

## 8. Tests

`Meta` falsa: tope de presupuesto (incluido el borde del 90% y cambio de mes),
que nada se cree sin aprobación, leads sin duplicar, mail `solicitado`, armado del
resumen. Plantilla de imagen: snapshot del PNG.

## 9. Detector de bucles (gateway, `multicodigo-vm`)

Tomado de automaton (`src/agent/loop-detector.ts`). Va con este spec porque el
publicista es una corrida más larga que las de hoy, y el buscador ya se cortó
por tope de turnos el 8/10. Archivo propio `src/agent/src/bucles.ts`, sin
dependencias, para reusarlo después en Punchi.

- **Dónde se engancha:** un hook `PreToolUse` en `correrComercial`. No sirve
  `canUseTool`: con la herramienta en `allowedTools` el SDK la aprueba sin
  llamarlo (ver el comentario en `claude.ts`).
- **Reglas:** la misma herramienta con los mismos argumentos 3 veces seguidas se
  **bloquea** con el mensaje "Llamaste N veces a X con lo mismo: cambiá de camino
  o cerrá"; el mismo conjunto de herramientas en 3 turnos seguidos da un
  **aviso**, y si sigue igual, se bloquea.
- El resultado de la corrida informa los bloqueos (`bucles: n`); Homero los
  guarda en `corridas.pasos` y los suma a `reportarCorridaFallida`.
- Tests (`bucles.test.ts`): repetición exacta, patrón de turnos, y que una
  llamada distinta corta la racha.

## Fuera de alcance

Formularios de contacto en frío (descartado por Gero el 2026-10-08).

Google Ads. Públicos personalizados y píxel. Que Homero cambie el límite de la
cuenta en Meta.
