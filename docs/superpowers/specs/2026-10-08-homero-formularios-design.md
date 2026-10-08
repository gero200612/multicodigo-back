# Homero: formularios de contacto y detector de bucles

Fecha: 2026-10-08. Estado: diseño aprobado en charla, falta revisión del spec.
Es el primero de tres specs (formularios → anuncios en Meta → reels) para que
Homero traiga clientes por más de un canal.

## Por qué

Gero necesita ver clientes ya. Hoy Homero tiene un solo canal, el mail en frío, y
dos frenos:

- El vendedor solo puede cerrar con `dejar_mail_listo`. Un negocio con web pero
  sin mail publicado se descarta, y son muchos: la mayoría de las pymes tiene un
  formulario de contacto en vez del mail.
- Las casillas arrancan en 5 mails por día (`envio.ts`, `cupoDelDia`) y suben
  despacio. El formulario no gasta ese cupo.

Además el buscador se cortó el 8/10 por tope de turnos (fix 3ad8b48). Ningún bot
detecta a un agente que repite lo mismo: el único freno es el tope.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: canales nuevos = **formularios de contacto** (no WhatsApp ni mensajes
  directos de Instagram automáticos: bloquean la cuenta). Libertad = **solo en
  primeros contactos**, que es el `modo auto` que ya existe; las respuestas a
  interesados siguen con su aprobación. Navegador real (opción A: Playwright).
- Se asume: el mail sigue siendo el canal preferido cuando hay mail (tiene
  seguimiento y es más seguro que llegue). Un formulario se manda una sola vez.
- Éxito: los negocios sin mail dejan de descartarse; cada formulario mandado
  tiene captura de prueba; ningún negocio recibe dos formularios; las respuestas
  llegan a la bandeja y atención las toma igual que las de mail.

## 1. Lo que cambia para los agentes

