# Punchi publica en el VPS (Coolify)

Fecha: 2026-10-09. Estado: diseño aprobado en charla, falta revisión del documento.

## Qué se quiere

Gero es el único que usa Punchi y todo lo que Punchi construye va a vivir en el
VPS de OVH (Coolify, ver memoria `project_vps_ovh`). Hoy Punchi publica en
Render/Vercel/Netlify/Railway y crea las bases en Supabase; cada proyecto deja
cables sueltos (env vars, URL del back en el front, DNS).

Lo que tiene que pasar:

1. Un proyecto de Punchi (demo de Homero, Desarrollo, Estructura, `/corrida`)
   termina con **tres partes en el VPS**: base Postgres, back y front, ya
   conectadas, y **devuelve el link** (`nombre.apps.punchi.dev`).
2. **Repositorios** es el panel de lo publicado: muestra qué está en el VPS, en
   qué estado y con qué link, y permite **Publicar**, **Apagar** y **Borrar del
   VPS**.
3. El VPS no se llena sin aviso, y lo que es producción (SincroResto,
   Justadama) no se puede romper desde Punchi.

Éxito: Gero pide una demo desde Homero, la corrida cierra, y le llega un link
que abre y anda, sin tocar Coolify, DNS ni variables a mano.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Camino | El VPS es un **proveedor más** (`vps`) del sistema de destinos que ya existe (`proveedores.ts`, `publicar.ts`). El bridge le habla a la API de Coolify por Tailscale. |
| Por defecto | `vps` es el destino **por defecto de todo repo nuevo**. Render/Vercel/Netlify/Railway quedan en el menú pero solo se usan si se eligen a mano. |
| Deshostear | Las dos: **Apagar** (stop, conserva config y datos; Publicar lo vuelve a prender) y **Borrar del VPS** (borra base, datos y apps de Coolify; el código queda en GitHub), con confirmación escribiendo el nombre. |
| Base | Postgres propio por proyecto, creado por Coolify. Los proyectos `vps` **no usan Supabase**. |
| Dominios | `<nombre>.apps.punchi.dev` (front) y `<nombre>-api.apps.punchi.dev` (back). El wildcard ya apunta al VPS: no hay llamadas a DNS. Certificados: Traefik/ACME de Coolify. |
| Lugar | Un armado a la vez; freno si queda < 1 GB de memoria libre; demos de Homero se apagan solas a los 14 días de la reunión (aviso el día antes); nada se borra solo. |
| Producción | SincroResto y Justadama se registran como `produccion`: se muestran, no se pueden apagar ni borrar desde Punchi. |

## Arquitectura

```
panel (Angular)            panel-api (.NET)               bridge (Node)                 VPS
Repositorios ──HTTP──▶ /proyectos/{p}/vps/... ──▶ /interno/vps/... ──Tailscale──▶ Coolify API :8000
                         (acceso_a_proyecto)        coolify-api.ts                   └─ Postgres / back / front
corrida cierra ─────────────────────────────▶ publicar.ts → proveedor vps
```

### Unidades nuevas

- **`bridge/src/coolify-api.ts`**: habla HTTP con Coolify y nada más. Funciones:
  `crearBase`, `crearApp` (private-github-app, Dockerfile), `setearEnvs`
  (bulk), `desplegar`, `estadoDe`, `prender`, `apagar`, `borrar`. Todas devuelven
  `{ ok: false, motivo }` en vez de tirar, y el motivo nunca lleva el token
  (mismo patrón que `proveedores.ts`). Recibe `fetch` por parámetro para los
  tests.
- **`bridge/src/vps.ts`**: la política. Arma las tres partes de un proyecto,
  decide qué crear y qué solo desplegar, conecta back↔base↔front, aplica el
  freno de memoria y los nombres reservados. No habla HTTP: recibe
  `coolify-api` y el store por `deps` (mismo corte que `publicar.ts` /
  `render-api.ts`).
- **`bridge/src/vps-uso.ts`**: lee memoria y disco del VPS (ver "Uso del VPS").
- **Tabla `vps_recursos`** (migración nueva del bridge):

  ```sql
  create table vps_recursos (
    id uuid primary key default gen_random_uuid(),
    proyecto_id uuid not null references proyectos(id) on delete cascade,
    parte text not null check (parte in ('base','back','front')),
    repo text,                    -- null para la base
    coolify_uuid text not null unique,
    url text,                     -- null para la base
    estado text not null default 'creando'
      check (estado in ('creando','construyendo','andando','apagado','fallo')),
    motivo text,                  -- último fallo, corto
    produccion boolean not null default false,
    apagar_el timestamptz,        -- demos: reunión + 14 días
    avisado_apagado boolean not null default false,
    actualizado_el timestamptz not null default now(),
    unique (proyecto_id, parte, repo)
  );
  ```

  La conexión a la base (con contraseña) **no** va acá: se guarda cifrada con
  `cifrado.ts`, por la misma vía que hoy `guardarConexionDeBase` /
  `conexionDeBase`.

