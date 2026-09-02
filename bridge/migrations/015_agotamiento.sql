-- Que slot se quedo sin tokens, y hasta cuando.
--
-- Hasta ahora esto no se guardaba en ningun lado: el limite se descubria a
-- mitad del turno, se usaba para relevar, y se olvidaba. El sintoma era el
-- menu, que mostraba a c2 con su punto verde y su boton andando mientras la
-- cuenta estaba en cero — la persona lo elegia, esperaba, y recien ahi se
-- enteraba.
--
-- Es una tabla y no una columna de `agentes` a proposito. `agentes` dice de
-- quien es el slot y como se llama: cosas que las personas escriben y que
-- sobreviven a todo. Esto es un estado observado, que caduca solo y que se
-- borra sin que nadie lo extrañe. Mezclarlos haria que limpiar lo segundo
-- pusiera en riesgo lo primero.

CREATE TABLE IF NOT EXISTS public.slots_agotados (
  -- Espeja AgentId del contrato compartido, igual que `agentes.slot`.
  slot     TEXT PRIMARY KEY,

  -- Lo que decia el cartel de Anthropic, crudo: "1:30am (UTC)".
  --
  -- Texto y no timestamptz: el cartel dice la hora y NO el dia, asi que armar
  -- una fecha obliga a adivinar si es hoy o mañana. Adivinar mal muestra
  -- "vuelve ayer", que es peor que mostrar la hora tal como llego. Puede ser
  -- NULL: hay redacciones del aviso que no traen la hora.
  resets   TEXT,

  -- Cuando lo vimos. Es lo que hace que la marca caduque sola.
  --
  -- Hace falta porque `resets` no alcanza para saber si ya paso: sin dia, no
  -- se puede comparar contra ahora. Con esto la regla es "la marca vale unas
  -- horas", que no necesita interpretar el texto del cartel.
  visto_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT slots_agotados_slot_forma CHECK (slot ~ '^c[1-9][0-9]?$'),
  CONSTRAINT slots_agotados_resets_largo CHECK (resets IS NULL OR length(resets) <= 40)
);
