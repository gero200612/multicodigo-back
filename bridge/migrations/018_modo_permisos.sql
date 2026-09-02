-- Cuanto se le pregunta a cada persona antes de actuar.
--
-- Es del CHAT y no del proyecto ni del agente: es una preferencia de comodidad
-- de quien lee las preguntas. Dos personas sobre el mismo proyecto pueden
-- querer distinto —una revisando cada edicion, la otra dejando avanzar— y
-- ninguna de las dos tiene por que imponerle la suya a la otra.
--
-- Lo que el modo NO cambia es lo que esta prohibido: un .env, una ruta fuera
-- del worktree, escribir dentro de .git. Eso lo decide `classify()` en el
-- agente y ningun modo lo mueve. Y git tampoco: commit y push preguntan
-- siempre, en los tres modos.

CREATE TABLE IF NOT EXISTS public.telegram_modo (
  chat_id      BIGINT PRIMARY KEY,
  modo         TEXT NOT NULL,
  cambiado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Espeja MODOS de src/agent/src/policy.ts. Los dos tienen que moverse
  -- juntos: un modo que la base acepta y el agente no entiende termina en el
  -- default silenciosamente, y nadie sabria por que sigue preguntando.
  CONSTRAINT telegram_modo_valido CHECK (modo IN ('preguntar', 'ediciones', 'todo'))
);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.telegram_modo ENABLE ROW LEVEL SECURITY;