- El proyecto de Coolify es **uno por proyecto de Punchi** (`punchi-<nombre>`),
  así el panel de Coolify queda ordenado y borrar no puede tocar otro proyecto.

### Unidades que cambian

- **`store.ts`**: `PROVEEDORES` suma `'vps'`; repos nuevos nacen con
  `destino = 'vps'`. Métodos para `vps_recursos` (listar por proyecto, guardar,
  cambiar estado, demos a apagar).
- **`publicar.ts`**: un repo con `destino = 'vps'` va por `vps.ts` después del
  merge (como hoy `enDestino`). Lo de Render queda intacto para los otros
  destinos. La conexión front↔back (`frontYBackDe`, `reescribirConfig`) se
  reutiliza con las URLs del VPS. `asegurarDockerfile` corre también para el
  front (Node 24 + nginx, el mismo Dockerfile que se usó en SincroResto y
  Justadama) porque Nixpacks trae Node 22.11 y Angular pide ≥ 22.22.
- **`despliegue.ts`** (`bloqueDeDespliegue`): toma la URL de `vps_recursos`
  además de `render_url`, para que el agente sepa el link real.
- **Agente / pliego**: en proyectos `vps` el agente **no** llama a
  `/interno/supabase/crear`. Regla nueva para el generador del back: las
  migraciones se aplican al arrancar (`Database.Migrate()` en .NET, o el
  equivalente del stack) leyendo `ConnectionStrings__DefaultConnection`.
  Mientras corre la corrida el agente prueba contra una base local del worktree
  como ya hace con SQLite/tests; la base real nace al publicar.
- **`demo-homero.ts`**: al abrir la demo guarda la fecha de la reunión para
  calcular `apagar_el`; `EstadoDeDemo.url` sale de `vps_recursos`.
- **panel-api**: rutas nuevas bajo `/proyectos/{p}/vps` (ver abajo), todas con
  `acceso_a_proyecto` como hoy las de repos.
- **front `punchi/repositorios.ts`**: recuadro "En el VPS" y uso del VPS;
  **`punchi/estructura.ts`**: línea corta de estado con link.

## Flujos

### Publicar (corrida que cierra o botón "Publicar en el VPS")

1. Freno: si `vps-uso` dice < 1 GB de memoria libre, no se crea ni se prende
   nada. Pendiente/aviso: "El VPS está lleno, apagá algo", con la lista de lo
   prendido ordenada por última actualización. Un **redeploy** de algo que ya
   está andando no pasa por el freno (no suma memoria).
2. Proyecto de Coolify `punchi-<nombre>`: se crea si no existe (el uuid se
   guarda; nunca se busca por nombre).
3. **Base** (si el proyecto tiene back y no tiene base): `crearBase` con
   usuario/base `app` y contraseña de 32 bytes al azar generada por el bridge,
   `is_public: false`. Se guarda cifrada la URL **interna** de la base.
4. **Back**: si no existe, `crearApp` desde el repo de Sincro-arg con la GitHub
   App `sincro-ar`, rama `main`, build Dockerfile, dominio
   `https://<nombre>-api.apps.punchi.dev`, healthcheck apagado (las imágenes
   .NET no traen curl). Envs: `ConnectionStrings__DefaultConnection` (interna),
   `Jwt__Key` (al azar, solo si falta), `ASPNETCORE_ENVIRONMENT=Production`,
   `Cors__AllowedOrigins__0=https://<nombre>.apps.punchi.dev`.
5. **Front**: si no existe, `crearApp` con dominio
   `https://<nombre>.apps.punchi.dev`; `reescribirConfig` apunta su config al
   back. Si el front usa `environment.ts` con `apiUrl`, se reescribe ese
   archivo (la misma clase de arreglo que `CONFIG_DEL_FRONT`).
6. `desplegar` de cada parte en orden base → back → front. Coolify encola los
   armados (`concurrent_builds = 1` en el servidor, se configura una vez).
7. Seguimiento: el bridge consulta `estadoDe` hasta `andando` o `fallo` (tope
   20 min) y actualiza `vps_recursos`. Al quedar `andando` el front, el link va
   al informe de la corrida y, si es demo, a Homero/chat.
8. Idempotente: correrlo dos veces no crea nada repetido; lo que ya tiene uuid
   solo se despliega.

### Apagar

Solo desde el panel. Para cada parte del proyecto (front → back → base):
`apagar`, estado `apagado`. Datos y config quedan. "Publicar" lo vuelve a
prender (`prender` + `desplegar` si main cambió).

### Borrar del VPS

