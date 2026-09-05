-- Drive en vivo: la cuenta de Google del usuario, y los pedidos de acceso.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-04-drive-en-vivo-design.md`.
--
-- Es lo UNICO del sistema que le da al servidor acceso a una cuenta personal, y
-- por eso la tabla es chica y explicita: un refresh token de Google no vence,
-- asi que la fila es la credencial. Lo que la acota es el scope con el que se
-- pidio —`drive.file`, solo los archivos elegidos o creados por la app— y que
-- se puede borrar desde Configuracion y desde la cuenta de Google.

-- --- google_cuentas --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.google_cuentas (
  -- Una cuenta de Google por usuario del panel. La PK es el usuario y no un id
  -- propio: conectar dos veces tiene que PISAR la fila, no dejar dos tokens
  -- vivos para la misma persona. Con un id serial, revocar el acceso desde
  -- Google dejaria la fila vieja adentro y el proximo turno la usaria.
  usuario_id    UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Con que cuenta se conecto. Es lo unico que se muestra en Configuracion, y
  -- existe para que la persona pueda ver que autorizo la cuenta que queria: el
  -- error de conectar la personal en vez de la del trabajo no tiene sintoma sin
  -- esto.
  email         TEXT NOT NULL,
  -- La credencial permanente. NUNCA sale por la API del panel: la lee solo el
  -- bridge, que se conecta como `postgres`. Ver la policy de abajo.
  refresh_token TEXT NOT NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.google_cuentas ENABLE ROW LEVEL SECURITY;

-- Leer la PROPIA fila, y nada mas.
--
-- La policy da SELECT sobre la fila entera porque RLS es por fila y no por
-- columna: lo que impide que el refresh token salga por PostgREST es el GRANT
-- de abajo, que no incluye esa columna. Los dos hacen falta —sin la policy
-- cualquiera lee la fila de otro, sin el grant el dueño lee su propio token
-- desde el navegador— y ninguno reemplaza al otro.
DROP POLICY IF EXISTS "google: leer la propia" ON public.google_cuentas;
CREATE POLICY "google: leer la propia" ON public.google_cuentas
  FOR SELECT TO authenticated
  USING (usuario_id = auth.uid());

-- Desconectar la cuenta es un DELETE del dueño: es la accion de Configuracion,
-- y tiene que funcionar con el JWT del usuario como todo lo demas del panel.
DROP POLICY IF EXISTS "google: desconectar la propia" ON public.google_cuentas;
CREATE POLICY "google: desconectar la propia" ON public.google_cuentas
  FOR DELETE TO authenticated
  USING (usuario_id = auth.uid());

-- No hay policy de INSERT ni de UPDATE a proposito: la fila la escribe quien
-- canjea el codigo de OAuth, que es el unico que tiene el refresh token en la
-- mano. Un INSERT desde el navegador solo podria escribir un token inventado.

-- El refresh token no se le entrega al rol del navegador.
--
-- Es la mitad que RLS no puede dar: una policy decide QUE FILAS se ven, no que
-- columnas. Sin este grant acotado, el dueño de la fila se baja su propia
-- credencial permanente con la anon key desde la consola del browser — y de ahi
-- a un log, a una captura o a una extension hay un paso.
REVOKE ALL ON public.google_cuentas FROM authenticated, anon;
GRANT SELECT (usuario_id, email, creado_en) ON public.google_cuentas TO authenticated;
GRANT DELETE ON public.google_cuentas TO authenticated;

-- --- google_pedidos --------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.google_pedidos (
  -- El codigo que viaja en el link. Es la credencial entera, asi que se genera
  -- con randomBytes y no con un contador.
  codigo      TEXT PRIMARY KEY,
  usuario_id  UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Que archivo se esta pidiendo. Va al Picker como `setQuery`, asi que la
  -- persona lo encuentra a un toque en vez de buscarlo entre todo su Drive.
  nombre      TEXT NOT NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en   TIMESTAMPTZ NOT NULL,
  -- NULL = sin usar. Igual que `telegram_codigos`: la transicion a no-NULL se
  -- hace de forma atomica y es lo que impide que un link filtrado —queda en el
  -- historial de un chat— autorice un segundo archivo.
  usado_en    TIMESTAMPTZ,
  -- Que archivo termino eligiendo, cuando lo eligio.
  --
  -- NO es un catalogo del Drive de nadie —de los archivos no se guarda nada,
  -- se buscan en vivo— sino el resultado de ESTE pedido, que es una fila que
  -- ya existe igual.
  --
  -- Existe por una razon medida: el indice de busqueda de Drive es
  -- eventualmente consistente. En el spike, `files.list` devolvio 0 para un
  -- archivo recien autorizado y dos minutos despues devolvio 1. Sin esta
  -- columna, el agente busca por nombre en el turno siguiente —que llega
  -- segundos despues de que la persona autorizo— y contesta "no lo encuentro"
  -- justo despues de que hizo lo que le pidieron.
  archivo_id  TEXT
);

CREATE INDEX IF NOT EXISTS google_pedidos_usuario_idx
  ON public.google_pedidos (usuario_id);

-- Sin policies, como las demas tablas internas del bridge: el link se canjea
-- por un endpoint, no leyendo la tabla con la anon key. Ver el final de
-- `008_rls.sql`.
ALTER TABLE public.google_pedidos ENABLE ROW LEVEL SECURITY;
