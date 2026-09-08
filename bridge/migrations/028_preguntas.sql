-- Las preguntas del planificador, antes de armar la cola.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Un pliego ambiguo produce un plan sobre supuestos: el modelo elige uno, arma
-- doce tareas, y a la mañana el trabajo esta hecho contra una interpretacion que
-- nadie confirmo. Preguntar tres cosas antes cuesta un mensaje y cambia todo lo
-- que sigue.
--
-- Y preguntar DESPUES de leer el pliego y no antes: recien ahi se sabe que es lo
-- ambiguo. Preguntar antes es adivinar que preguntar.
--
-- ## La tension que resuelve el timeout
--
-- Cada pregunta es un momento en que la corrida espera. Si alguien manda el
-- pliego y se va a dormir, tres preguntas sin contestar serian la noche entera
-- perdida — al revés del punto de la feature. Por eso `preguntado_en`: pasado el
-- tope, el plan se arma igual, con los supuestos DECLARADOS en el informe.
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS preguntas TEXT[] NOT NULL DEFAULT '{}';

-- Lo que contesto la persona, en crudo. Un solo texto y no una fila por
-- respuesta: se contesta en un mensaje de chat ("la primera si, la segunda
-- generico"), y partirlo en pedazos seria inventar una estructura que el mensaje
-- no tiene.
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS respuestas TEXT;

-- Cuando se preguntaron. Es lo que hace que el tope se pueda medir despues de un
-- reinicio: si viviera en memoria, un deploy dejaria la corrida esperando para
-- siempre.
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS preguntado_en TIMESTAMPTZ;
