-- Los documentos vinculados a un proyecto.
--
-- Parte de los documentos vinculados. Ver el diseño en
-- `multicodigo-vm/docs/superpowers/specs/2026-09-01-documentos-vinculados-design.md`.
--
-- Un agente sabe leer codigo y nada mas. El material con el que se trabaja de
-- verdad —un pliego en PDF, una lista de precios en Excel— vive afuera del
-- sistema, y la unica forma de que el agente lo viera era pegarlo en el chat:
-- un PDF de treinta paginas no entra en un mensaje, y el texto pegado se pierde
-- con la sesion.
--
-- No hay migraciones versionadas contra Supabase en este repo, asi que esto
-- queda como el registro de lo que hay que correr. Idempotente.

create table if not exists public.documentos (
  id           uuid primary key default gen_random_uuid(),
  proyecto_id  uuid not null references public.proyectos(id) on delete cascade,

  -- El nombre del archivo en el worktree del agente. Mismas restricciones que
  -- `repos.nombre` y por la misma razon: arma una ruta en disco, asi que la
  -- barra y el punto-punto no pueden entrar por ningun camino.
  nombre       text not null,

  -- Lo que el usuario subio, con espacios y acentos si los tenia. Para mostrarlo
  -- en la pantalla y para que la descarga conserve el nombre que la persona
  -- reconoce.
  nombre_original text not null,

  -- Donde vive en el disco del servidor, relativo a DOCS_ROOT (/srv/docs). El
  -- panel y el bridge escriben ahi, y el gateway monta el mismo directorio para
  -- copiarlo al worktree del agente.
  --
  -- Antes era la ruta en Supabase Storage. Los tres procesos corren en la misma
  -- maquina, asi que mandar el archivo a internet para bajarlo tres lineas
  -- despues era todo costo: una URL firmada por documento y por turno, y la
  -- service_role cargada solo para eso.
  ruta         text not null,
  -- Null mientras no se convirtio o si la conversion fallo.
  ruta_texto   text,

  tipo         text not null,
  bytes        bigint not null,

  -- El mensaje de por que no se pudo convertir, para mostrarlo al lado del
  -- documento. Un documento sin convertir NO bloquea el turno: el agente ve el
  -- original y no lo puede leer, que es peor que tenerlo convertido pero mejor
  -- que un turno que falla.
  error        text,

  -- Quien lo subio.
  --
  -- El default NO es cosmetico: el panel escribe esta tabla por PostgREST con
  -- el JWT del usuario y NO manda esta columna, asi que sin el default cada
  -- subida moria con
  --
  --     23502 null value in column "subido_por" ... violates not-null constraint
  --
  -- y el panel contestaba "No pudimos subir el documento". La tabla estuvo en
  -- cero filas hasta que se encontro.
  --
  -- `auth.uid()` sale de los claims del JWT que PostgREST setea en cada
  -- request, asi que es exactamente el mismo usuario que evalua RLS: no pueden
  -- discrepar. Quien escribe con la service_role —el bridge, para los archivos
  -- que llegan por Telegram— no tiene JWT y ahi `auth.uid()` es null, por eso
  -- ese camino la manda explicita. Si algun dia se la olvidara, este not null
  -- lo dice fuerte en vez de anotar un documento sin dueño.
  subido_por   uuid not null references auth.users(id) default auth.uid(),
  creado_en    timestamptz not null default now(),

  -- El `$` del final NO es decorativo, y la base estuvo sin el.
  --
  -- Sin ancla, `^[A-Za-z0-9._-]+` acepta cualquier cosa DESPUES de un prefijo
  -- valido: `pliego.pdf/../../etc/passwd` pasaba el check. Esta columna arma
  -- una ruta en `_docs`, asi que era el agujero que las otras tres capas de
  -- validacion vienen a cerrar — y la ultima en la que uno confiaria.
  --
  -- Corregido en produccion el 2026-09-03 con un DROP + ADD del constraint,
  -- despues de verificar que ninguna fila existente lo violaba.
  constraint documentos_nombre_forma check (nombre ~ '^[A-Za-z0-9._-]+$'),
  constraint documentos_nombre_no_relativo check (nombre <> '.' and nombre <> '..'),
  -- Los tipos que el sistema acepta. Las imagenes entraron cuando se vio que el
  -- agente las VE con `Read` —vision nativa del SDK— y no hacen falta convertir.
  --
  -- Tiene que moverse junto con `TIPOS`/`TIPOS_IMAGEN` del bridge y
  -- `Documentos.Tipos`/`TiposImagen` del panel. Si esta lista queda corta, el
  -- archivo pasa las tres validaciones de la aplicacion y muere en el insert
  -- con un 23514 que no dice cual fue el tipo rechazado.
  constraint documentos_tipo_conocido check (
    tipo in ('pdf','xlsx','docx','csv','md','txt','png','jpg','jpeg','webp','gif')
  ),
  constraint documentos_unico unique (proyecto_id, nombre)
);

create index if not exists documentos_proyecto_idx on public.documentos (proyecto_id);

-- Para las bases que ya tenian la tabla sin el default. Idempotente, como todo
-- este archivo: en una base nueva el create de arriba ya lo trae.
alter table public.documentos
  alter column subido_por set default auth.uid();

alter table public.documentos enable row level security;

-- Por membresia, igual que `repos` y NO como `github_instalaciones`: subir un
-- documento no otorga nada —lo autoriza la membresia que ya tenes— mientras que
-- vincular una instalacion decide con que credencial pushean todos los agentes
-- del proyecto. Por eso aquella es solo del dueño y esta no.
drop policy if exists "documentos: leer los de mis proyectos" on public.documentos;
create policy "documentos: leer los de mis proyectos"
  on public.documentos for select to authenticated
  using (public.es_miembro(proyecto_id));

