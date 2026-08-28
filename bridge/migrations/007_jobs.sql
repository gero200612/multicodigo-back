-- jobs pasa a saber de quien es cada turno, de donde vino, y que se contesto.
--
-- `respuesta` es la que faltaba para todo lo demas: hasta ahora se guardaba lo
-- que pedis y no lo que el agente contesto, asi que no habia historial que
-- mostrar ni en el panel ni en ningun lado.
--
-- Las tres columnas son NULLABLE a proposito. Las filas que ya existen no
-- tienen proyecto ni usuario, y ponerles un default seria inventar que alguien
-- las pidio. El codigo que las lee trata el NULL como "de antes".

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS proyecto_id UUID
  REFERENCES public.proyectos(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS usuario_id UUID;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS origen TEXT;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS respuesta TEXT;

-- El CHECK admite NULL para no invalidar las filas viejas, y cierra el conjunto
-- para las nuevas: un turno viene del bot o del panel, no hay tercera puerta.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_origen_valido;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_origen_valido
  CHECK (origen IS NULL OR origen IN ('telegram', 'panel'));

-- La consulta del panel es "los turnos de mis proyectos, del mas nuevo al mas
-- viejo". Sin este indice es un scan por tabla en cada refresco.
CREATE INDEX IF NOT EXISTS jobs_proyecto_created_idx
  ON public.jobs (proyecto_id, created_at DESC);

-- test_runs se creo a mano por fuera de las migraciones (con el SQL editor de
-- Supabase), asi que en una base limpia no existe y el ALTER de abajo falla:
-- con el, no arranca el bridge. Esto la repone con el esquema que ya tiene en
-- produccion, y con IF NOT EXISTS no toca la que existe.
CREATE TABLE IF NOT EXISTS public.test_runs (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slot    TEXT        NOT NULL,
  ok      BOOLEAN     NOT NULL,
  cuando  TIMESTAMPTZ NOT NULL DEFAULT now(),
  detalle TEXT,

  CONSTRAINT test_runs_slot_forma CHECK (slot ~ '^c[1-9][0-9]?$')
);

CREATE INDEX IF NOT EXISTS test_runs_slot_cuando_idx
  ON public.test_runs (slot, cuando DESC);

-- test_runs tambien pasa a ser por proyecto: un test corrido en el proyecto A
-- no dice nada del B, aunque sea el mismo slot.
ALTER TABLE public.test_runs ADD COLUMN IF NOT EXISTS proyecto_id UUID
  REFERENCES public.proyectos(id) ON DELETE CASCADE;
