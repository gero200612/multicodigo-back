# sincro-wa: contrato de la API

Spec: `docs/superpowers/specs/2026-10-10-sincro-wa-bot-design.md`. Esto baja el
spec a rutas y formatos concretos. Todo JSON, fechas ISO 8601, montos ARS como
número con decimales y USD igual.

## Puertos

| Puerto (contenedor) | Quién llega | Qué sirve |
|---|---|---|
| `PUERTO_PUBLICO` (3000) | Internet, por Traefik (`wa.apps.punchi.dev`) | `GET /webhook`, `POST /webhook`, `GET /salud`. Cualquier otra ruta: 404 |
| `PUERTO_PRIVADO` (3001) | Solo VPN (Tailscale) y la red de Coolify | Todo lo demás. `/webhook` NO existe acá |

Son dos servidores Fastify distintos en el mismo proceso: así una ruta privada
no se puede alcanzar desde el dominio público aunque alguien se equivoque con
Traefik.

## Entorno

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Postgres propio del bot |
| `META_APP_SECRET` | Secreto de la app "Homero Sincro": verifica `X-Hub-Signature-256` |
| `META_VERIFY_TOKEN` | El que se pone en Meta al configurar el webhook |
| `META_TOKEN` | Token del system user: lo usan los números sin token propio (el de Sincro) |
| `META_API_VERSION` | Por defecto `v23.0` |
| `SINCRO_WA_ADMIN_KEY` | Clave de administrador (la usa solo Homero). Mínimo 32 caracteres |
| `SINCRO_WA_CIFRADO` | 32 bytes en base64: AES-256-GCM para tokens de Meta de clientes y secretos de eventos |
| `PUERTO_PUBLICO` / `PUERTO_PRIVADO` | 3000 / 3001 |

Ningún log imprime un token: todo texto de error pasa por `taparTokens()`, que
reemplaza `/EAA[A-Za-z0-9_-]{10,}/g` por `EAA…` y las claves `swa_…` por `swa_…`.

## Autenticación (puerto privado)

- `Authorization: Bearer <clave>`.
- Clave de app: `swa_<negocioId>_<43 caracteres base64url>`. El bot guarda solo
  `sha256(clave)` en hex. Comparación en tiempo constante.
- Clave de admin: `SINCRO_WA_ADMIN_KEY`.
- Sin clave o clave desconocida: `401 {"code":"sin_clave"}`.
- **Clave válida sin la capacidad de la ruta: `404 {"code":"no_existe"}`**, igual
  que una ruta inexistente. Se registra en `intentos_negados`.
- Una clave de app nunca llega a `/admin/*` (404). La de admin no usa rutas de app.
- Negocio con `activo=false`: 404 en todo.

## Capacidades

| Capacidad | Eventos que recibe la app | Rutas de app que ve | Plantillas |
|---|---|---|---|
| `leads` | `mensaje` | `POST /mensajes`, `GET /charlas/:contacto`, `GET /media/:id` | — |
| `facturas` | `factura` | `GET /media/:id` | ninguna |
| `avisos` | `estado` | `POST /avisos`, `GET/POST /plantillas` | solo `UTILITY` |
| `promociones` | `estado` | `POST /avisos`, `GET/POST /plantillas` | `MARKETING` |
| `atender` | `mensaje` (solo si la charla está derivada), `derivar` | `POST /mensajes`, `GET /charlas/:contacto`, `PUT /atender/contexto`, `POST /charlas/:contacto/liberar`, `GET /media/:id` | — |

Todas las claves de app ven `GET /eventos`, `POST /eventos/ack` y `GET /yo`.
`POST /mensajes` con `atender` solo funciona en una charla derivada.

## Rutas de app

### `GET /yo`
`200 {"negocio": {"id", "nombre", "capacidades": [...]}}`. Sin gasto ni tope:
el cliente no los ve.

### `POST /mensajes`
```json
{ "a": "5491141879467", "texto": "Hola..." }
```
- `a`: solo dígitos, 8 a 15.
- Rechazos: `409 {"code":"fuera_de_ventana"}` (más de 24 h desde el último
  mensaje entrante de ese contacto a ese número), `409 {"code":"baja"}`,
  `502 {"code":"meta","detalle":"..."}`.
- `200 {"id": <mensaje id>, "wamid": "wamid...."}`.

### `GET /charlas/:contacto?limite=30`
`200 {"contacto", "ventana_abierta": bool, "baja": bool, "derivada": bool,
"mensajes": [{"id","direccion":"entra"|"sale","tipo","texto","media_id","referral","fecha"}]}`
(del más viejo al más nuevo).