drop policy if exists "documentos: subir en mis proyectos" on public.documentos;
create policy "documentos: subir en mis proyectos"
  on public.documentos for insert to authenticated
  with check (public.es_miembro(proyecto_id));

drop policy if exists "documentos: editar los de mis proyectos" on public.documentos;
create policy "documentos: editar los de mis proyectos"
  on public.documentos for update to authenticated
  using (public.es_miembro(proyecto_id))
  with check (public.es_miembro(proyecto_id));

drop policy if exists "documentos: borrar los de mis proyectos" on public.documentos;
create policy "documentos: borrar los de mis proyectos"
  on public.documentos for delete to authenticated
  using (public.es_miembro(proyecto_id));

-- --- el bucket ---------------------------------------------------------------
--
-- YA NO SE USA. Los archivos viven en el disco del servidor (/srv/docs), que
-- los tres procesos montan: el panel y el bridge escriben, el gateway lee.
--
-- Se deja creado y con sus policies, y no se borra, por una razon concreta: el
-- bucket todavia tiene los documentos subidos antes del cambio. Un `drop`
-- alegre los perderia, y las filas viejas que apuntan ahi son justamente las
-- que hay que poder mirar para migrarlas o descartarlas a mano.
--
-- PRIVADO, como estaba: un bucket publico deja los documentos accesibles a
-- quien tenga la URL —que ademas es adivinable si se conoce el id del
-- proyecto—. Mientras las policies de abajo sigan pidiendo membresia, lo que
-- quedo ahi adentro sigue tan protegido como antes.
insert into storage.buckets (id, name, public)
values ('documentos', 'documentos', false)
on conflict (id) do nothing;

-- Las policies del bucket repiten la pregunta de la tabla, y no alcanza con las
-- de arriba: Storage es otro esquema y no las mira. La ruta es
-- `<proyecto_id>/<archivo>`, asi que el primer segmento es lo que se compara.
drop policy if exists "documentos: leer los de mis proyectos" on storage.objects;
create policy "documentos: leer los de mis proyectos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documentos'
    and public.es_miembro(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "documentos: subir en mis proyectos" on storage.objects;
create policy "documentos: subir en mis proyectos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documentos'
    and public.es_miembro(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "documentos: borrar los de mis proyectos" on storage.objects;
create policy "documentos: borrar los de mis proyectos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'documentos'
    and public.es_miembro(((storage.foldername(name))[1])::uuid)
  );

-- --- el instructivo del proyecto ---------------------------------------------
--
-- Parte de las instrucciones de proyecto. Ver el diseño en
-- `multicodigo-vm/docs/superpowers/specs/2026-09-03-instrucciones-de-proyecto-design.md`.
--
-- El .md que rige TODOS los turnos de un proyecto: su texto se le agrega al
-- system prompt de cada turno, con precedencia declarada sobre las reglas de
-- estilo fijas del agente. Es lo que hace que un proyecto pueda exigir una
-- serie de pasos —redactar una sentencia, por ejemplo— en vez de que el
-- instructivo sea un documento que el modelo abre si se acuerda.
--
-- Es una columna sobre esta tabla y no una tabla nueva porque un instructivo
-- es, en todo lo demas, un documento del proyecto: se sube, se guarda, se
-- descarga, se borra, se copia al worktree, y lo protege esta misma RLS. Lo
-- unico que lo distingue es a donde va su texto.
alter table public.documentos
  add column if not exists es_instruccion boolean not null default false;

-- A LO SUMO UNO por proyecto, y la regla vive ACA y no en el panel.
--
-- Si hubiera dos, cual manda lo decidiria un `order by` y nadie podria saberlo
-- mirando la pantalla. El bridge ademas desempata por nombre (ver
-- `separarInstructivo`), pero eso es una red por si esta base quedo sin migrar:
-- la garantia es este indice.
--
-- Parcial: sin el `where`, un unique sobre (proyecto_id) prohibiria tener mas
-- de un documento comun por proyecto.
create unique index if not exists documentos_instruccion_unica
  on public.documentos (proyecto_id) where es_instruccion;

-- De donde salio cada documento.
--
-- Desde que el agente puede ESCRIBIR documentos, la lista de un proyecto mezcla
-- cuatro procedencias: lo que se arrastro al panel, lo que se mando al bot, lo
-- que se trajo de Drive y lo que redacto el agente. Sin esta columna los cuatro
-- se ven identicos, y la pregunta que la persona hace primero —"esto lo escribi
-- yo o lo escribio el bot?"— no tiene respuesta en ningun lado.
--
-- `default 'panel'` y no NULL para las filas que ya estan: cuando esta columna
-- no existia, todo lo que habia venia del panel. Un default deja el dato
-- verdadero en vez de un hueco que la pantalla tendria que interpretar.
--
-- Un CHECK y no un enum de Postgres: agregar un valor a un enum es una
-- migracion con lock sobre el tipo, y esta lista va a crecer (una integracion
-- mas, un origen mas). El CHECK se reemplaza sin tocar la tabla.
alter table public.documentos
  add column if not exists origen text not null default 'panel';

do $$
begin
  alter table public.documentos
    add constraint documentos_origen_valido
    check (origen in ('panel', 'telegram', 'drive', 'agente'));
exception
  when duplicate_object then null;
end $$;
