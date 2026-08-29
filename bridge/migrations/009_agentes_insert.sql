-- Un miembro del proyecto puede anotar un agente en el.
--
-- La 008 cerro el INSERT de `agentes` con este argumento: "crear un agente es
-- crear un contenedor, y eso lo hace el gateway a pedido del panel. Una fila
-- suelta aca no significa nada". El argumento sigue siendo cierto y esta
-- politica no lo contradice: la fila se inserta DESPUES de que el gateway
-- contesto que creo el contenedor, y el panel es quien la escribe.
--
-- Sin esto, el endpoint que crea agentes (plan 4) no tiene forma de anotar el
-- resultado: el panel no tiene credencial propia contra la base —reenvia el JWT
-- del usuario y decide RLS— y la service_role no vive en ningun lado del
-- sistema, a proposito.
--
-- Lo que sigue defendido es lo que importaba: solo un MIEMBRO del proyecto
-- puede anotar un agente en ese proyecto. Una fila hacia un proyecto ajeno
-- sigue siendo imposible.

DROP POLICY IF EXISTS "agentes: crear en mis proyectos" ON public.agentes;
CREATE POLICY "agentes: crear en mis proyectos" ON public.agentes
  FOR INSERT TO authenticated
  WITH CHECK (public.es_miembro(proyecto_id));
