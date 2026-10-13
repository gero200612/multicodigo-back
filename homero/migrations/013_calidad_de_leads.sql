-- Lo que Gero dice de cada consulta que entra (boton Sirve / No sirve en el
-- aviso de Telegram). Con esto el publicista aprende sobre consultas que
-- sirven y reuniones, no sobre formularios baratos.
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS calidad text CHECK (calidad IN ('sirve', 'no_sirve'));
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS calidad_en timestamptz;
