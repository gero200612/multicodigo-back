# Homero: subir un video de Gero como reel (de prueba), y promocionarlo

Fecha: 2026-10-13. Estado: aprobado e implementado (ver "Al implementar" al final).
Implementa la sección 4 (publicación) y parte de la 3 y la 5 del spec
`2026-10-08-homero-reels-design.md`, con un video que manda Gero en vez de uno
armado por Homero. El armado con Remotion (secciones 1 y 2 de ese spec) es el
paso siguiente y reusa todo lo de acá.

## Por qué

El primer `/reel_prueba` (ffmpeg + SVG) no llegó al nivel: estático, mudo, con
una foto de stock sin sentido. Gero ya tiene reels buenos hechos a mano con el
kit de Remotion de `sincro-videos`, y quiere que Homero los suba sin tener que
abrir Instagram. Además quiere probarlos primero con gente que no lo sigue.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo:
  - Le manda el video a Homero por Telegram y **Homero escribe el texto** de la
    publicación (caption y hashtags) mirando el video; Gero lo aprueba o pide
    cambios.
  - Que se suba como **reel de prueba** y, **si le va bien, se publique** a los
    seguidores.
  - Se puede **promocionar de las dos formas**: con un botón al aprobarlo y con
    una propuesta de Homero cuando el reel rinde.
  - Se publica en **Instagram y en la página de Facebook**.
  - El video llega a Meta por **subida directa** (resumable), sin Storage.
- Se asume: la cuenta @sincro_ar puede no tener habilitados los reels de prueba
  (Meta no publica el mínimo; se reporta ~1.000 seguidores); nada se publica ni
  se gasta sin un OK de Gero, como con los anuncios.
- Éxito: Gero manda un video, recibe la tarjeta en menos de 2 minutos, toca
  Publicar y el reel aparece en IG (en prueba) y en FB sin que abra otra app;
  si rinde, le llega una propuesta de promoción con un monto que entra en el tope.

## 1. Recorrido

1. Gero manda un video a Homero por Telegram (como video o como archivo).
   Solo se atiende si viene del chat de Gero (el mismo control que el resto de
   los comandos).
2. Homero controla antes de bajar: **≤ 20 MB** (tope de `getFile` de la API de
   bots). Si pesa más, contesta "pesa X MB, el tope de Telegram para bots es
   20 MB" y no hace nada.
3. Lo baja a `<medios>/subidos/<id>.mp4` y lo mide con ffprobe: **vertical
   9:16** (tolerancia ±2 %), **3 a 90 s**, H.264/HEVC. Si algo no da, lo dice
   y no sigue.
4. Saca una hoja de contacto (un cuadro por segundo, como `hoja.png`) y la
   pasa al **publicista** con la herramienta nueva `proponer_publicacion_de_reel`
   (ve la imagen por MCP, igual que el revisor de anuncios). El publicista deja
   caption (≤ 2.200 caracteres, máx. 5 hashtags) y una línea de "por qué".
5. Le llega a Gero la tarjeta: el video, el caption y cuatro botones:
   - **✅ Publicar** — reel de prueba en IG + reel en la página de FB.
   - **📣 Publicar y promocionar** — lo mismo, y queda marcado para crear el
     anuncio cuando el reel esté en seguidores (sección 4).
   - **✏️ Cambiar** — Gero escribe qué cambiar (o le responde a la tarjeta);
     el publicista rehace el caption y llega una tarjeta nueva. Mismo
     mecanismo que `CAMBIO_PENDIENTE` de los anuncios.
   - **🗑 Descartar** — se borra el archivo local.

## 2. Publicación (subida directa)

Nada de URLs públicas: los bytes van a `rupload.facebook.com`.

**Instagram** (`meta.ts`, métodos nuevos en la interfaz `Meta`):
1. `POST /{ig-user}/media` con `media_type=REELS`, `upload_type=resumable`,
   `caption`, `share_to_feed=true` y `trial_params={"graduation_strategy":"SS_PERFORMANCE"}`.
2. `POST https://rupload.facebook.com/ig-api-upload/{version}/{contenedor}` con
   `Authorization: OAuth <token>`, `offset: 0`, `file_size` y el archivo.
3. Esperar `status_code=FINISHED` (cada 5 s, hasta 5 min; `ERROR` corta).
4. `POST /{ig-user}/media_publish` con `creation_id`. Se guarda `ig_media_id`.

**Facebook** (página): `POST /{pagina}/video_reels` con `upload_phase=start`
→ subida a `rupload.facebook.com/video-upload/{version}/{video_id}` →
`upload_phase=finish` con `video_state=PUBLISHED` y la descripción. Se guarda
`fb_video_id`. FB no tiene reels de prueba: sale a todos.

**Si IG rechaza los reels de prueba** (error que nombra `trial`): no se publica
nada en ningún lado; Gero recibe "Instagram no deja reels de prueba en esta
cuenta todavía" con un botón **Publicar normal** (sin `trial_params`).
Facebook se publica solo junto con IG, nunca antes.

Orden: IG primero; FB después de que IG publicó. Si FB falla, el reel queda
`publicado` con `motivo` de FB y se avisa (no se reintenta solo).

Permisos que tiene que tener el token: `instagram_content_publish`,
`instagram_basic`, `pages_manage_posts`, `pages_read_engagement`,
`instagram_manage_insights`. Se verifica contra el token de producción
(`/me/permissions`) antes de implementar; si falta alguno se le dice a Gero
cuál agregar.

