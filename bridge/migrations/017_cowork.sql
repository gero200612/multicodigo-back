-- Los agentes de mas con los que trabaja un chat.
--
-- El agente PRIMARIO sigue viviendo donde vivia (`chat_state`): es a quien le
-- habla el texto suelto, sin prefijo, y no cambia de lugar para no mover algo
-- que ya funciona. Esta tabla guarda los OTROS, a los que se les habla con
-- `/c2 hace esto`.
--
-- Sirve para saber a quien mostrar en /status y en el menu como "activo". El
-- turno en si no la necesita: `/c2 …` ya funcionaba sin esto. Lo que no habia
-- era forma de ver, de un vistazo, con cuantos estas trabajando.

CREATE TABLE IF NOT EXISTS public.telegram_cowork (
  chat_id   BIGINT NOT NULL,
  slot      TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (chat_id, slot),
  -- Espeja AgentId del contrato compartido, igual que `agentes`. Los dos tienen
  -- que moverse juntos.
  CONSTRAINT telegram_cowork_slot_forma CHECK (slot ~ '^c[1-9][0-9]?$')
);

CREATE INDEX IF NOT EXISTS telegram_cowork_chat_idx ON public.telegram_cowork (chat_id);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.telegram_cowork ENABLE ROW LEVEL SECURITY;
