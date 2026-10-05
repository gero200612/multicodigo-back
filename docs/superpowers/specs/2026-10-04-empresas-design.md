# Empresas, rangos y proyectos públicos/privados (parte A)

Fecha: 2026-10-04. Estado: aprobado en charla; el usuario pidió implementarlo de
punta a punta sin más revisiones ("mandale a hacer todo").

## Para qué

El producto pasa a venderse a **empresas cliente de 6-7 programadores**. Entre
empresas el aislamiento es total: ninguna ve repos, agentes, consumo ni usuarios
de otra. Las empresas las crea solo el dueño de la plataforma (superadmin). El
host va a cambiar: nada de esto puede depender del disco de la Toshiba.

Fuera de alcance acá (son las partes B y C):
- B: Claudes (slots) por persona y grupos que comparten credenciales.
- C: registro de trabajo activo y anti-pisadas. Regla ya acordada para C: la
  protección la hace el sistema sobre TODA la empresa, aunque la persona no vea
  los otros proyectos, y el choque se detecta por repo + rama + archivos.

## Decisiones

| Tema | Decisión |
|---|---|
| Tipo de org | Empresas externas, aislamiento total |
| Personas por empresa | Una sola empresa por persona |
| Rangos | `admin`, `programador`, `lector` |
| Superadmin | Tabla `superadmins`; ve y administra todo; único que crea empresas |
| Alta de usuarios | Link de un solo uso (vence en 7 días); la persona elige su contraseña |
| Quién crea proyectos | Solo el admin (y el superadmin) |
| Visibilidad | `publico`: todos los de la empresa trabajan; `privado`: solo los asignados |
| Lector | Solo mira, en público y en los privados donde esté asignado |
| Nombre de la tabla | `empresas` (la columna `org` existente es la org de GitHub) |

## Modelo de datos (migración 040)

- `empresas(id, nombre, slug UNIQUE, creada_en, creada_por)`.
- `empresa_miembros(empresa_id, usuario_id UNIQUE, rango, creado_en)`.
- `superadmins(usuario_id)`: sin policies; nadie la escribe desde afuera.
- `proyectos`: `+ empresa_id NOT NULL`, `+ visibilidad` (default `privado`).
  El nombre sigue siendo **único en toda la plataforma**: el bridge resuelve
  proyectos por nombre (jobs, corridas, `idDeProyecto`) y con nombres repetidos
  entre empresas esas búsquedas podrían caer en el proyecto de otra. Se
  revisa al mudar de host.
- `miembros`: pasa a significar "asignados". Se mantiene el rol `dueño`
  (el despliegue lo usa: publicar es del dueño).
- `invitaciones`: `+ empresa_id`, `+ rango`, `+ usuario` (nombre de usuario
  pedido), `proyecto_id` pasa a opcional. Las de alta tienen `empresa_id` y no
  `proyecto_id`.

Migración de datos, idempotente: se crea la empresa `multicodigo` (nombre
"MultiCodigo", se renombra después junto con el producto); todos los usuarios
con alguna membresía entran ahí — los `dueño` como `admin`, el resto como
`programador`—; todos los proyectos quedan en esa empresa como `privado`, con
sus asignaciones de hoy. El superadmin inicial es `gero200612@gmail.com`.
Nadie gana ni pierde acceso.

## Autorización: una sola función

`acceso_a_proyecto(usuario, proyecto) → 'escribir' | 'ver' | NULL`
(SECURITY DEFINER, sin EXECUTE para `anon`/`authenticated`):

1. superadmin → `escribir`
2. sin rango en la empresa del proyecto → `NULL` (aislamiento entre empresas)
3. admin → `escribir`
4. ni público ni asignado → `NULL`
5. lector → `ver`; programador → `escribir`

