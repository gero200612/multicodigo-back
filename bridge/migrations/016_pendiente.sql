-- El mensaje que quedo esperando porque el agente estaba ocupado.
--
-- Cuando alguien le escribe a un slot que esta usando otra persona, el bot le
-- ofrece los otros agentes con botones. Tocar uno tiene que MANDAR ahi lo que
-- ya habia escrito: obligarlo a reescribir el mismo texto es cambiar un "no"
-- por una molestia.
--
-- En la base y no en memoria del proceso por la misma razon que awaiting_feedback:
-- el bridge se reinicia en cada deploy, y un mensaje perdido en ese momento se
-- ve exactamente igual que un bot que se comio lo que le escribiste.

CREATE TABLE IF NOT EXISTS public.telegram_pendiente (
  -- Uno por chat. El segundo mensaje pisa al primero: si escribiste dos veces
  -- mientras el slot estaba tomado, lo que quisiste mandar es lo ultimo.
  chat_id   BIGINT PRIMARY KEY,
  prompt    TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT telegram_pendiente_prompt_no_vacio CHECK (length(btrim(prompt)) > 0)
);

-- Sin policies: la escribe el bridge, que es `postgres`. Al panel no le sirve
-- de nada un mensaje a medio mandar de un chat de Telegram.
ALTER TABLE public.telegram_pendiente ENABLE ROW LEVEL SECURITY;
