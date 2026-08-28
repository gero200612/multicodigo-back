-- Toda la superficie de RLS del sistema, junta.
--
-- Estan en un solo archivo y no repartidas por tabla a proposito: es lo que
-- decide quien ve que, y conviene poder leerlo entero de una vez.
--
-- Reemplazan a las policies anteriores, que decian `to authenticated using
-- (true)`: cualquier usuario autenticado veia y escribia todo.
--
-- El bridge NO pasa por aca: conecta como `postgres`, que tiene BYPASSRLS.

-- Un solo lugar con la pregunta que hacen todas las policies.
--
-- SECURITY DEFINER para que pueda leer `miembros` sin que la policy de
-- `miembros` se llame a si misma: sin esto, cada consulta a miembros dispara la
-- policy de miembros, que consulta miembros. Recursion infinita.
CREATE OR REPLACE FUNCTION public.es_miembro(p_proyecto UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.miembros
    WHERE proyecto_id = p_proyecto AND usuario_id = (SELECT auth.uid())
  );
$$;

-- El REVOKE FROM PUBLIC no alcanza: Supabase le da EXECUTE a `anon` y a
-- `authenticated` de forma directa (no via PUBLIC) por privilegios por
-- defecto del esquema `public`. Hay que sacarselo a `anon` a mano, si no
-- cualquiera sin sesion puede llamar a /rest/v1/rpc/es_miembro.
REVOKE EXECUTE ON FUNCTION public.es_miembro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_miembro(UUID) TO authenticated;

-- --- proyectos -------------------------------------------------------------

ALTER TABLE public.proyectos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "proyectos: leer los mios" ON public.proyectos;
CREATE POLICY "proyectos: leer los mios" ON public.proyectos
  FOR SELECT TO authenticated
  USING (public.es_miembro(id));

-- Crear un proyecto lo puede hacer cualquiera autenticado: es el unico camino
-- para tener el primero. Quedar como dueño es cosa del panel, que inserta la
-- membresia con su propia credencial.
DROP POLICY IF EXISTS "proyectos: crear" ON public.proyectos;
CREATE POLICY "proyectos: crear" ON public.proyectos
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "proyectos: editar los mios" ON public.proyectos;
CREATE POLICY "proyectos: editar los mios" ON public.proyectos
  FOR UPDATE TO authenticated
  USING (public.es_miembro(id))
  WITH CHECK (public.es_miembro(id));

-- --- miembros --------------------------------------------------------------

ALTER TABLE public.miembros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "miembros: leer los de mis proyectos" ON public.miembros;
CREATE POLICY "miembros: leer los de mis proyectos" ON public.miembros
  FOR SELECT TO authenticated
  USING (public.es_miembro(proyecto_id));

-- Sin policy de INSERT ni UPDATE a proposito: agregar gente a un proyecto pasa
-- por el panel, que valida el rol de quien invita. Si esto fuera escribible
-- desde el navegador, cualquiera se agrega a cualquier proyecto.

-- --- invitaciones ----------------------------------------------------------

ALTER TABLE public.invitaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invitaciones: leer las de mis proyectos" ON public.invitaciones;
CREATE POLICY "invitaciones: leer las de mis proyectos" ON public.invitaciones
  FOR SELECT TO authenticated
  USING (public.es_miembro(proyecto_id));

-- --- agentes ---------------------------------------------------------------

ALTER TABLE public.agentes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agentes: leer los de mis proyectos" ON public.agentes;
CREATE POLICY "agentes: leer los de mis proyectos" ON public.agentes
  FOR SELECT TO authenticated
  USING (public.es_miembro(proyecto_id));

DROP POLICY IF EXISTS "agentes: renombrar los de mis proyectos" ON public.agentes;
CREATE POLICY "agentes: renombrar los de mis proyectos" ON public.agentes
  FOR UPDATE TO authenticated
  USING (public.es_miembro(proyecto_id))
  WITH CHECK (public.es_miembro(proyecto_id));

-- Sin INSERT: crear un agente es crear un contenedor, y eso lo hace el gateway
-- a pedido del panel. Una fila suelta aca no significa nada.

-- --- jobs ------------------------------------------------------------------

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jobs: leer los de mis proyectos" ON public.jobs;
CREATE POLICY "jobs: leer los de mis proyectos" ON public.jobs
  FOR SELECT TO authenticated
  USING (proyecto_id IS NOT NULL AND public.es_miembro(proyecto_id));

-- Los jobs los escribe el bridge, que es `postgres` y no pasa por RLS.

-- --- test_runs -------------------------------------------------------------

ALTER TABLE public.test_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tests: leer autenticado" ON public.test_runs;
DROP POLICY IF EXISTS "tests: escribir autenticado" ON public.test_runs;

DROP POLICY IF EXISTS "tests: leer los de mis proyectos" ON public.test_runs;
CREATE POLICY "tests: leer los de mis proyectos" ON public.test_runs
  FOR SELECT TO authenticated
  USING (proyecto_id IS NOT NULL AND public.es_miembro(proyecto_id));

DROP POLICY IF EXISTS "tests: escribir en mis proyectos" ON public.test_runs;
CREATE POLICY "tests: escribir en mis proyectos" ON public.test_runs
  FOR INSERT TO authenticated
  WITH CHECK (proyecto_id IS NOT NULL AND public.es_miembro(proyecto_id));

-- --- las tablas internas del bridge ----------------------------------------
--
-- Siguen con RLS y SIN policies: nadie con la anon key las ve. Estan en `public`
-- porque el runner de migraciones del bridge vive ahi, y en Supabase todo lo de
-- `public` queda expuesto por PostgREST.

ALTER TABLE public.telegram_vinculos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_codigos  ENABLE ROW LEVEL SECURITY;
