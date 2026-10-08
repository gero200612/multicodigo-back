# Homero: reels que venden Sincro, con director y aprobación de Gero

Fecha: 2026-10-08. Estado: diseño aprobado en charla, falta revisión del spec.
Segundo de dos specs (anuncios → reels). Usa el cliente `Meta` y el agente
publicista del spec de anuncios.

## Por qué

Un anuncio con un reel bueno suele costar menos por consulta que una imagen fija,
y una cuenta con contenido le da confianza al que llega desde un anuncio. Gero no
quiere hacer el contenido él, pero tampoco quiere ver videos mediocres.

## Qué entendimos (lo que dijo Gero / lo que se asume)

- Dijo:
  - Homero arma los reels y **nada se publica sin su OK** (Telegram o panel).
    Después los promociona.
  - **Con música**, generada con IA: un tema original por reel.
  - **Que venda**: lo que hace Sincro y el problema que resuelve. **No** mostrar
    pantallas de las aplicaciones.
  - **Original, nada básico.**
  - **Revisado a fondo antes de que le llegue**: prefiere no recibir nada antes
    que un video "medio pelo".
- Se asume: sin voz en off (se decide aparte); 2 o 3 reels por semana; español
  rioplatense; 15–30 s.
- Éxito: cada reel que le llega a Gero pasó un director exigente y él lo
  publicaría tal cual la mayoría de las veces; ningún reel repite gancho ni
  estructura de los anteriores; los que rinden se promocionan con formulario.

## 1. Cómo se arma

### 1.1 Concepto y guion
El publicista suma la herramienta `proponer_reel`. Antes de escribir, ve los
últimos 15 reels (gancho, estructura, escenas, números) para no repetirse. Deja:
- **gancho** (lo que se lee en los primeros 2 s), **ángulo** (dolor, número,
  antes/después, historia de un cliente tipo, pregunta, mito), **rubro**;
- **escenas**: tipo de escena de la biblioteca, texto, duración en beats, y
  parámetros (números, íconos, colores dentro de la marca);
- **música**: género, clima, BPM, y dónde va el pico;
- **cierre** con llamado a la acción ("Escribinos", "Dejá tus datos");
- texto de la publicación y hashtags.

Reglas de contenido en el prompt: vender el resultado (horas, plata, errores que
se evitan), no la tecnología; nada de pantallas de apps; nada de frases de
plantilla ("¿Sabías que…?", "En el mundo de hoy…"); un solo mensaje por reel.

### 1.2 Biblioteca de escenas (Remotion)
Proyecto Remotion dentro de Homero (`homero/reels/`), 1080×1920 a 30 fps. Se
diseña una biblioteca de **15 tipos de escena** de motion graphics, cada uno con
2 o 3 variantes de estilo, para que las combinaciones no se repitan. Ejemplos:
- titular cinético (palabras que entran al ritmo);
- contador que baja ("3 hs por día" → "0");
- lluvia de mensajes de WhatsApp que tapa la pantalla y se ordena;
- pila de papeles que se cae;
- pantalla partida antes/después;
- reloj en cámara rápida;
- checklist que se tilda sola;
- cascada de notificaciones;
- gráfico que sube;
- cita de un dueño de pyme;
- cierre con el logo de Sincro animado (las dos medias lunas que se juntan).

Paleta y tipografía de Sincro (`#0166FE`, blanco, negro); transiciones con
resortes y desenfoque de movimiento; cortes **en el beat**. El agente compone; no
escribe código de animación.

### 1.3 Música (ElevenLabs Music API)
Homero pide un tema con el género, el clima, el BPM y la duración del guion. Con
el BPM se calcula la grilla de beats y las escenas se cortan sobre ella. Después
de generar, Homero detecta los golpes reales del audio (ffmpeg) y corrige la
grilla si el tema se corrió. Volumen normalizado a −14 LUFS, que es lo que usa
Instagram. Clave en `mc.env`: `ELEVENLABS_API_KEY`. Sin clave, no se arman reels
(no hay versión sin música).

### 1.4 Render
`@remotion/renderer` en Homero (trae su propio Chromium y ffmpeg): mp4 H.264 +
AAC, ≤ 50 MB (tope de video de Telegram para bots).

## 2. El director (antes de que llegue a Gero)