Sobre ella:
- `es_miembro(p)` = acceso no nulo (las ~17 policies de lectura no cambian).
- `puede_escribir(p)` = acceso `escribir`. La migración recorre `pg_policies` y
  reescribe toda policy de INSERT/UPDATE/DELETE/ALL que use `es_miembro` para
  que use `puede_escribir` (incluye las tablas creadas a mano desde `docs/`).
- El bridge (que entra como `postgres` y no pasa por RLS) reemplaza sus
  `JOIN miembros` por `acceso_a_proyecto($usuario, p.id) = 'escribir'`:
  Telegram es una herramienta de trabajo, un lector no ve proyectos ahí.

## Funciones nuevas (RPC con el JWT del usuario)

- `mi_perfil()` → empresa, rango, superadmin.
- `crear_empresa(nombre, slug, usuario_admin)` → id + token de alta del admin.
  Solo superadmin.
- `empresas_resumen()` → lista con cantidad de personas y proyectos. Solo superadmin.
- `crear_alta(empresa, usuario, rango)` → token. Admin de esa empresa o superadmin.
- `revocar_alta(token)`, `cambiar_rango(usuario, rango)`, `quitar_de_empresa(usuario)`.
  No se puede dejar a una empresa sin admin.
- `gente_de_mi_empresa(empresa)` → usuario, email, rango (lee `auth.users`).
- `altas_pendientes(empresa)`.
- `crear_proyecto(nombre, visibilidad, empresa)`: ahora solo admin; el admin
  queda `dueño`.
- `cambiar_visibilidad(proyecto, visibilidad)`, `asignar(proyecto, usuario)`,
  `desasignar(proyecto, usuario)`: admin de la empresa del proyecto.
- `ver_alta(token)` (anon): empresa, usuario y rango de un token vigente, para
  la pantalla de alta. No revela nada de un token vencido o usado.

## El alta (crear la cuenta)

El registro libre de Supabase está apagado (`disable_signup: true`), así que la
cuenta la crea el back:

1. Admin carga usuario + rango → `crear_alta` → link `https://punchi.dev/alta/<token>`.
2. La persona abre el link (sin sesión), ve empresa/usuario/rango, elige contraseña.
3. Front → panel `POST /api/altas/{token}` (anónimo) → bridge
   `/interno/alta` (token interno del bridge).
4. El bridge, en una transacción con `FOR UPDATE` sobre la invitación: valida
   vigencia, crea el usuario de Auth, lo mete en `empresa_miembros` con el
   rango, marca la invitación usada. Crear el usuario: con la Admin API de
   Supabase si hay `SUPABASE_SERVICE_KEY`; si no, insertando en `auth.users` +
   `auth.identities` desde la conexión `postgres`.
5. El front entra con usuario y contraseña.

El usuario se escribe como en el login (`pedro` → `pedro@multicodigo.app`).
**Solo nombres de usuario, nunca un mail completo**: con un mail, el admin de
cualquier empresa podría crear la cuenta de `alguien@gmail.com` antes que esa
persona. El usuario es único en toda la plataforma (conviene `juan.acme`).
Usuario repetido → error claro "ese usuario ya existe".

## Seguridad (agregado en la revisión)

- `proyectos` por columna: el navegador lee solo `id, nombre, repo_url,
  creado_en, empresa_id, visibilidad` y no escribe por REST. `db_conexion`
  (connection string con contraseña) y `tareas` (comandos del gateway)
  quedan fuera. Una columna nueva no queda legible sola.
- Trigger `proyectos_proteger`: aunque un GRANT futuro reabra el UPDATE, por
  REST no se cambia `empresa_id` y la visibilidad solo la cambia un admin.
- `puede_decidir(aprobación)`: aprobar es escribir. El panel lo consulta antes
  de mandar la decisión al bridge.
- Si Supabase no deja reescribir alguna policy de `storage.objects`, esa queda
  como estaba (WARNING) en vez de frenar el arranque; las subidas igual pasan
  por el panel, que frena al lector.

## Panel (.NET)