### `GET /media/:id`
Binario con su `content-type`. Solo media del propio negocio (si no, 404).

### `POST /avisos`
```json
{ "a": "5491141879467", "plantilla": "turno_recordatorio", "idioma": "es_AR",
  "variables": ["mañana", "10:00"] }
```
Controles en orden, cada uno con su código:
1. plantilla del negocio y `APPROVED` → si no `409 {"code":"plantilla_no_aprobada"}`
2. categoría permitida por las capacidades (§Capacidades) → si no `404 no_existe`
3. baja → `409 baja`
4. tope de Meta del número → `429 {"code":"tope_meta"}`
5. tope de gasto del negocio → `402 {"code":"tope_alcanzado"}`

`200 {"id","wamid","costo_estimado_ars"}`.

### `GET /plantillas` / `POST /plantillas`
```json
{ "nombre": "turno_recordatorio", "idioma": "es_AR", "categoria": "UTILITY",
  "componentes": [ { "type": "BODY", "text": "Hola, te recordamos tu turno {{1}} a las {{2}}." } ] }
```
`nombre`: `^[a-z0-9_]{1,512}$`. Categoría fuera de las permitidas: 404. Se manda
a Meta (`POST /{waba}/message_templates`) y queda `PENDING`.
`GET` devuelve `[{"id","nombre","idioma","categoria","estado","motivo","bloqueada"}]`.

### `PUT /atender/contexto`
`{"texto": "Horarios, servicios, precios, preguntas frecuentes..."}` (hasta 20.000
caracteres). `200 {"ok":true}`.

### `POST /charlas/:contacto/liberar`
La charla vuelve a la IA. `200 {"ok":true}`.

### `GET /eventos?esperar=25`
Long-poll: devuelve apenas hay eventos pendientes de ese negocio, o `[]` a los
`esperar` segundos (máx 30). Hasta 50.
`200 [{"id", "tipo", "fecha", "datos": {...}}]`.

### `POST /eventos/ack`
`{"ids":[1,2,3]}`. Solo marca los del propio negocio.

### Entrega por push (opcional)
Si el negocio tiene `url_base`, el bot además hace
`POST {url_base}/bot/{tipo}` con el mismo `{"id","tipo","fecha","datos"}` y el
encabezado `X-Sincro-Firma: sha256=<hmac hex del cuerpo con el secreto de
eventos del negocio>`. Un 2xx cuenta como ack. Reintenta con espera creciente
(30 s, 1, 2, 4, 8, 16 min...) durante 1 h; después alerta `app_caida` y el evento
queda para `GET /eventos`.

### Datos de cada evento
- `mensaje`: `{"contacto","nombre","tipo":"text"|"image"|"document"|"audio"|...,"texto","media_id","referral":{...}|null,"mensaje_id"}`
- `factura`: `{"contacto","media_id","datos":{"proveedor","cuit","numero","fecha","vencimiento","total","moneda","impuestos":[{"nombre","monto"}]}}`
- `estado`: `{"mensaje_id","wamid","estado":"sent"|"delivered"|"read"|"failed","error":{"codigo","detalle"}|null}`
- `derivar`: `{"contacto","motivo"}`

## Rutas de admin (`/admin/*`, solo `SINCRO_WA_ADMIN_KEY`)

Toda ruta que cambia algo lleva `quien` en el cuerpo (`"gero"` / `"punchi"`).

- `POST /admin/negocios` `{"nombre","app","capacidades":[...],"tope_mensual_ars","url_base"?,"quien"}`
  → `201 {"negocio":{...},"clave":"swa_...","secreto_eventos":"..."}`. La clave y el
  secreto se muestran UNA vez. `tope_mensual_ars` obligatorio y > 0.
- `GET /admin/negocios` → lista con `numeros`, `capacidades`, `tope_mensual_ars`,
  `gasto_mes_ars`, `porcentaje_tope`, `clave_ultimo_uso`, `activo`.
- `GET /admin/negocios/:id`
- `PATCH /admin/negocios/:id` `{"capacidades"?,"tope_mensual_ars"?,"url_base"?,"activo"?,"quien"}` →
  cada campo cambiado queda en `cambios`.
- `POST /admin/negocios/:id/rotar-clave` `{"quien"}` → `{"clave":"swa_..."}`.
- `POST /admin/numeros` `{"negocio_id","phone_number_id","waba_id","token"?,"quien"}`.
  Sin `token` usa `META_TOKEN`.
