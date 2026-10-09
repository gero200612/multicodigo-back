-- Borrar un agente ahora lo borra entero: su contenedor, su cuenta de Claude
-- cargada y su HOME. Hasta la 045 lo podia borrar cualquiera que escribiera en
-- el proyecto, porque solo lo sacaba de la lista. Ahora tambien le desconecta
-- la cuenta de Claude a su dueño, asi que lo decide el dueño del Claude:
--
--   - quien escribe en el proyecto, Y
--   - el Claude es suyo (`usuario_id`) o es uno de antes, sin dueño.
--   - El superadmin, siempre.
--
-- El panel lo pregunta ANTES de tocar nada (contenedor, cuenta): no se
-- destruye un Claude para despues enterarse de que no se podia.

CREATE OR REPLACE FUNCTION public.puede_borrar_agente(p_proyecto UUID, p_slot TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  a public.agentes;
BEGIN
  IF v_usuario IS NULL THEN
    RETURN 'no_existe';
  END IF;
  SELECT * INTO a FROM public.agentes WHERE slot = p_slot AND proyecto_id = p_proyecto;
  IF a.slot IS NULL THEN
    RETURN 'no_existe';
  END IF;
  IF public._es_superadmin(v_usuario) THEN
    RETURN 'ok';
  END IF;
  -- Quien no escribe en el proyecto no ve el agente: para el es como si no estuviera.
  IF COALESCE(public.acceso_a_proyecto(v_usuario, p_proyecto), '') <> 'escribir' THEN
    RETURN 'no_existe';
  END IF;
  IF a.usuario_id IS NULL OR a.usuario_id = v_usuario THEN
    RETURN 'ok';
  END IF;
  RETURN 'no_es_tuyo';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.puede_borrar_agente(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_borrar_agente(UUID, TEXT) TO authenticated;

DROP POLICY IF EXISTS "agentes: borrar los de mis proyectos" ON public.agentes;
DROP POLICY IF EXISTS "agentes: borrar solo el dueño del claude" ON public.agentes;
CREATE POLICY "agentes: borrar solo el dueño del claude" ON public.agentes
  FOR DELETE TO authenticated
  USING (public.puede_borrar_agente(proyecto_id, slot) = 'ok');
