-- Los agentes pensantes (spec 2026-10-07-homero-agentes-pensantes-design.md).

-- Cada corrida de un agente: que objetivo tenia, por donde paso y como termino.
-- Es lo que Gero lee para entender por que Homero hizo lo que hizo.
CREATE TABLE IF NOT EXISTS homero.corridas (
  id        BIGSERIAL PRIMARY KEY,
  agente    TEXT NOT NULL CHECK (agente IN ('buscador', 'vendedor', 'atencion')),
  objetivo  TEXT NOT NULL,
  lead_id   BIGINT REFERENCES homero.leads(id),
  estado    TEXT NOT NULL DEFAULT 'corriendo'
            CHECK (estado IN ('corriendo', 'lista', 'fallida')),
  -- La cuenta del fondo comun que la corrio.
  slot      TEXT,
  turnos    INT,
  -- [{ tipo: 'pensamiento' | 'herramienta', texto, herramienta? }]
  pasos     JSONB,
  informe   TEXT,
  error     TEXT,
  inicio    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fin       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS corridas_agente_idx ON homero.corridas (agente, id DESC);

-- Lo que cada agente aprendio. La lee al arrancar y la reescribe al terminar;
-- Gero la puede leer y corregir desde la web.
CREATE TABLE IF NOT EXISTS homero.libretas (
  agente      TEXT PRIMARY KEY CHECK (agente IN ('buscador', 'vendedor', 'atencion')),
  contenido   TEXT NOT NULL DEFAULT '',
  actualizada TIMESTAMPTZ NOT NULL DEFAULT now()
);
