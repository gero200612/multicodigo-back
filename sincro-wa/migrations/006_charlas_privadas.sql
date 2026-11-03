-- Las charlas de un cliente son del cliente: con charlas_privadas el panel de Gero (/admin/charlas, /admin/media) no las muestra.
ALTER TABLE negocios ADD COLUMN charlas_privadas boolean NOT NULL DEFAULT false;
UPDATE negocios SET charlas_privadas = true WHERE app ILIKE '%efaysto%' OR nombre ILIKE '%efaysto%';
