-- La instalacion de la GitHub App de cada proyecto.
--
-- Parte del plan 3. Reemplaza a la deploy key del host: en vez de pegar una
-- clave por repo a mano en GitHub, el usuario instala la App una vez, elige los
-- repos con checkboxes, y el panel firma un token por turno.
--
-- No hay migraciones versionadas contra Supabase en este repo —repos,
-- slot_nombres y test_runs tambien se crearon a mano— asi que esto queda como
-- el registro de lo que hay que correr.

-- --- quien es dueño --------------------------------------------------------
--
-- `es_miembro` no alcanza para esta tabla y esa es la unica razon por la que
-- esta funcion existe.
--
-- Vincular un repo no otorga nada: lo autoriza la membresia que el usuario ya
-- tiene. Vincular una INSTALACION si: es la credencial con la que los agentes
-- del proyecto van a poder pushear a repos reales de GitHub. Un miembro que
-- apunta el proyecto a su propia instalacion le daria a todos los agentes
-- acceso de escritura a sus repos — o peor, un miembro puede reemplazar la
-- instalacion del dueño por la suya y quedarse con los push del equipo.
--
-- SECURITY DEFINER y `search_path = ''` por lo mismo que `es_miembro`: leer
-- `miembros` sin disparar la policy de `miembros`, que consultaria `miembros`.
CREATE OR REPLACE FUNCTION public.es_dueno(p_proyecto UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.miembros
    WHERE proyecto_id = p_proyecto
      AND usuario_id = (SELECT auth.uid())
      AND rol = 'dueño'
  );
$$;

-- El REVOKE FROM PUBLIC no alcanza: Supabase le da EXECUTE a `anon` y a
-- `authenticated` de forma directa por los privilegios por defecto del esquema
-- `public`. Sin sacarselo a `anon` a mano, cualquiera sin sesion puede llamar a
-- /rest/v1/rpc/es_dueno.
REVOKE EXECUTE ON FUNCTION public.es_dueno(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_dueno(UUID) TO authenticated;

-- --- la tabla --------------------------------------------------------------

create table if not exists public.github_instalaciones (
  -- La PK es el proyecto y no un id propio: una instalacion por proyecto, y el
  -- UPSERT de "cambiar la instalacion" sale gratis. Reinstalar en GitHub emite
  -- un installation_id nuevo, asi que la fila tiene que poder pisarse.
  proyecto_id     uuid primary key references public.proyectos(id) on delete cascade,

  -- Lo que identifica a la instalacion ante la API de GitHub. Con esto y la
  -- clave privada de la App, el panel firma un token de una hora acotado a los
  -- repos que el usuario marco.
  --
  -- NO es un secreto: no sirve de nada sin la clave privada, que vive solo en
  -- las variables del panel y del bridge. Por eso esta tabla se puede leer.
  installation_id bigint not null,

  -- El owner en GitHub, solo para mostrarlo en el panel: "instalada en
  -- gero200612". Sin esto la pantalla puede decir que hay una instalacion pero
  -- no cual.
  cuenta          text not null,

  vinculado_en    timestamptz not null default now(),

  constraint github_instalaciones_id_positivo check (installation_id > 0)
);

alter table public.github_instalaciones enable row level security;

-- Leer: cualquier miembro. Es lo que le permite al panel mostrar "este proyecto
-- ya tiene la App instalada" sin darle a nadie la posibilidad de cambiarla.
drop policy if exists "instalaciones: leer las de mis proyectos" on public.github_instalaciones;
create policy "instalaciones: leer las de mis proyectos"
  on public.github_instalaciones for select to authenticated
  using (public.es_miembro(proyecto_id));

-- Escribir: SOLO el dueño, y es la diferencia con `repos`. Ver el comentario de
-- `es_dueno` arriba: esta fila decide con que credencial pushean los agentes del
-- proyecto.
drop policy if exists "instalaciones: vincular en mis proyectos" on public.github_instalaciones;
create policy "instalaciones: vincular en mis proyectos"
  on public.github_instalaciones for insert to authenticated
  with check (public.es_dueno(proyecto_id));

drop policy if exists "instalaciones: cambiar las de mis proyectos" on public.github_instalaciones;
create policy "instalaciones: cambiar las de mis proyectos"
  on public.github_instalaciones for update to authenticated
  using (public.es_dueno(proyecto_id))
  with check (public.es_dueno(proyecto_id));

drop policy if exists "instalaciones: desvincular las de mis proyectos" on public.github_instalaciones;
create policy "instalaciones: desvincular las de mis proyectos"
  on public.github_instalaciones for delete to authenticated
  using (public.es_dueno(proyecto_id));
