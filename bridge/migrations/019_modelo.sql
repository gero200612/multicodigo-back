-- Con que modelo de Claude corre cada chat.
--
-- Del CHAT, igual que el modo de permisos y por la misma razon: es una decision
-- de quien pide el trabajo. Uno puede querer Opus para lo dificil y otro Haiku
-- para preguntas rapidas, sobre el mismo proyecto.
--
-- NULL / sin fila = el default del CLI de Claude, que es lo que corria antes de
-- que esto existiera. No se guarda un default aca a proposito: el dia que el
-- CLI cambie el suyo, una fila con el valor viejo lo estaria pisando sin que
-- nadie lo haya pedido.

CREATE TABLE IF NOT EXISTS public.telegram_modelo (
  chat_id      BIGINT PRIMARY KEY,
  -- La CLAVE (`opus`, `sonnet`, `haiku`), no el id del modelo. El id vive en
  -- src/agent/src/modelos.ts, que es quien habla con el SDK: guardarlo aca
  -- dejaria filas apuntando a modelos retirados y nadie sabria traducirlas.
  modelo       TEXT NOT NULL,
  cambiado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Espeja las claves de MODELOS. Los dos tienen que moverse juntos: una clave
  -- que la base acepta y el agente no conoce cae en el default en silencio.
  CONSTRAINT telegram_modelo_valido CHECK (modelo IN ('opus', 'sonnet', 'haiku'))
);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.telegram_modelo ENABLE ROW LEVEL SECURITY;
