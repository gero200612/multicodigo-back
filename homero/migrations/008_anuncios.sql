-- Anuncios en Meta con formulario y tope de gasto
-- (spec 2026-10-08-homero-anuncios-meta-design.md).

-- Cada anuncio que propone el publicista. Nada se crea en Meta hasta que Gero
-- lo aprueba: `propuesto` es solo una fila aca.
CREATE TABLE IF NOT EXISTS homero.anuncios (
  id           BIGSERIAL PRIMARY KEY,
  -- { imagen, formulario, conjunto, creativo, anuncio }: se va llenando al
  -- publicar, asi un corte a mitad retoma sin crear nada dos veces.
  meta_ids     JSONB NOT NULL DEFAULT '{}'::jsonb,
  rubro        TEXT NOT NULL,
  titulo       TEXT NOT NULL,
  texto        TEXT NOT NULL,
  frase        TEXT NOT NULL,
  imagen       BYTEA NOT NULL,
  -- Las preguntas propias del formulario (las estandar van siempre).
  preguntas    JSONB NOT NULL DEFAULT '[]'::jsonb,
  por_que      TEXT NOT NULL DEFAULT '',
  estado       TEXT NOT NULL DEFAULT 'propuesto'
               CHECK (estado IN ('propuesto', 'aprobado', 'activo', 'pausado', 'descartado')),
  -- Presupuesto diario en pesos (Meta lo pide en centavos: lo convierte meta.ts).
  diario       NUMERIC(12, 2) NOT NULL,
  motivo       TEXT,
  telegram_msg BIGINT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  aprobado_en  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS anuncios_estado_idx ON homero.anuncios (estado);
CREATE INDEX IF NOT EXISTS anuncios_telegram_idx ON homero.anuncios (telegram_msg);

-- Lo que gasto cada anuncio cada dia, de los insights de Meta (una lectura por
-- hora pisa el dia entero). En pesos.
CREATE TABLE IF NOT EXISTS homero.gastos (
  dia         DATE NOT NULL,
  anuncio_id  BIGINT NOT NULL REFERENCES homero.anuncios(id),
  gasto       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  impresiones INT NOT NULL DEFAULT 0,
  consultas   INT NOT NULL DEFAULT 0,
  leido       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dia, anuncio_id)
);

-- Los leads de los formularios: el mismo no entra dos veces.
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS leadgen_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS leads_leadgen_idx ON homero.leads (leadgen_id);
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS anuncio_id BIGINT REFERENCES homero.anuncios(id);

-- `caliente`: lleno el formulario, pidio que lo contacten.
ALTER TABLE homero.leads DROP CONSTRAINT IF EXISTS leads_estado_check;
ALTER TABLE homero.leads ADD CONSTRAINT leads_estado_check
  CHECK (estado IN ('nuevo', 'descartado', 'borrador', 'aprobado', 'contactado',
                    'respondio', 'reunion', 'cerrado', 'baja', 'rebotado', 'caliente'));

-- El publicista es un agente mas: sus corridas y su libreta.
ALTER TABLE homero.corridas DROP CONSTRAINT IF EXISTS corridas_agente_check;
ALTER TABLE homero.corridas ADD CONSTRAINT corridas_agente_check
  CHECK (agente IN ('buscador', 'vendedor', 'atencion', 'publicista'));
ALTER TABLE homero.libretas DROP CONSTRAINT IF EXISTS libretas_agente_check;
ALTER TABLE homero.libretas ADD CONSTRAINT libretas_agente_check
  CHECK (agente IN ('buscador', 'vendedor', 'atencion', 'publicista'));
