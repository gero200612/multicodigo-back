-- Quien califico la consulta y por que: Homero la clasifica solo (auto) y el
-- boton de Gero la pisa siempre (dueño). Las de antes quedan sin origen y se
-- cuentan como del dueño. El motivo es corto y sin datos de personas.
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS calidad_origen text;
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS calidad_motivo text;
