-- La cola de trabajo: todo lo que hay que hacer, en orden.
--
-- Nace de que dictar cinco tareas al bot obligaba a esperar cada una para
-- mandar la siguiente. Ahora se mandan juntas —una por linea— y el bot las va
-- haciendo solo, avisando al terminar cada una.
--
-- En la BASE y no en memoria del proceso, por la misma razon que el mensaje
-- pendiente: el bridge se reinicia en cada deploy, y una cola perdida ahi se ve
-- igual que un bot que se comio lo que le pediste. Con la cola en Postgres, un
-- reinicio a mitad de camino retoma donde quedo.

CREATE TABLE IF NOT EXISTS public.cola_tareas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     BIGINT NOT NULL,
  -- A quien se le encarga. Se fija al ENCOLAR y no al ejecutar: si cambias de
  -- agente a mitad de la cola, lo que ya estaba anotado sigue yendo a quien se
  -- lo pediste.
  agente      TEXT NOT NULL,
  proyecto    TEXT NOT NULL,
  texto       TEXT NOT NULL,
  -- El orden en que se dictaron. Con `creado_en` solo, dos tareas del mismo
  -- mensaje comparten timestamp y el orden queda librado a como salgan.
  posicion    INTEGER NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'pendiente',
  -- Lo que contesto el agente, o el error. Para poder mostrar como fue.
  resultado   TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  empezado_en TIMESTAMPTZ,
  cerrado_en  TIMESTAMPTZ,

  CONSTRAINT cola_estado_valido
    CHECK (estado IN ('pendiente', 'corriendo', 'lista', 'fallida', 'cancelada')),
  CONSTRAINT cola_texto_no_vacio CHECK (length(btrim(texto)) > 0),
  CONSTRAINT cola_agente_forma CHECK (agente ~ '^c[1-9][0-9]?$')
);

-- El indice que importa: "dame la proxima pendiente de este chat, en orden".
CREATE INDEX IF NOT EXISTS cola_proxima_idx
  ON public.cola_tareas (chat_id, estado, posicion);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.cola_tareas ENABLE ROW LEVEL SECURITY;
