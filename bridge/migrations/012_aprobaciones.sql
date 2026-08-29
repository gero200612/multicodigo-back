-- La aprobacion pasa a saber de que proyecto es y quien la decidio.
--
-- `proyecto_id` esta duplicado respecto de jobs a proposito: la policy de RLS
-- lo consulta en cada fila, y llegar al proyecto por el join con jobs haria que
-- cada lectura de aprobaciones arrastre esa tabla.

ALTER TABLE public.approvals ADD COLUMN IF NOT EXISTS proyecto_id UUID
  REFERENCES public.proyectos(id) ON DELETE CASCADE;
ALTER TABLE public.approvals ADD COLUMN IF NOT EXISTS decidido_por UUID;
ALTER TABLE public.approvals ADD COLUMN IF NOT EXISTS decidido_desde TEXT;

ALTER TABLE public.approvals DROP CONSTRAINT IF EXISTS approvals_desde_valido;
ALTER TABLE public.approvals ADD CONSTRAINT approvals_desde_valido
  CHECK (decidido_desde IS NULL OR decidido_desde IN ('telegram', 'panel'));

-- La consulta del panel es "las pendientes de mis proyectos": decision NULL.
CREATE INDEX IF NOT EXISTS approvals_pendientes_idx
  ON public.approvals (proyecto_id, created_at DESC)
  WHERE decision IS NULL;

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "aprobaciones: leer las de mis proyectos" ON public.approvals;
CREATE POLICY "aprobaciones: leer las de mis proyectos" ON public.approvals
  FOR SELECT TO authenticated
  USING (proyecto_id IS NOT NULL AND public.es_miembro(proyecto_id));

-- Sin policy de UPDATE: decidir pasa por el bridge, que ademas de escribir
-- tiene que avisarle al gateway y editar el mensaje de Telegram. Una fila
-- cambiada por el navegador dejaria al agente esperando para siempre.
