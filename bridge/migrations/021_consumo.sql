-- Lo que consumio cada turno.
--
-- Anthropic NO publica cuanta cuota queda, asi que "que porcentaje va" no se
-- puede contestar: no hay un total contra el cual dividir. Lo que si se puede
-- es medir lo GASTADO, que es lo que el SDK devuelve en cada `result`.
--
-- La ventana es de 5 horas, la misma que usa Anthropic para su limite (ver
-- HORAS_DE_AGOTAMIENTO en store.ts). Sumar sobre esa ventana es lo que hace
-- que el numero signifique algo: "1.2M tokens en las ultimas 5h" se puede
-- comparar contra el momento en que el slot se agoto la vez pasada.

ALTER TABLE public.jobs
  -- Entrada + salida juntos, que es como los cuenta la cuota. Separarlos seria
  -- guardar un detalle que nadie mira para responder esta pregunta.
  ADD COLUMN IF NOT EXISTS tokens INTEGER,
  -- Lo que costo, en dolares. NUMERIC y no float: son centavos que se suman, y
  -- un float acumula error justo cuando la suma se hace larga.
  ADD COLUMN IF NOT EXISTS costo_usd NUMERIC(10, 6);

-- El indice que sirve a la unica consulta que los usa: "cuanto gasto este
-- agente en las ultimas 5 horas". Sin el, sumar pide recorrer la tabla entera
-- de jobs cada vez que alguien abre el panel.
CREATE INDEX IF NOT EXISTS jobs_consumo_idx
  ON public.jobs (agent, created_at)
  WHERE tokens IS NOT NULL;
