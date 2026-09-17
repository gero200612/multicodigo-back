-- La URL publica del servicio, para poder darla despues.
--
-- Hasta ahora la URL existia solo en el momento del deploy: se armaba el
-- servicio, se nombraba en el informe de cierre y se perdia. Si ese informe se
-- corto, o si el deploy fallo y se reintento mas tarde, no habia forma de
-- contestar "cual era el link" sin entrar al dashboard de Render.
--
-- Va al lado de `render_service_id` —que ya se guarda por idempotencia— porque
-- es el mismo hecho contado para afuera: el id sirve para no crear dos
-- servicios, y la URL para poder mandarla por chat.
ALTER TABLE public.repos
  ADD COLUMN IF NOT EXISTS render_url TEXT;
