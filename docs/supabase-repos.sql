-- Los repos de cada proyecto.
--
-- Aplicado el 2026-09-01 (migracion `repos_por_proyecto`). No hay migraciones
-- versionadas contra Supabase en este repo —slot_nombres y test_runs tambien se
-- crearon a mano—, asi que esto queda como el registro de lo que hay que correr.
--
-- Reemplaza a `config/projects.json` del repo `multicodigo-vm`, que sobrevive
-- solo para `demo`: el proyecto de prueba que no vive en la base y que usan el
-- smoke test y el modo local.

create table if not exists public.repos (
  id           uuid primary key default gen_random_uuid(),
  proyecto_id  uuid not null references public.proyectos(id) on delete cascade,

  -- El nombre de la carpeta en el worktree del agente y el del espejo en
  -- /srv/repos. Los mismos limites que valida `NombreDeRepo` en el codigo, y
  -- duplicados a proposito: este valor arma una ruta en disco, asi que la barra
  -- y el punto-punto no pueden entrar por ningun camino, tampoco por el SQL
  -- editor o un script.
  nombre       text not null,

  -- "owner/name" de GitHub. De aca sale la URL con la que el gateway clona el
  -- espejo la primera vez que alguien le pide un turno sobre este repo. Se
  -- guarda la forma corta y no una URL entera porque una URL admite
  -- `ssh://...@host/-oProxyCommand=...`, que git interpreta como opciones.
  github_repo  text not null,

  -- Las tareas que el agente puede correr, con la forma de projects.json:
  -- { "test": ["pnpm","vitest","run"] }. Vacio es valido: un repo sin tareas se
  -- puede editar y commitear, solo no se le puede pedir `run`.
  tareas       jsonb not null default '{}'::jsonb,

  creado_en    timestamptz not null default now(),

  constraint repos_nombre_forma check (nombre ~ '^[A-Za-z0-9._-]+$'),
  constraint repos_nombre_no_relativo check (nombre <> '.' and nombre <> '..'),
  constraint repos_github_forma check (github_repo ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'),
  constraint repos_unico_por_proyecto unique (proyecto_id, nombre)
);

create index if not exists repos_proyecto_idx on public.repos (proyecto_id);

alter table public.repos enable row level security;

-- Por membresia, igual que el resto. `es_miembro` viene de la migracion 008 del
-- bridge: un repo de un proyecto ajeno sencillamente no aparece, y eso convierte
-- "¿puede ver esto?" en una pregunta que no hace falta programar.
drop policy if exists "repos: leer los de mis proyectos" on public.repos;
create policy "repos: leer los de mis proyectos"
  on public.repos for select to authenticated
  using (public.es_miembro(proyecto_id));

drop policy if exists "repos: vincular en mis proyectos" on public.repos;
create policy "repos: vincular en mis proyectos"
  on public.repos for insert to authenticated
  with check (public.es_miembro(proyecto_id));

drop policy if exists "repos: editar los de mis proyectos" on public.repos;
create policy "repos: editar los de mis proyectos"
  on public.repos for update to authenticated
  using (public.es_miembro(proyecto_id))
  with check (public.es_miembro(proyecto_id));

drop policy if exists "repos: desvincular los de mis proyectos" on public.repos;
create policy "repos: desvincular los de mis proyectos"
  on public.repos for delete to authenticated
  using (public.es_miembro(proyecto_id));