## 3. Números

Cada 6 horas durante 7 días, `GET /{ig_media_id}/insights` con `reach`,
`views`, `saved`, `shares`, `likes`, `comments`, `total_interactions`,
`ig_reels_avg_watch_time`. Se guardan en `metricas` (última lectura + historial
corto). Si la API expone si el reel sigue en prueba, se guarda también
(`en_prueba`); si no, se decide solo con los números.

## 4. Promoción

**Cuándo rinde** (se evalúa desde las 72 h):
- Instagram ya lo pasó a seguidores, **o**
- alcance ≥ 2 × la mediana de alcance de los reels publicados anteriores
  (con menos de 3 anteriores: alcance ≥ 500), **y** guardados + compartidos ≥
  1 % del alcance.

**Monto**: `minimoDiario` (el que ya aprende `anuncios.ts`) + 5 %, por 5 días,
dentro de lo que queda del tope del mes (`estadoDelMes`). Si no entra, no se
propone y se avisa una vez.

- **📣 al aprobar**: cuando el reel rinde o pasa a seguidores (lo que llegue
  primero), Homero crea el anuncio sin volver a preguntar (aprobarlo con 📣
  cuenta como la aprobación del anuncio, como dice el spec de reels).
- **Sin 📣**: cuando rinde, le llega a Gero una propuesta ("el reel X rinde:
  alcance N, guardados M; ¿lo promociono con $D por día, 5 días?") con
  Promocionar / No. Una sola propuesta por reel.

El anuncio es una fila más de `homero.anuncios` (plantilla `reel`): mismo
formulario, mismas reglas de presupuesto, mismo reparto. El creativo usa
`source_instagram_media_id` + `instagram_user_id` + `call_to_action` al
formulario. Antes de crear, se lee `boost_eligibility_info` del media; si no se
puede promocionar (por ejemplo, música con derechos), se avisa el motivo y no
se crea.

## 5. Datos (`homero/migrations/015_reels.sql`)

`homero.reels`:
- `id`, `origen` (`gero` | `homero`), `archivo` (ruta local, se borra al
  publicar o descartar), `duracion`, `peso`,
- `caption`, `por_que`, `telegram_msg`,
- `estado`: `propuesto | subiendo | publicado | fallido | descartado`,
- `prueba` boolean (si salió como reel de prueba), `promocionar` boolean (📣),
- `ig_contenedor`, `ig_media_id`, `fb_video_id`, `anuncio_id` → `homero.anuncios`,
- `metricas` jsonb, `propuesta_promo_en`, `motivo`,
- `creado_en`, `aprobado_en`, `publicado_en`.

`homero.anuncios` suma `reel_id` (nullable) para los anuncios hechos con un reel.

## 6. Errores y reinicios

- Meta falla en cualquier paso: `fallido` con el motivo (pasado por `ocultar`)
  y aviso por Telegram. No hay reintento automático; la tarjeta de aviso trae
  **Reintentar**.
- Homero se reinicia con un reel en `subiendo`: al arrancar, si tiene
  `ig_contenedor`, se consulta su estado y se sigue desde ahí; si no, vuelve a
  `propuesto` y se le avisa a Gero.
- Un solo reel subiendo a la vez.
- `/reel_prueba` sigue existiendo hasta que llegue el armado con Remotion.

## 7. Tests (Meta falsa, sin red)

- Nada se publica sin el OK de Gero; un video de otro chat se ignora.
- Video > 20 MB, horizontal o de más de 90 s: se rechaza con el motivo.
- Tarjeta → ✏️ Cambiar → tarjeta nueva con el caption rehecho.
- Subida IG: contenedor resumable, `IN_PROGRESS` → `FINISHED`, `media_publish`;
  `ERROR` deja `fallido`.
- Rechazo del reel de prueba: no publica en ningún lado y ofrece Publicar normal.
- FB después de IG; si FB falla, el reel queda publicado con el motivo.
- Rinde / no rinde (con y sin historia), una sola propuesta por reel.
- 📣 crea el anuncio al rendir y respeta el tope; sin elegibilidad no lo crea.
- Reinicio con un reel en `subiendo` lo retoma.

## Fuera de alcance

El armado de reels con Remotion (spec siguiente). Videos de más de 20 MB
(necesitaría un servidor propio de la API de bots). Programar la hora de
publicación. Historias. Responder comentarios. El panel `/homero/contenido`
(después; la tabla ya queda lista).

## Al implementar (2026-10-13)

- Estado nuevo `escribiendo` antes de `propuesto`: el publicista todavía arma el texto.
- Reinicio con un reel en `subiendo`: se vuelve a encolar siempre; si ya había
  contenedor, sigue desde ahí (no vuelve a `propuesto`).
- Al publicar se guarda una portada (`<medios>/portadas/reel-<id>.png`) antes de
  borrar el video: es la imagen de la fila del anuncio si se promociona.
- La pausa a los 5 días la hace la misma lectura de cada 6 horas (`leerReels`).
- Código: `homero/src/publicar-reel.ts` (reglas), `video.ts` (ffprobe/ffmpeg),
  `meta.ts` (subida resumable, métricas, creativo de reel), `telegram.ts`
  (botones `rp rq rn rc rd rr rs rx`).
- De paso: `COLUMNAS_DE_ANUNCIO` no leía `variantes`, así que las variantes de
  texto de los anuncios nunca se creaban en Meta. Arreglado.
