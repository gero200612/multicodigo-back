-- De qué bot es cada cuenta de Claude.
--
-- Un slot es una cuenta de Claude con su HOME en /srv/homes/<slot>. Hasta acá
-- todas eran de Punchi; desde el panel se puede decir "esta es de Homero" (o
-- de Patán, que corre adentro de Homero). Punchi deja de usar las que no son
-- suyas —en el relevo, en la cola y elegidas a mano—, porque dos procesos con
-- la misma credencial se pisan el refresh token.
ALTER TABLE public.agentes
  ADD COLUMN IF NOT EXISTS bot TEXT NOT NULL DEFAULT 'punchi';

DO $bot$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agentes_bot_valido') THEN
    ALTER TABLE public.agentes
      ADD CONSTRAINT agentes_bot_valido CHECK (bot IN ('punchi', 'homero', 'patan'));
  END IF;
END
$bot$;
