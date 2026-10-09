-- Plantillas de anuncio y revisor (los anuncios llegan a Gero ya chequeados).
-- Idempotente como las anteriores: corre entera en cada arranque.

-- La plantilla de la imagen y sus textos. Los anuncios de antes no tienen:
-- al arrancar, los propuestos sin plantilla se descartan (ver anuncios.ts).
ALTER TABLE homero.anuncios ADD COLUMN IF NOT EXISTS plantilla TEXT;
ALTER TABLE homero.anuncios ADD COLUMN IF NOT EXISTS contenido JSONB;
-- [{ ronda, aprobado, puntajes: { gancho, claridad, ... }, correcciones, en }]
ALTER TABLE homero.anuncios ADD COLUMN IF NOT EXISTS revision JSONB NOT NULL DEFAULT '[]'::jsonb;

-- `revisando`: armado, esperando al revisor. Gero todavia no lo vio.
ALTER TABLE homero.anuncios DROP CONSTRAINT IF EXISTS anuncios_estado_check;
ALTER TABLE homero.anuncios ADD CONSTRAINT anuncios_estado_check
  CHECK (estado IN ('revisando', 'propuesto', 'aprobado', 'activo', 'pausado', 'descartado'));

-- El revisor entra en la lista de agentes de corridas y libretas en 008, que
-- corre antes que esta en cada arranque.
