# Homero: reels para @sincro_ar, con aprobación de Gero

Fecha: 2026-10-08. Estado: diseño aprobado en charla, falta revisión del spec.
Tercero de tres specs. Depende del de anuncios (cliente `Meta`, publicista) y del
de formularios (Chromium en la imagen de Homero).

## Por qué

Los anuncios con un reel que ya funcionó orgánicamente suelen costar menos por
consulta que una imagen fija, y una cuenta con contenido da confianza al que llega
desde un anuncio. Gero no quiere hacer el contenido él.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo: Homero arma los reels **y nada se publica sin su OK**, por Telegram o por
  el panel. Después los promociona.
- Se asume: primera versión **sin voz** (texto en pantalla + capturas reales);
  música opcional desde una carpeta de pistas libres de derechos. Dos o tres reels
  por semana.
- Éxito: a Gero le llega un video listo para ver en el celular y lo publica con
  un toque; cada reel publicado muestra cuánto rindió; los que rinden se
  promocionan con formulario.

## 1. Cómo se arma un reel

1. **Guion** — el publicista (spec de anuncios) suma la herramienta
   `proponer_reel(rubro, gancho, escenas[], texto_publicacion, hashtags)`. Cada
   escena: texto corto en pantalla + qué se ve (una captura de una URL, un video
   de pantalla de una URL, o fondo de marca).
2. **Material** — Homero graba con Playwright (ya está en la imagen): capturas o
   videos de pantalla de páginas públicas (sincroresto.com, demos desplegadas por
   Punchi). Nada de material de terceros.
3. **Render** — plantilla en código, 1080×1920, 15–30 s, colores y logo de Sincro
   (`#0166FE`, la S de dos medias lunas), texto animado. Se renderiza en Homero
   con Chromium + `ffmpeg` (frames de una página HTML de la plantilla → mp4 H.264
   + AAC). Si hay archivos en `homero/assets/musica/`, usa uno; si no, sin audio.
4. **Revisión propia** — antes de mandárselo a Gero, chequeo automático: duración,
   tamaño ≤ 50 MB (tope de video de Telegram para bots), texto dentro de las zonas
   seguras de Instagram.

## 2. Aprobación

Le llega a Gero por Telegram el **video**, el texto de la publicación con los
hashtags, el rubro y por qué lo armó. Botones:

- **✅ Publicar**: sube a @sincro_ar (reel) y a la página de Facebook.
- **📣 Publicar y promocionar**: además crea un anuncio con formulario usando ese
  reel (pasa por el tope de presupuesto del spec de anuncios; aprobarlo acá cuenta
  como la aprobación del anuncio).
- **✏️ Cambiar**: Gero escribe qué cambiar; se rehace y vuelve a llegar.
- **🗑 Descartar**.

Lo mismo en el panel, `/homero/contenido`: pendientes, publicados y sus números.

## 3. Publicación

- Instagram toma el video desde una URL pública: se sube a Supabase Storage
  (bucket privado `homero-reels`) y se pasa una URL firmada de 1 hora. Después
  de publicado se borra del bucket.
- Instagram: contenedor `REELS` con `video_url` + `caption`, se espera a que el
  estado sea `FINISHED`, y `media_publish`. Facebook: `video_reels` de la página.
- Errores de Meta (video rechazado, límite de publicaciones por día): el reel
  queda `fallido` con el motivo y se avisa; no se reintenta solo.

## 4. Cómo le fue

Cada 6 horas durante 7 días: reproducciones, alcance, guardados, compartidos y
visitas al perfil (`instagram_manage_insights`). El publicista lo ve en
`ver_resultados` y puede **proponer** promocionar un reel que rindió (vuelve a
pasar por Gero).

## 5. Tablas (`homero/migrations/009_reels.sql`)

`homero.reels`: id, guion jsonb, video (ruta local hasta publicar), estado
`armando|propuesto|aprobado|publicado|fallido|descartado`, ig_media_id,
fb_video_id, anuncio_id, metricas jsonb, motivo, fechas.

## 6. Tests

Render de una plantilla corta (duración y resolución del mp4 con `ffprobe`),
chequeos de zona segura y tamaño, flujo de botones (nada se publica sin aprobar),
publicación contra la `Meta` falsa incluido el estado intermedio del contenedor.

## Fuera de alcance

Voz en off (necesita un servicio de voz: se decide aparte). Responder comentarios
y mensajes directos. Historias. TikTok.
