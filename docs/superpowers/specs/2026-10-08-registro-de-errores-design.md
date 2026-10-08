# Registro de errores, pantalla de Errores y "corregí este"

Fecha: 2026-10-08 · Tanda 1 de 3 (las otras: "Punchi más prolijo" y "Homero")

## Por qué

El 2026-10-08 el Ticket de Punchi falló durante horas con "El servidor no está
respondiendo. Probá en un minuto." El servidor andaba: el proyecto tenía más de
50 documentos y el bridge, y después el gateway, rechazaban el turno con
`cuerpo_invalido`/`internal`. Para encontrarlo hubo que entrar por SSH, leer
`docker logs` de tres servicios y agregar un log que no existía. El mismo día,
Homero se cayó por un timeout del IMAP y nadie se enteró.

Objetivo: que cualquier falla del servidor quede registrada con su contexto, se
vea en una pantalla, se entienda en el front, y se pueda mandar a arreglar con un
botón.

## Decisiones tomadas con Gero

- Alcance: **todo lo del servidor**: lo que ve el usuario y lo que pasa en el
  fondo (Homero, corridas, deploy). No los errores de JavaScript del navegador.
- Autocorrección: **rama + aprobación**. Punchi arregla y commitea en su rama
  `claude/<agente>/…`; a main va solo con el botón Publicar.
- Arquitectura: **el bridge es la central** (opción A). Nadie nuevo recibe
  credenciales de la base; el gateway sigue sin hablar con Supabase.

## Qué entra

1. Tabla `errores` + endpoint interno de reporte en el bridge.
2. Reportes desde panel, bridge, gateway, Homero y el script de deploy.
3. Pantalla `/punchi/errores` (solo admin) con detalle y estados.
4. Botón "Corregí este" → ticket desatendido sobre el proyecto Punchi.
5. Errores claros: el panel deja de aplastar todo en 502; el front traduce el
   código real y, si no lo conoce, muestra el número de error.
6. El schema del turno (con sus topes) en `@multicodigo/shared`.

## 1. Tabla y endpoint (bridge)

Migración `bridge/migrations/047_errores.sql`:

```sql
CREATE TABLE errores (
  id          bigserial PRIMARY KEY,
  huella      text NOT NULL,          -- servicio|codigo|detalle_corto
  servicio    text NOT NULL,          -- panel | bridge | gateway | homero | deploy
  codigo      text NOT NULL,          -- el `code` de la respuesta o del crash
  mensaje     text NOT NULL,          -- una linea legible
  detalle     jsonb NOT NULL DEFAULT '{}',  -- stack, issues de zod, ruta HTTP...
  proyecto_id uuid,
  usuario_id  uuid,
  veces       int NOT NULL DEFAULT 1,
  primera     timestamptz NOT NULL DEFAULT now(),
  ultima      timestamptz NOT NULL DEFAULT now(),
  estado      text NOT NULL DEFAULT 'nuevo',
              -- nuevo | arreglando | en_rama | publicado | descartado
  arreglo     jsonb                   -- job, agente, resumen, ramas, error del arreglo
);
CREATE UNIQUE INDEX errores_huella_abierta ON errores (huella)
  WHERE estado IN ('nuevo', 'arreglando', 'en_rama');
```

`POST /interno/errores` (bearer del bridge, igual que los otros `/interno`):
upsert por huella abierta → si existe suma `veces` y actualiza `ultima` y
`detalle`; si no, inserta. Un error ya `publicado` o `descartado` que vuelve a
pasar abre una fila nueva: el arreglo no anduvo y eso hay que verlo.

La **huella** la arma quien reporta: `servicio|codigo|<lo que distingue>`. Para
un rechazo de validación, lo que distingue son los paths de zod
(`documentos:too_big`); para un crash, la primera línea del stack sin números de
línea. Mismo bug repetido = una fila.

**Saneado antes de guardar** (en el bridge, no en cada servicio): se borran
claves `token`, `githubToken`, `authorization`, `password`, `prompt`, `pliego` y
cualquier valor con forma de bearer/JWT. `detalle` se corta a 16 KB. El mensaje
y el detalle son de un tercero para el agente que los lea (ver §4).

Lectura: `GET /interno/errores?estado=` y `GET /interno/errores/:id`, y
`POST /interno/errores/:id/estado` para descartar / reabrir.

Un reporte que falla **nunca** rompe al que reporta: `reportarError()` es
fire-and-forget con timeout de 3 s y se traga su propio error (lo deja en el
log). Si el bridge está caído, el error queda en `docker logs` como hoy.

## 2. Quién reporta

Un helper `reportarError(servicio, {codigo, mensaje, detalle, huella, proyectoId,
usuarioId})` en `@multicodigo/shared` para los tres servicios Node (bridge lo usa
en proceso, sin HTTP). El panel tiene su equivalente en `BridgeClient`.