- `GET /admin/resumen?mes=2026-10` → `{"mes","dolar_ars","negocios":[{"id","nombre",
  "mensajes":{"marketing","utility","authentication","service"},"meta_ars","ia_usd",
  "ia_ars","total_ars","tope_mensual_ars","porcentaje_tope"}]}`. `meta_ars` usa el
  costo real cuando está y el estimado si no.
- `GET /admin/mensajes?negocio=&desde=&hasta=` → por día y categoría:
  `[{"dia","negocio_id","categoria","cantidad","costo_ars"}]` y además
  `"ventanas_abiertas": n`.
- `GET /admin/plantillas?negocio=`
- `GET /admin/bajas?negocio=` → `[{"negocio_id","contacto","desde"}]`. Solo lectura.
- `GET /admin/alertas?limite=50` y `GET /admin/cambios?negocio=`.
- `GET /admin/precios` / `PUT /admin/precios` `{"categoria","precio_ars","quien"}`.
- `PUT /admin/dolar` `{"ars_por_usd","quien"}`.
- `GET /admin/eventos?esperar=25` + `POST /admin/eventos/ack`: alertas para que
  Homero las mande por Telegram. Tipos: `alerta` con `{"tipo","negocio_id","texto"}`.
- IA (la corre Homero, con el fondo común de cuentas):
  - `GET /admin/ia/pendientes?esperar=25` → `[{"id","negocio_id","tipo":"factura"|"atender","entrada":{...}}]`.
    Los marca `tomada` por 10 min; si no vuelve resultado, vuelven a pendientes.
  - `GET /admin/ia/:id/archivo` → binario de la imagen (facturas).
  - `POST /admin/ia/:id/resultado` `{"ok":true,"salida":{...},"modelo","chars_entrada","chars_salida"}`
    o `{"ok":false,"error":"..."}`.
  - `factura` entrada: `{"media_id","mime"}`; salida:
    `{"es_factura":bool,"datos":{...como el evento...},"falta":["vencimiento",...]}`.
  - `atender` entrada: `{"contexto","charla":[{"direccion","texto"}],"negocio"}`; salida:
    `{"respuesta":"...","derivar":bool,"motivo":"..."}`.

## Reglas comunes

- **Bajas:** texto entrante que matchea `baja|stop|no me escrib|no me manden|no quiero (mas|más) mensajes|dej(a|á) de escrib|desuscrib` (sin distinguir mayúsculas, como mensaje completo o casi: hasta 60 caracteres) → contacto en baja para ese número, se contesta UNA vez "Listo, no te vamos a escribir más. Si querés volver, escribí ALTA." y no se pasa a la app. "alta" revierte.
- **Ventana:** se abre con cada mensaje entrante; dura 24 h.
- **Costos:** `precios_meta` por categoría. Al mandar una plantilla: estimado = precio de su categoría, salvo `UTILITY` con ventana abierta (0). Texto libre: 0 (servicio). Con el estado que trae `pricing`: `billable:false` → real 0; si no, real = precio de `pricing.category`. Precios iniciales: marketing 89.5620, utility 37.6798, authentication 37.6798, service 0.
- **IA:** costo USD estimado = tokens estimados (chars/4) a USD 3 / MTok entrada y USD 15 / MTok salida. Se guarda en `uso_ia`.
- **Gasto del mes** = Σ meta (real o estimado) + Σ ia_usd × dólar.
- **Tope de gasto:** al cruzar 80 % y 100 % en el mes, alerta (una vez por umbral y mes). Con gasto ≥ tope, lo que tenga costo estimado > 0 se rechaza con 402. Lo gratis sigue.
- **Tope de Meta:** `numeros.tope_meta` (de `messaging_limit_tier`: TIER_250 → 250, TIER_1K → 1000, TIER_10K, TIER_100K, TIER_UNLIMITED → sin tope). Contactos distintos con plantilla en 24 h móviles. 80 % → alerta; 100 % → 429.
- **Calidad:** cada 30 min `GET /{phone_number_id}?fields=quality_rating,messaging_limit_tier,status,verified_name`. Cambio a YELLOW/RED → alerta.
- **Sin mensajes:** número con ≥ 20 eventos de webhook en los últimos 7 días y 0 en las últimas 6 h → alerta, una vez hasta que vuelva a haber.
- **Webhook repetido:** `wamid` único; estados idempotentes.
- **Plantilla recategorizada** (`template_category_update`) a una categoría no permitida → `bloqueada=true` + alerta.
