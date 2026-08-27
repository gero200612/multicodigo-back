-- Los nombres que el usuario le pone a cada slot.
--
-- Aplicar en el SQL editor de Supabase. No hay migraciones versionadas contra
-- Supabase en este repo (test_runs tambien se creo a mano), asi que esto queda
-- como el registro de lo que hay que correr.
--
-- El panel NO tiene credencial de escritura propia: reenvia el JWT del usuario
-- y deja que RLS decida, igual que con test_runs. Por eso la tabla tiene RLS
-- habilitada y politicas explicitas; sin ellas, PostgREST rechaza todo y los
-- nombres se veran siempre como c1..c6.

create table if not exists public.slot_nombres (
  slot           text primary key,
  nombre         text not null,
  actualizado_en timestamptz not null default now(),

  -- Los mismos limites que valida el endpoint. Duplicados a proposito: el
  -- endpoint da un mensaje legible, y esto impide que una fila mal formada
  -- entre por otro camino (el SQL editor, un script).
  constraint slot_nombres_slot_forma check (slot ~ '^c[1-9][0-9]?$'),
  constraint slot_nombres_nombre_no_vacio check (length(btrim(nombre)) > 0),
  constraint slot_nombres_nombre_largo check (length(nombre) <= 60)
);

alter table public.slot_nombres enable row level security;

-- Cualquier usuario autenticado puede leer y escribir los nombres.
--
-- OJO: esto asume que el panel es de un solo equipo, que es como esta armado
-- hoy (PANEL_PROJECT=demo, seis slots fijos declarados en compose.dev.yml). Si
-- alguna vez hay mas de un equipo sobre el mismo Supabase, esta tabla necesita
-- una columna de dueño y estas politicas hay que rehacerlas: tal como estan,
-- cualquier usuario logueado renombra los slots de todos.
create policy "nombres: leer autenticado"
  on public.slot_nombres for select
  to authenticated
  using (true);

create policy "nombres: escribir autenticado"
  on public.slot_nombres for insert
  to authenticated
  with check (true);

create policy "nombres: actualizar autenticado"
  on public.slot_nombres for update
  to authenticated
  using (true)
  with check (true);

-- El endpoint hace upsert (Prefer: resolution=merge-duplicates) porque
-- renombrar es lo normal, no la excepcion. Sin esto el segundo rename del
-- mismo slot daria 409.
create or replace function public.slot_nombres_touch()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

drop trigger if exists slot_nombres_touch on public.slot_nombres;
create trigger slot_nombres_touch
  before update on public.slot_nombres
  for each row execute function public.slot_nombres_touch();
