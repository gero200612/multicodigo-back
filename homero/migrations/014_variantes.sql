-- Variantes de texto de un anuncio: misma imagen, otro titulo y texto. Cada
-- una es otro anuncio de Meta en el mismo conjunto, y Meta le da mas a la que
-- rinde. [{"titulo": "...", "texto": "..."}]
ALTER TABLE homero.anuncios ADD COLUMN IF NOT EXISTS variantes jsonb NOT NULL DEFAULT '[]'::jsonb;
