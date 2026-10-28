-- Instagram y Messenger usan la misma tabla de numeros: una cuenta es un "numero" con su canal.
-- phone_number_id guarda el id de la cuenta (ig_user_id o page_id) y waba_id el id de la pagina.
ALTER TABLE numeros ADD COLUMN canal text NOT NULL DEFAULT 'whatsapp' CHECK (canal IN ('whatsapp', 'instagram', 'messenger'));

-- Los comentarios publicos que le llegan a la empresa (Instagram y pagina de Facebook).
CREATE TABLE comentarios (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  numero_id integer NOT NULL REFERENCES numeros (id),
  comentario_id text NOT NULL,
  publicacion_id text,
  autor_id text,
  autor_nombre text,
  texto text,
  padre_id text,
  fecha timestamptz NOT NULL,
  respondido boolean NOT NULL DEFAULT false,
  respuesta_privada boolean NOT NULL DEFAULT false,
  oculto boolean NOT NULL DEFAULT false,
  UNIQUE (numero_id, comentario_id)
);
CREATE INDEX comentarios_negocio ON comentarios (negocio_id, fecha DESC);