| Servicio | Qué reporta |
|---|---|
| bridge | rechazos de schema en `/turnos` y demás `/interno` (con los issues de zod), turnos que terminan en 502, `uncaughtException`/`unhandledRejection` |
| gateway | toda respuesta 4xx/5xx que arma `sendError` salvo 401/403/404 esperables, y sus crashes. Reporta a `http://bridge:3000/interno/errores` con el token que ya usa para `/interno/documentos` |
| panel | un middleware: toda `UpstreamException` y toda excepción no manejada en un endpoint, con proyecto y usuario del request |
| homero | crashes (el handler se registra antes de arrancar IMAP), corridas `fallida` y corridas del buscador cortadas por tope sin anotar |
| deploy | `actualizar.sh`: rollback y "la vuelta atrás tampoco levantó", con las 15 líneas de log que ya junta. `curl` a `127.0.0.1:3000` |

En los crashes el handler reporta y **después** sale con código 1, como hoy: no
se cambia el comportamiento de reinicio, solo deja rastro.

## 3. Pantalla de Errores

Front: ruta `/punchi/errores`, entrada en el lateral de Punchi (icono `alerta`),
solo visible para admin. Panel: `GET /api/errores`, `GET /api/errores/{id}`,
`POST /api/errores/{id}/descartar`, `POST /api/errores/{id}/corregir`,
`POST /api/errores/{id}/publicar` — los cinco con el chequeo de admin que ya
existe (`solo_admin`).

- Lista: estado, servicio, mensaje, `veces`, última vez, proyecto. Filtro por
  estado; por defecto "abiertos" (nuevo, arreglando, en_rama).
- Detalle: todo lo anterior + el `detalle` legible (issues de validación como
  lista, stack en bloque), + el arreglo si hay.
- Acciones según estado: *nuevo* → Corregí este / Descartar; *arreglando* →
  ver Actividad; *en_rama* → resumen del agente, ramas tocadas, **Publicar** /
  Descartar.
- El número de error (`#123`) se ve grande: es lo que el front muestra al
  usuario cuando un código no tiene traducción (§5).

## 4. "Corregí este"

`POST /api/errores/{id}/corregir` en el panel:

1. Pasa la fila a `arreglando` (si no estaba en `nuevo`, 409).
2. Abre un turno con el flujo de Ticket que ya existe, sobre el proyecto Punchi
   (`PUNCHI_PROYECTO_ID`, variable nueva en mc.env), con un slot libre del
   admin (el mismo criterio que el Ticket), `modo: desatendido`,
   `publicar: false`.
3. El prompt: `[TICKET · Bug · error #123]` + el error saneado dentro de
   `<no_confiable>` (lo escribió un sistema que procesa texto de terceros) +
   las instrucciones: ubicar el código, **reproducirlo con un test que falle**,
   arreglarlo, correr los tests del paquete, commitear y pushear en su rama, y
   terminar con un resumen de qué causó el error y qué cambió.
4. Al terminar el turno el panel guarda en `arreglo` el job, el agente, el
   texto final y las ramas, y pasa a `en_rama`. Si el turno falla, vuelve a
   `nuevo` con `arreglo.error`, y ese fallo se registra como un error más.

Publicar llama a `/interno/despliegue/publicar` (ya existe) con el agente del
arreglo y pasa la fila a `publicado`. Desde ahí el timer despliega como siempre.

## 5. Errores claros en el front

- El panel deja de traducir a 502 los rechazos del bridge: un 4xx del bridge
  sale como 4xx con su `code`, y el cuerpo suma `errorId` cuando hubo reporte.
- Códigos nuevos con mensaje en `nucleo/errores.ts`: `cuerpo_invalido` (con el
  campo: "el proyecto tiene más documentos de los que se pueden mandar…"),
  `documentos_invalidos`, `conflicto_en_repo`.
- Código desconocido: en vez de "Algo falló del lado del servidor", "Algo falló
  (error #123). Lo podés ver en Errores." El `#` solo si vino `errorId`.

## 6. Topes en `@multicodigo/shared`

`contract.ts` exporta `CuerpoDocumentoDelTurno`, `DocumentosDelTurno`
(`.max(500)`) y `MAX_DOCUMENTOS_POR_TURNO`. Bridge y gateway importan de ahí y
borran los suyos. Release `v0.1.6` y bump en los dos `package.json`.

## Pruebas

- bridge: upsert por huella (suma, reabre tras `publicado`), saneado de claves
  y de bearer/JWT, corte a 16 KB, `/turnos` con schema inválido reporta con los
  paths de zod.
- gateway: `sendError` 5xx reporta; 401 no; un bridge caído no rompe la
  respuesta.
- panel: el middleware reporta `UpstreamException` con proyecto y usuario; los
  cinco endpoints rechazan a un no admin; `corregir` en estado ≠ nuevo da 409.
- homero: el handler de `uncaughtException` reporta antes de salir; corrida
  cortada sin anotar reporta.
- front: `errores.spec.ts` con los códigos nuevos y el fallback con `#id`;
  la pantalla con una fila por estado.
- A mano en producción: forzar un rechazo (turno con un campo inválido desde
  curl), verlo en la pantalla, "Corregí este" y "Publicar".

## Fuera de esta tanda

- Errores de JavaScript del navegador.
- Autocorrección sin aprobación, o disparada sola.
- Avisos por Telegram de errores nuevos (Telegram ya avisa deploys y Homero).
- Las capturas que se acumulan como documentos y la limpieza del worktree
  (tanda 2); lo de Homero salvo reportar sus crashes (tanda 3).
