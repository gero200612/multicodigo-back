-- Quien puede escribir en el proyecto puede borrar por completo un agente de él.
--
-- Hasta ahora `agentes` solo tenia SELECT (008) y UPDATE de `nombre` y
-- `sin_cuota_hasta` (041). Borrar un agente es sacarlo de la lista para que el
-- gateway lo reasigne: no borra el contenedor (eso lo decide el gateway) ni el
-- historial de `jobs`/`test_runs` de ese slot, que sigue como estaba.
--
-- `puede_escribir` y no `es_miembro`, igual que renombrar: un miembro de solo
-- lectura mira, no saca agentes. Sin esta policy el DELETE del panel no borraba
-- nada (RLS filtra en silencio) y la pantalla decia "Eso ya no existe".

DROP POLICY IF EXISTS "agentes: borrar los de mis proyectos" ON public.agentes;
CREATE POLICY "agentes: borrar los de mis proyectos" ON public.agentes
  FOR DELETE TO authenticated
  USING (public.puede_escribir(proyecto_id));

GRANT DELETE ON public.agentes TO authenticated;
