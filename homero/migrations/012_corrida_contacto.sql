-- De que charla de WhatsApp es cada corrida, para mostrar en la pantalla
-- Charlas lo que decidio Homero al lado de cada mensaje. Idempotente.
ALTER TABLE homero.corridas ADD COLUMN IF NOT EXISTS contacto TEXT;
CREATE INDEX IF NOT EXISTS corridas_contacto_idx ON homero.corridas (contacto, id DESC) WHERE contacto IS NOT NULL;