Una corrida aparte, `agente_dirigir`, que **no** es la que armó el reel. Ve:
- hojas de contacto con un cuadro cada 0,5 s (imágenes, vía la herramienta
  `ver_cuadros` del MCP de Homero);
- el guion, el análisis del audio (BPM, golpes, volumen) y dónde caen los cortes;
- las hojas de contacto de los últimos 15 reels.

Puntúa de 1 a 10 con una rúbrica:
- **gancho**: ¿frena el scroll en 2 s?
- **claridad**: ¿se entiende sin sonido?
- **legibilidad**: ¿se lee cada texto en el tiempo que está?
- **ritmo**: ¿los cortes caen en el beat? ¿hay tiempos muertos?
- **música**: ¿acompaña y tiene pico donde debe?
- **marca**: ¿se nota que es Sincro?
- **venta**: ¿queda claro qué ofrecemos y qué hacer?
- **originalidad**: ¿se parece a alguno anterior?
- **terminación**: ¿hay algo que se vea roto, cortado o amateur?

**Pasa solo con 8 o más en todo.** Si no pasa, devuelve correcciones concretas
("el texto de la escena 3 dura 0,8 s, necesita 1,5"; "el gancho es genérico") y
se rehace. **Máximo 3 vueltas.** Si a la tercera no pasa, se descarta y Gero
recibe solo un aviso de una línea ("descarté un reel sobre X: no llegó al nivel"),
nunca el video.

Controles técnicos automáticos antes del director (si fallan, ni lo ve):
duración, resolución, volumen, y que ningún texto caiga en las zonas que tapa la
interfaz de Instagram (arriba 220 px, abajo 420 px, derecha 120 px). Las
posiciones salen del layout de la composición, no de adivinar en la imagen.

## 3. Aprobación de Gero

Telegram: el **video**, el texto de la publicación con hashtags, el rubro, por
qué lo armó y **la nota del director** (puntajes y qué mejoró en cada vuelta).
Botones:
- **✅ Publicar**: sube a @sincro_ar y a la página de Facebook.
- **📣 Publicar y promocionar**: además crea un anuncio con formulario con ese
  reel, dentro del tope de presupuesto. Aprobarlo acá cuenta como la aprobación
  del anuncio.
- **✏️ Cambiar**: Gero escribe qué cambiar; vuelve a pasar por el director.
- **🗑 Descartar**.

Lo mismo en el panel, `/homero/contenido`: pendientes, publicados y sus números.

## 4. Publicación

- Instagram toma el video desde una URL pública: se sube a Supabase Storage
  (bucket privado `homero-reels`) y se pasa una URL firmada de 1 hora; después de
  publicado se borra.
- Instagram: contenedor `REELS` (`video_url` + `caption`), esperar `FINISHED`,
  `media_publish`. Facebook: `video_reels` de la página.
- Si Meta rechaza (video, límite diario de publicaciones): queda `fallido` con el
  motivo y se avisa. No se reintenta solo.

## 5. Cómo le fue

Cada 6 horas durante 7 días: reproducciones, alcance, retención, guardados,
compartidos, visitas al perfil. El publicista lo ve en `ver_resultados`; el
director lo usa para calibrar (qué ganchos retienen). Un reel que rinde se puede
**proponer** para promocionar, y vuelve a pasar por Gero.

## 6. Tablas (`homero/migrations/009_reels.sql`)

`homero.reels`: id, guion jsonb, musica jsonb (pedido, BPM, golpes), video (ruta
local hasta publicar), vueltas jsonb (puntajes y correcciones del director en
cada una), estado `armando|dirigiendo|propuesto|aprobado|publicado|fallido|descartado`,
ig_media_id, fb_video_id, anuncio_id, metricas jsonb, motivo, fechas.

## 7. Tests

- Cada tipo de escena renderiza sus variantes (snapshot de cuadros clave).
- Cortes en el beat con un audio de prueba de BPM conocido.
- Controles técnicos: zonas seguras, volumen, tamaño.
- Flujo del director: pasa, corrige y pasa, descarta a la tercera (sin mandar
  el video).
- Nada se publica sin aprobación; publicación contra la `Meta` falsa con el
  estado intermedio del contenedor.

## Fuera de alcance

Voz en off. Video generado con IA (clips tipo Veo o Sora). Responder comentarios
y mensajes directos. Historias. TikTok.