Solo desde el panel, con confirmación escribiendo el nombre del proyecto.
`borrar` de cada parte con `delete_volumes=true`, después el proyecto de
Coolify, después las filas de `vps_recursos` y la conexión guardada. El repo
queda con `destino = 'vps'`: un "Publicar" posterior arranca de cero con base
vacía.

### Apagado automático de demos

Un intervalo del bridge (cada hora) busca demos con `apagar_el` en las próximas
24 h sin aviso → manda aviso a Gero ("Mañana apago la demo X") y marca
`avisado_apagado`. Las que pasaron `apagar_el` → Apagar. Nunca borra.

## Uso del VPS

Coolify no expone memoria libre de forma confiable por su API (Sentinel es
opcional). Se agrega en el VPS un servicio mínimo `mc-uso` (systemd, Python
stdlib) que responde `GET /uso` con `{memTotal, memDisponible, discoTotal,
discoLibre}` leyendo `/proc/meminfo` y `statvfs('/')`, escuchando **solo en la
IP de Tailscale** (`100.113.60.114:8090`), con un token propio en
`/root/mc-uso.token` y la misma regla del firewall (`mc-firewall-coolify.sh`
suma el puerto 8090). Si en la implementación Sentinel resulta usable, se usa
eso y no se crea `mc-uso`.

## Rutas

panel-api (dueño del proyecto, `acceso_a_proyecto`):

- `GET  /proyectos/{p}/vps` → partes, estado, links, `produccion`, y uso del VPS.
- `POST /proyectos/{p}/vps/publicar`
- `POST /proyectos/{p}/vps/apagar`
- `POST /proyectos/{p}/vps/borrar` con cuerpo `{ confirmacion: "<nombre>" }`.

bridge (internas, token de servicio como las demás `/interno/*`):

- `/interno/vps/estado`, `/interno/vps/publicar`, `/interno/vps/apagar`,
  `/interno/vps/borrar`.

El gateway **no** expone a los agentes ninguna ruta de VPS: la publicación de
una corrida la dispara el bridge al cerrar. Apagar y borrar no existen fuera
del panel.

## Seguridad

- Token de Coolify en `mc.env` de la Toshiba (`COOLIFY_TOKEN`,
  `COOLIFY_URL=http://100.113.60.114:8000`), cargado por Gero por SSH. Nunca en
  el chat ni en logs (`sinToken` en todos los motivos).
- El panel de Coolify sigue cerrado a internet; el bridge llega por Tailscale.
  **A verificar al implementar:** que el contenedor `mc-bridge` alcance la IP
  de Tailscale del VPS (sale por el host). Si no, se le da `network_mode` o una
  ruta.
- Toda acción sobre Coolify usa uuids de `vps_recursos` del proyecto pedido; no
  hay búsquedas por nombre. Filas `produccion = true` → apagar/borrar responden
  `es_produccion` y no llaman a Coolify.
- Base sin puerto público; solo la red interna de Coolify.
- Nombres: se normalizan a `[a-z0-9-]`, máx. 40; reservados `www`, `api`,
  `coolify`, `sincroresto`, `justadama`, `app`, `apps`; un nombre que ya tiene
  dominio en Coolify se rechaza.
- Borrar pide la confirmación también del lado del server (no solo en el
  front).

## Errores

- Coolify no responde / token inválido → pendiente "No pude hablar con el VPS
  (motivo)", el código ya está en main; "Publicar" lo reintenta.
- Armado falla → estado `fallo` con las últimas líneas útiles del log de
  Coolify (sin secretos) en `motivo`, visible en Repositorios.
- VPS lleno → no crea nada; mensaje con qué apagar.
- Certificado que no sale (ACME antes de tiempo) → no aplica con el wildcard ya
  propagado; si pasa, el estado lo muestra y el motivo lo nombra.

## Producción

Una migración de datos carga en `vps_recursos` las 4 apps existentes con
`produccion = true` (uuids en `project_vps_ovh`), atadas a sus proyectos de
Punchi si existen; si no existen, se muestran en un bloque "Otros en el VPS"
solo lectura.

## Pruebas

- `vps.test.ts` (vitest, deps falsas): crear las tres partes; segunda corrida
  solo despliega; freno de memoria; redeploy no frena; nombres reservados;
  producción no se apaga ni borra; borrar exige confirmación; demo vencida se
  apaga y no se borra.
- `coolify-api.test.ts` con `fetch` falso: rutas y cuerpos, token fuera de los
  motivos.
- Migración probada con pglite como las anteriores.
- Prueba real: un proyecto chico de punta a punta en el VPS (crear → link anda
  → apagar → publicar → borrar), y Repositorios con Playwright.

## Fuera de alcance

- Mudar las bases de SincroResto y Justadama (otra etapa, con backups en R2).
- Dominios propios para proyectos de Punchi (por ahora solo `*.apps.punchi.dev`).
- Backups automáticos de las bases de demos.
- Apagar Render/Vercel de proyectos viejos.
