-- El estado `cortada`: la tarea no fallo, no entro en el turno.
--
-- Hasta ahora un turno que se pasaba de los 18 minutos cerraba la tarea como
-- `fallida`, y eso mezclaba dos cosas que se resuelven distinto: trabajo que
-- salio mal y trabajo que no entro en una sola sentada. El informe de la mañana
-- las contaba juntas, y el cierre por techo de rondas bajaba la persiana con
-- continuaciones a medio hacer en la cola.
--
-- La corrida `padel` del 2026-09-18 es el caso: cuatro cortes por tiempo, cero
-- fallos reales, y el mismo DashboardController construido tres veces.
ALTER TABLE public.cola_tareas
  DROP CONSTRAINT IF EXISTS cola_estado_valido;

ALTER TABLE public.cola_tareas
  ADD CONSTRAINT cola_estado_valido
  -- Con los estados de la 036 adentro: las migraciones corren TODAS en cada
  -- arranque y en orden, asi que esta vuelve a correr despues de que la 036 ya
  -- dejo filas en 'bloqueada'. Con la lista vieja el ALTER fallaba y el bridge
  -- quedaba en crash-loop (2026-09-28).
  CHECK (estado IN (
    'pendiente', 'corriendo', 'lista', 'fallida', 'cortada', 'cancelada',
    'sin_cambios', 'bloqueada'
  ));
