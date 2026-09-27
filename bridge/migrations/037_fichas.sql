-- Las fichas de las caracteristicas de una corrida.
--
-- El planificador troceaba el pliego en tareas de un archivo y nadie escribia,
-- antes de construir, que tenia que tener cada caracteristica para estar
-- terminada. En AH (2026-09-27) una tarea `lista` duraba 3,8 minutos en
-- promedio: micro-ediciones sin un "terminado" contra el cual medirse.
--
-- La ficha lo fija ANTES: datos, rutas, pantallas y sus estados, validaciones,
-- casos borde, permisos, telefono, tests. La leen las tareas y la verifican
-- los analistas item por item. Vive en la corrida, como el contrato (033).
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS fichas TEXT;
