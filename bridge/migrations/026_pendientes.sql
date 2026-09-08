-- Los cables que quedan por conectar a mano.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Nace de una pregunta que se hizo sola cuando se conecto Supabase: el bot crea
-- la base y le aplica el esquema, pero las CLAVES de esa base —la anon, la
-- service_role, la URL— las tiene que poner una persona en el env de la app. Y
-- un repo recien creado no esta conectado a Vercel ni a Render hasta que alguien
-- lo conecta.
--
-- Sin esta lista, el informe de la mañana dice "18 tareas hechas" sobre algo que
-- no arranca, y averiguar por que es media hora de mirar tres paneles. Con la
-- lista, el informe termina en "falta esto" y son cinco minutos.
--
-- Un array de texto y NO una tabla: son tres o cuatro lineas por corrida, se
-- escriben una vez y se leen una vez. Una tabla con su id y su fecha seria mas
-- maquinaria de la que ahorra.
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS pendientes TEXT[] NOT NULL DEFAULT '{}';
