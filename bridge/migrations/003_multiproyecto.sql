-- El proyecto activo del chat, igual que active_agent.
--
-- Nullable a proposito: una fila que ya existia de antes no tiene proyecto
-- elegido, y ahi el bridge usa su DEFAULT_PROJECT. Poner un default en la
-- columna seria inventar que el usuario eligio algo.
ALTER TABLE chat_state ADD COLUMN IF NOT EXISTS active_project TEXT;
