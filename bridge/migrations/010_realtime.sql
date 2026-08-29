-- jobs emite sus cambios por Realtime.
--
-- Sin esto el front se suscribe, no recibe un error, y no llega nada nunca: la
-- suscripcion a una tabla que no esta en la publicacion es silenciosa. Es el
-- modo de falla mas caro de diagnosticar de esta funcionalidad.
--
-- Realtime respeta RLS, asi que cada quien recibe solo los jobs de sus
-- proyectos: la policy del plan 1 hace de filtro tambien aca.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
  END IF;
EXCEPTION
  -- La publicacion `supabase_realtime` es de `supabase_admin`, no del usuario
  -- con el que se conecta el bridge. Si no alcanza el permiso, esto se avisa y
  -- se sigue: el bridge entero no puede quedarse abajo —y con el, el bot de
  -- Telegram— porque falte una funcionalidad del panel. Se habilita a mano en
  -- Database -> Replication del dashboard de Supabase.
  WHEN insufficient_privilege THEN
    RAISE WARNING 'no se pudo agregar jobs a supabase_realtime (falta permiso): habilitala a mano en Database -> Replication, o el panel en vivo no va a recibir nada';
  WHEN undefined_object THEN
    RAISE WARNING 'no existe la publicacion supabase_realtime: si esta base no es Supabase, el panel en vivo no aplica';
END
$$;

-- Realtime necesita la fila completa en el UPDATE para poder filtrarla por RLS.
-- Con el default (REPLICA IDENTITY DEFAULT) solo viaja la clave primaria, y la
-- policy no tiene con que decidir: el evento se descarta en silencio.
ALTER TABLE public.jobs REPLICA IDENTITY FULL;
