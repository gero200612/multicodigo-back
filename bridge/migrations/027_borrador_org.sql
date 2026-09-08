-- La organizacion, recordada en el borrador.
--
-- Sin esto habia un circulo cerrado, y era culpa del diseño del comando:
--
--   1. `/corrida` a secas arranca el paso a paso y pregunta el nombre.
--   2. Con mas de una cuenta conectada, el sistema no sabe donde crear los repos
--      y pide `/corrida proyecto=X org=Y`.
--   3. Pero `/corrida proyecto=X org=Y` NO trae pliego, y "sin pliego"
--      significaba "arranca el paso a paso" — tirando las dos opciones.
--   4. El paso volvia a preguntar el nombre, y al contestarlo volvia al 2.
--
-- La persona hacia exactamente lo que el mensaje le pedia y el sistema lo
-- ignoraba. Con la org guardada, el paso a paso se acuerda de lo que ya le
-- dijeron.
ALTER TABLE public.corrida_borrador
  ADD COLUMN IF NOT EXISTS org TEXT;
