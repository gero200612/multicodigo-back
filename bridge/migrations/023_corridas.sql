-- Una corrida: dejar el bot trabajando de noche y leer un informe a la mañana.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Lo que agrega sobre la cola de la migracion 020 es el CICLO: cuando no queda
-- nada pendiente, en vez de terminar se corre un turno de analisis que compara
-- el MD contra el repo y encola lo que falta. La cola se rellena sola hasta que
-- el analista no encuentra huecos o hasta que se toca un techo.

CREATE TABLE IF NOT EXISTS public.corridas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       BIGINT NOT NULL,
  proyecto      TEXT NOT NULL,

  -- El pliego contra el que el analista compara.
  --
  -- Se guarda ACA y no se copia en el prompt de cada tarea porque tiene que
  -- sobrevivir a las rondas: el analista de la ronda 3 necesita el MISMO texto
  -- contra el que se comparo en la 1. Copiarlo en cada prompt lo iria
  -- degradando en cada copia.
  md            TEXT NOT NULL,

  ronda         INTEGER NOT NULL DEFAULT 1,
  techo_rondas  INTEGER NOT NULL,
  -- La hora local a la que se corta, como 'HH:MM'. Texto y no TIMESTAMPTZ: lo
  -- que se dicta es "hasta las 7", no una fecha, y una corrida que arranca a
  -- las 23 tiene que cortar a las 7 del dia SIGUIENTE. Resolver eso contra el
  -- reloj en cada vuelta es mas simple que guardar una fecha que hay que
  -- calcular al abrir.
  techo_hora    TEXT NOT NULL,

  -- Cuantas tareas fallaron SEGUIDAS. Se resetea con cada tarea que sale bien.
  -- Sin esto, "seguir con la siguiente" es una forma elegante de quemar la
  -- noche entera contra el mismo error.
  fallos_seguidos INTEGER NOT NULL DEFAULT 0,

  -- La ultima ronda en la que el analista LLAMO a `reportar_huecos`.
  --
  -- Existe para distinguir dos cosas que si no se ven iguales: un analista que
  -- reviso y no encontro nada (llamo con la lista vacia) y uno que escribio los
  -- huecos en prosa y nunca llamo la herramienta. El primero cierra la corrida
  -- como completa; el segundo es un turno fallido, porque cerrar ahi diciendo
  -- "completo" es justo la falla silenciosa que este ciclo no puede tener.
  huecos_de_ronda INTEGER,

  estado        TEXT NOT NULL DEFAULT 'abierta',
  -- Por que termino. Es el campo que se lee PRIMERO a la mañana: la diferencia
  -- entre "esta listo" y "se corto y no lo sabias". Nulo mientras esta abierta.
  motivo_de_cierre TEXT,

  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en    TIMESTAMPTZ,

  CONSTRAINT corridas_estado_valido CHECK (estado IN ('abierta', 'cerrada')),
  CONSTRAINT corridas_md_no_vacio CHECK (length(btrim(md)) > 0),
  CONSTRAINT corridas_techo_rondas_sano CHECK (techo_rondas BETWEEN 1 AND 20),
  CONSTRAINT corridas_techo_hora_forma CHECK (techo_hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Los seis del informe. Espeja MOTIVOS_DE_CIERRE en src/corrida.ts.
  CONSTRAINT corridas_motivo_valido CHECK (
    motivo_de_cierre IS NULL OR motivo_de_cierre IN (
      'completo', 'techo_rondas', 'techo_hora',
      'cuentas_agotadas', 'demasiados_fallos', 'cancelada'
    )
  ),
  -- Una corrida cerrada SIEMPRE dice por que. Sin esto un cierre por un camino
  -- que nadie penso deja una fila sin motivo, y el informe —que se arma con
  -- este campo— no tendria nada que decir en su primera linea.
  CONSTRAINT corridas_cierre_completo CHECK (
    (estado = 'abierta' AND motivo_de_cierre IS NULL AND cerrado_en IS NULL)
    OR (estado = 'cerrada' AND motivo_de_cierre IS NOT NULL AND cerrado_en IS NOT NULL)
  )
);

-- UNA corrida abierta por chat, garantizado por la base y no por un if.
--
-- Dos corridas sobre el mismo chat competirian por los mismos slots y ninguna
-- de las dos terminaria. El chequeo tambien esta en el comando —para poder
-- explicarlo— pero la carrera entre dos `/corrida` mandados juntos solo la
-- gana un indice.
CREATE UNIQUE INDEX IF NOT EXISTS corridas_una_abierta_por_chat
  ON public.corridas (chat_id) WHERE estado = 'abierta';

-- Las tareas de la cola pasan a saber de que corrida y de que ronda son.
--
-- NULLABLE a proposito: una cola dictada a mano —lo que funciona hoy— sigue
-- igual y no queda atada a ninguna corrida. Es lo que hace que este cambio no
-- toque el comportamiento existente.
ALTER TABLE public.cola_tareas
  ADD COLUMN IF NOT EXISTS corrida_id UUID REFERENCES public.corridas(id) ON DELETE SET NULL;
-- `ronda` existe para el informe. A la mañana querés poder ver "esto lo detecto
-- el analista en la ronda 2", que es la diferencia entre confiar en el
-- resultado y no.
ALTER TABLE public.cola_tareas
  ADD COLUMN IF NOT EXISTS ronda INTEGER;

CREATE INDEX IF NOT EXISTS cola_por_corrida_idx
  ON public.cola_tareas (corrida_id, posicion) WHERE corrida_id IS NOT NULL;

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.corridas ENABLE ROW LEVEL SECURITY;

-- El CHECK de `telegram_modo` NO se toca, y eso es deliberado.
--
-- El modo `desatendido` existe en `policy.ts` del agente, pero no se GUARDA:
-- vive solo mientras hay una corrida abierta y el bridge lo manda en cada
-- turno. Agregarlo a este CHECK habilitaria `/permisos desatendido`, o sea un
-- modo que queda prendido despues de que la corrida termino — que es
-- exactamente la forma en que esto se vuelve un accidente en tres semanas.