### Buscador
`anotar_negocio` deja de exigir mail: alcanza con la web propia (hoy ya acepta
web o mail; el cambio es en el prompt `ROL_BUSCADOR`, que hoy dice "Hace falta la
web PROPIA o un mail"). Sigue sin aceptar redes sociales como web.

### Vendedor: dos herramientas nuevas
- **`ver_formulario(url)`**: abre la página en Chromium y devuelve, como
  `<no_confiable>`: los campos (nombre visible, tipo, obligatorio, opciones de los
  select), si hay captcha (reCAPTCHA, hCaptcha, Turnstile) y la URL final. Tope:
  3 llamadas por corrida.
- **`dejar_formulario_listo`**: la salida cuando el negocio no tiene mail usable
  pero sí formulario. Recibe `url`, `mensaje` (mismas reglas que el mail: sin
  links, firmado, 80–1500 caracteres), `campos` (qué poner en cada campo extra,
  p. ej. un select de "motivo") y el mismo análisis que `dejar_mail_listo`
  (resumen, dolor, idea, factibilidad, fuentes).
  - Rechaza si la URL no es del dominio de la web del lead, si `ver_formulario`
    marcó captcha, o si el lead ya tuvo un formulario.
  - Deja el lead en `borrador` con `canal = 'formulario'` y aplica la misma
    regla que `crearSecuencia`: en `auto` se aprueba solo; si no, va la tarjeta
    de Telegram. Sin seguimiento.
- El rol del vendedor dice: si hay mail, mail; si no, formulario; si hay captcha,
  descartar con motivo `solo_formulario_con_captcha` (para medir cuántos se
  pierden así).

## 2. El envío (`homero/src/formularios.ts`)

Un tipo de tarea nuevo en la cola, `enviar_formulario`, con `requiereIa: false`.

1. Respeta lo mismo que el mail: horario (`proximaVentanaDeEnvio`), `bajas` (por
   dominio) y un **cupo propio de 15 formularios por día** (`TOPE_FORMULARIOS`).
   No toca el cupo de las casillas.
2. Abre la página con Playwright (Chromium headless, un contexto nuevo por envío,
   timeout 60 s).
3. Completa los campos por su etiqueta, `name` o `placeholder`:
   - nombre → el remitente de Homero (`deps.remitente`);
   - email → **una casilla de Homero** (la primera activa), así la respuesta entra
     a la bandeja que ya se lee;
   - teléfono → `HOMERO_TELEFONO` solo si el campo es obligatorio; si es
     obligatorio y no está configurado, no se manda y se avisa;
   - asunto → el asunto que dejó el vendedor;
   - mensaje → el mensaje;
   - extras → lo que dejó el vendedor en `campos`.
4. Envía y confirma el éxito con alguna de estas señales: texto de
   agradecimiento/enviado (`gracias|enviado|recibimos|thank|success`), un cambio
   de URL, o el formulario que desaparece. Saca captura (PNG) y la guarda en
   `homero.formularios.captura`.
5. Resultado:
   - **enviado**: lead pasa a `contactado`, se registra en `homero.formularios`.
   - **dudoso** (no se pudo confirmar): lead `formulario_dudoso`, aviso a Gero con
     la captura. **No reintenta nunca**: mandarle dos veces lo mismo a un negocio
     es peor que perderlo.
   - **error de navegador o de red antes de enviar** (no cargó, Chromium se cayó):
     se reprograma sin gastar intento, como los límites de Claude en `ia.ts`.

### Tabla nueva (`homero/migrations/007_formularios.sql`)
`homero.formularios`: `id`, `lead_id` (único: un formulario por lead), `url`,
`estado` (`pendiente|enviado|dudoso|error`), `casilla` (la que se puso como
respuesta), `captura` (bytea), `enviado_en`, `detalle` (jsonb: campos llenados,
señal de éxito). `homero.leads.canal` (`mail|formulario`, default `mail`). El
`CHECK` de `homero.leads.estado` (002_prospeccion) se reemplaza para sumar
`formulario_dudoso`.

## 3. Las respuestas

El negocio contesta por mail desde una dirección que no conocemos. En
`bandeja.ts`, antes de encolar `agente_atender`, si el remitente no es de un lead
conocido:

1. Busca el lead cuyo dominio de web coincide con el dominio del remitente.
2. Si no hay (respondió desde un Gmail), busca entre los formularios enviados en
   los últimos 30 días a esa casilla el que coincida con el nombre del negocio en
   el asunto, la firma o el cuerpo. Con uno solo, lo asocia; con dudas, va sin
   lead y atención decide como hoy.

De ahí en adelante, atención sigue igual: propone respuesta y Gero aprueba.

## 4. Detector de bucles (gateway, `multicodigo-vm`)

Tomado de automaton (`src/agent/loop-detector.ts`). Archivo propio
`src/agent/src/bucles.ts`, sin dependencias, para reusarlo después en Punchi.

- **Dónde se engancha:** un hook `PreToolUse` en `correrComercial`. No sirve
  `canUseTool`: con la herramienta en `allowedTools` el SDK la aprueba sin
  llamarlo (ver el comentario en `claude.ts`).
- **Reglas:**
  - la misma herramienta con los mismos argumentos 3 veces seguidas → se
    **bloquea** la llamada con el mensaje "Llamaste N veces a X con lo mismo:
    cambiá de camino o cerrá con tu herramienta de cierre";
  - el mismo conjunto de herramientas en 3 turnos seguidos → **aviso** en la
    respuesta de la herramienta; si sigue igual, se bloquea.
- El resultado de la corrida dice si hubo bloqueos (`bucles: n`); Homero lo guarda
  en `corridas.pasos` y lo cuenta en `reportarCorridaFallida`.

## 5. Despliegue

- `homero/Dockerfile`: `npx playwright install --with-deps chromium` (≈400 MB más
  de imagen). Push a main, el timer de la Toshiba despliega.
- Variable opcional nueva en `mc.env`: `HOMERO_TELEFONO`.

## 6. Tests

- `formularios.test.ts` con Playwright de verdad contra páginas servidas en local:
  formulario HTML simple, uno armado con JavaScript (estilo Wix, envío por
  fetch), uno con reCAPTCHA, uno que no muestra confirmación, uno con teléfono
  obligatorio.
- Cupo de 15, horario, `bajas` por dominio y "un formulario por lead".
- Asociación de respuestas: por dominio, por nombre del negocio, y el caso
  ambiguo que queda sin lead.
- `bucles.test.ts` en el gateway: repetición exacta, patrón de turnos, y que una
  llamada distinta corta la racha.

## Fuera de alcance

WhatsApp, mensajes directos de Instagram y llamadas. Resolver captchas. Reintentar
formularios dudosos.
