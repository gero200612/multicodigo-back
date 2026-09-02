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

  -- Donde vive en Supabase Storage. El original y el texto van al mismo bucket.
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

  constraint documentos_nombre_forma check (nombre ~ '^[A-Za-z0-9._-]+$'),
  constraint documentos_nombre_no_relativo check (nombre <> '.' and nombre <> '..'),
  constraint documentos_tipo_conocido check (tipo in ('pdf','xlsx','docx','csv','md','txt')),
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
-- PRIVADO. Los documentos de un proyecto pueden ser un pliego con precios o una
-- especificacion que no es publica, y un bucket publico los deja accesibles a
-- quien tenga la URL —que ademas es adivinable si se conoce el id del proyecto.
--
-- El panel firma URLs temporales para la descarga y para que el gateway los baje.
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
