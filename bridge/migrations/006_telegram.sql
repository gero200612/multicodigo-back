-- Quien es quien entre Telegram y el panel.
--
-- Reemplaza a TELEGRAM_ALLOWED_USER_IDS, que era una lista fija en una variable
-- de entorno: con usuarios de verdad, quien puede hablarle al bot sale de aca.

CREATE TABLE IF NOT EXISTS public.telegram_vinculos (
  -- El chat es la clave y no el usuario: un chat habla por UNA persona. Al
  -- reves seria admitir que dos chats sean la misma persona, que es cierto
  -- (celular y escritorio comparten chat_id, pero un grupo no) y no hace falta
  -- todavia.
  chat_id      BIGINT PRIMARY KEY,
  usuario_id   UUID NOT NULL,
  vinculado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_vinculos_usuario_idx
  ON public.telegram_vinculos (usuario_id);

CREATE TABLE IF NOT EXISTS public.telegram_codigos (
  codigo    TEXT PRIMARY KEY,
  chat_id   BIGINT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en TIMESTAMPTZ NOT NULL,
  -- NULL = sin usar. La transicion a no-NULL es la que se hace de forma
  -- atomica, y es la que impide que un codigo filtrado sirva dos veces.
  usado_en  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telegram_codigos_chat_idx
  ON public.telegram_codigos (chat_id);
