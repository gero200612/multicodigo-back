-- La sesion pasa a ser del proyecto y el agente, no del chat.
--
-- Es lo que hace que el panel y Telegram compartan hilo: los dos preguntan por
-- (proyecto, agente) y les toca la misma conversacion de Claude.
--
-- ROMPE las sesiones en curso: la clave primaria cambia y no hay forma de
-- deducir a que proyecto pertenecia una fila vieja —chat_state guardaba el
-- NOMBRE del proyecto, no su id— asi que se descartan. Las conversaciones
-- abiertas arrancan de cero, que en un sistema sin estrenar no cuesta nada.

DROP TABLE IF EXISTS public.agent_session;

CREATE TABLE public.agent_session (
  proyecto_id UUID NOT NULL REFERENCES public.proyectos(id) ON DELETE CASCADE,
  agente      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (proyecto_id, agente),
  CONSTRAINT agent_session_agente_forma CHECK (agente ~ '^c[1-9][0-9]?$')
);

-- Sin policies: la escribe el bridge, que es `postgres`. Al panel no le sirve
-- de nada un session_id de Claude.
ALTER TABLE public.agent_session ENABLE ROW LEVEL SECURITY;
