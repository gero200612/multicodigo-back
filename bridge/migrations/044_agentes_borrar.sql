-- Un miembro del proyecto puede borrar por completo un agente de ese proyecto.
--
-- Hasta ahora `agentes` solo tenia SELECT (008) y UPDATE de `nombre` y
-- `sin_cuota_hasta` (041). Borrar un agente es sacarlo de la lista para que el
-- gateway lo reasigne: no borra el contenedor (eso lo decide el gateway) ni el
-- historial de `jobs`/`test_runs` de ese slot, que sigue como estaba.
--
-- Esta migracion NO se aplica sola: queda escrita para que la persona la
-- revise y la corra ella misma contra la base.

DROP POLICY IF EXISTS "agentes: borrar los de mis proyectos" ON public.agentes;
CREATE POLICY "agentes: borrar los de mis proyectos" ON public.agentes
  FOR DELETE TO authenticated
  USING (public.es_miembro(proyecto_id));

GRANT DELETE ON public.agentes TO authenticated;