- Endpoints nuevos bajo `/api/empresa/*` y `/api/plataforma/*` que llaman a las
  RPC reenviando el JWT (mismo patrón que `ProyectosClient`).
- `POST /api/altas/{token}` anónimo, con límite de tamaño de contraseña.
- Filtro en el grupo `/api`: toda request que no sea GET sobre
  `/api/proyectos/{proyectoId}/...` exige `puede_escribir`. Así un lector no
  lanza turnos, no sube archivos ni crea agentes, sin tocar cada endpoint.

## Front (Angular)

- `/alta/:token`: pantalla pública para elegir contraseña.
- `/empresa` (admin): Equipo (gente, rango, quitar; altas pendientes con link
  copiable y revocar; crear alta) y Proyectos (crear con visibilidad,
  cambiar visibilidad, asignar/desasignar en privados).
- `/plataforma` (superadmin): empresas y crear empresa (devuelve el link de
  alta del primer admin).
- Menú de la cuenta: "Empresa" para admins y "Plataforma" para el superadmin.
- Configuración: crear proyecto solo se muestra a admins.
- Proyectos: se va el bloque "Invitar" (la gente se maneja en `/empresa`).

## Pruebas

- SQL: la migración se corre entera contra PGlite (Postgres en WASM) con un
  esquema `auth` simulado, dos veces seguidas (idempotencia) y con casos de
  aislamiento: usuario de otra empresa, privado sin asignar, lector escribiendo,
  admin, superadmin.
- Bridge: tests de `alta` (vigencia, usuario repetido, transacción) con dobles.
- Panel: tests de endpoints con los dobles existentes.
- Front: build de producción.

## Parte B: Claudes por persona y grupos (migración 041)

- Un slot nuevo queda a nombre de quien lo crea (`agentes.usuario_id`). Lo
  registra el **bridge** (`/interno/claudes/registrar`), que lo llama el panel
  después de que el gateway crea el contenedor. Por REST no se inserta en
  `agentes`: si se pudiera, cualquiera se anotaría un slot ajeno con la cuenta
  de Claude de otra persona adentro.
- `puede_usar_slot(usuario, slot)`: superadmin; dueño; miembro del grupo con el
  que está compartido; o, si el slot es de antes (sin dueño ni grupo), quien
  escribe en su proyecto. Un slot sin fila: solo el superadmin.
- Grupos (`grupos`, `grupo_miembros`): los crea cualquiera de la empresa que no
  sea lector; el creador es dueño y suma gente de la **misma empresa**
  (directo, sin invitación). El dueño de un Claude lo comparte con un grupo
  suyo (`compartir_claude`). Quien sale de la empresa deja de compartir sus
  Claudes y pierde sus grupos.
- El bridge lo aplica en `ejecutarTurno` (panel, Telegram y corridas pasan por
  ahí) con el error `slot_ajeno`; el relevo saltea los Claudes ajenos.
- Front: `/punchi/claudes`.

## Parte C: trabajo en curso, para no pisarse

- Gateway `POST /trabajo` (ruta de admin, un agente no la llama): por repo,
  `git worktree list` sobre el base y `diff origin/main...HEAD` + `status` en
  cada worktree `claude/<agente>/trabajo`. No sabe de empresas.
- Bridge: antes de cada turno pide el trabajo de los repos del turno, lo filtra
  a la empresa de la persona, esconde el nombre de los proyectos que no ve, y
  lo antepone al pedido que recibe el agente (el job guarda el pedido
  original). Los nombres pasan por un filtro de caracteres de ruta y van
  marcados como datos: un nombre de archivo no puede inyectar instrucciones.
- Es un aviso, no un candado: el agente lo usa para evitar esos archivos; el
  choque real, si pasa, aparece en el merge como siempre.
- Panel `GET /api/trabajo` y front `/punchi/en-curso`: lo mismo, mirando solo
  repos de proyectos que la persona ve.
