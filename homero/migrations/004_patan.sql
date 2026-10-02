-- Patán: el presupuesto de una demo. Vive en Homero (misma base, misma cola,
-- misma cuenta de Claude) pero en la web es su propia seccion, /patan.
-- Uno por demo: rehacerlo pisa el anterior.
CREATE TABLE IF NOT EXISTS homero.presupuestos (
  id            BIGSERIAL PRIMARY KEY,
  demo_id       BIGINT NOT NULL UNIQUE REFERENCES homero.demos(id),
  lead_id       BIGINT NOT NULL REFERENCES homero.leads(id),
  -- Lo que Gero anoto de la reunion.
  notas         TEXT NOT NULL DEFAULT '',
  estado        TEXT NOT NULL DEFAULT 'armando'
                CHECK (estado IN ('armando', 'listo', 'fallido')),
  -- Lo que va en el PDF: alcance, precio, abono, horas de soporte, condiciones.
  contenido     JSONB,
  -- Solo para Gero: de donde sale el precio (ahorro estimado). Nunca va al PDF.
  justificacion JSONB,
  error         TEXT,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
