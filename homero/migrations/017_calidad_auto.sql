-- Lo que habia dicho la clasificacion automatica cuando Gero la pisa (o la confirma
-- con el boton). Sirve para medir el acierto (/acierto) y para mostrarle al modelo
-- las correcciones del dueño como ejemplos. Vacio si nunca hubo una automatica.
ALTER TABLE homero.leads ADD COLUMN IF NOT EXISTS calidad_auto text CHECK (calidad_auto IN ('sirve', 'no_sirve'));
