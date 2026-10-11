-- sincro-wa: el esquema inicial. Postgres propio del bot, esquema public.

CREATE TABLE negocios (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  app text NOT NULL,
  capacidades text[] NOT NULL DEFAULT '{}',
  tope_mensual_ars numeric(16, 2) NOT NULL CHECK (tope_mensual_ars > 0),
  url_base text,
  activo boolean NOT NULL DEFAULT true,
  -- sha256 hex de la clave: la clave en si no se guarda.
  clave_hash text,
  clave_ultimo_uso timestamptz,
  -- Cifrado con SINCRO_WA_CIFRADO (AES-256-GCM).
  secreto_eventos text NOT NULL,
  contexto_atender text NOT NULL DEFAULT '',
  creado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE numeros (
  id serial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  phone_number_id text NOT NULL UNIQUE,
  waba_id text NOT NULL,
  -- Null: usa META_TOKEN (el numero de Sincro). Si no, cifrado.
  token_cifrado text,
  calidad text,
  -- Contactos distintos con plantilla por 24 h. Null: sin tope o sin dato.
  tope_meta integer,
  estado text,
  nombre_verificado text,
  sin_mensajes_alertado boolean NOT NULL DEFAULT false,
  creado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX numeros_waba ON numeros (waba_id);

-- Una fila por contacto y numero: la ventana, la baja y la derivacion son de
-- esa charla, no del contacto en general.
CREATE TABLE contactos (
  numero_id integer NOT NULL REFERENCES numeros (id),
  contacto text NOT NULL,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  nombre text,
  ultima_entrada timestamptz,
  baja boolean NOT NULL DEFAULT false,
  baja_desde timestamptz,
  derivada boolean NOT NULL DEFAULT false,
  PRIMARY KEY (numero_id, contacto)
);
CREATE INDEX contactos_negocio ON contactos (negocio_id, contacto);
CREATE INDEX contactos_baja ON contactos (negocio_id) WHERE baja;

-- Los archivos que llegan. Se borran a los 30 dias.
CREATE TABLE media (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  mime text NOT NULL,
  datos bytea NOT NULL,
  creado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_creado ON media (creado);

CREATE TABLE mensajes (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  numero_id integer NOT NULL REFERENCES numeros (id),
  contacto text NOT NULL,
  direccion text NOT NULL CHECK (direccion IN ('entra', 'sale')),
  tipo text NOT NULL,
  texto text,
  media_id bigint REFERENCES media (id) ON DELETE SET NULL,
  referral jsonb,
  plantilla text,
  -- Unico: Meta repite webhooks y el repetido se descarta aca.
  wamid text UNIQUE,
  categoria text CHECK (categoria IN ('marketing', 'utility', 'authentication', 'service')),
  costo_estimado numeric(16, 4) NOT NULL DEFAULT 0,
  costo_real numeric(16, 4),
  estado text,
  error jsonb,
  fecha timestamptz NOT NULL
);
CREATE INDEX mensajes_charla ON mensajes (negocio_id, contacto, fecha);
CREATE INDEX mensajes_fecha ON mensajes (negocio_id, fecha);
CREATE INDEX mensajes_plantillas ON mensajes (numero_id, fecha) WHERE direccion = 'sale' AND plantilla IS NOT NULL;

CREATE TABLE plantillas (
  id serial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  waba_id text NOT NULL,
  meta_id text,
  nombre text NOT NULL,
  idioma text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  componentes jsonb NOT NULL DEFAULT '[]',
  estado text NOT NULL,
  motivo text,
  -- Meta la recategorizo a algo que la app no tiene.
  bloqueada boolean NOT NULL DEFAULT false,
  creado timestamptz NOT NULL DEFAULT now(),
  UNIQUE (negocio_id, nombre, idioma)
);
CREATE INDEX plantillas_meta ON plantillas (meta_id);

CREATE TABLE uso_ia (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  capacidad text NOT NULL,
  modelo text NOT NULL,
  tokens_entrada integer NOT NULL,
  tokens_salida integer NOT NULL,
  costo_usd numeric(16, 6) NOT NULL,
  fecha timestamptz NOT NULL
);
CREATE INDEX uso_ia_fecha ON uso_ia (negocio_id, fecha);

CREATE TABLE precios_meta (
  categoria text PRIMARY KEY,
  precio_ars numeric(16, 4) NOT NULL,
  desde timestamptz NOT NULL DEFAULT now()
);
-- Los oficiales de Argentina al 2026-10-10.
INSERT INTO precios_meta (categoria, precio_ars) VALUES
  ('marketing', 89.5620),
  ('utility', 37.6798),
  ('authentication', 37.6798),
  ('service', 0);

-- El dolar tarjeta que carga Homero. Vale el ultimo.
CREATE TABLE dolar (
  id serial PRIMARY KEY,
  ars_por_usd numeric(16, 4) NOT NULL,
  quien text NOT NULL,
  desde timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cambios (
  id bigserial PRIMARY KEY,
  negocio_id integer REFERENCES negocios (id),
  campo text NOT NULL,
  antes text,
  despues text,
  quien text NOT NULL,
  fecha timestamptz NOT NULL
);
CREATE INDEX cambios_negocio ON cambios (negocio_id, fecha);

-- La bandeja de salida. negocio_id null: eventos de admin (alertas para Homero).
CREATE TABLE eventos (
  id bigserial PRIMARY KEY,
  negocio_id integer REFERENCES negocios (id),
  tipo text NOT NULL,
  datos jsonb NOT NULL,
  fecha timestamptz NOT NULL,
  entregado boolean NOT NULL DEFAULT false,
  intentos integer NOT NULL DEFAULT 0,
  proximo_intento timestamptz,
  alertado boolean NOT NULL DEFAULT false
);
CREATE INDEX eventos_pendientes ON eventos (negocio_id, id) WHERE NOT entregado;
CREATE INDEX eventos_push ON eventos (proximo_intento) WHERE NOT entregado AND NOT alertado;

CREATE TABLE ia_trabajos (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  numero_id integer NOT NULL REFERENCES numeros (id),
  contacto text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('factura', 'atender')),
  entrada jsonb NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'tomada', 'lista', 'fallida')),
  tomada_hasta timestamptz,
  resultado jsonb,
  error text,
  creado timestamptz NOT NULL
);
CREATE INDEX ia_abiertos ON ia_trabajos (id) WHERE estado IN ('pendiente', 'tomada');

CREATE TABLE alertas (
  id bigserial PRIMARY KEY,
  -- Para no repetir (tope:3:2026-10:80). Null: siempre se guarda.
  clave text UNIQUE,
  negocio_id integer REFERENCES negocios (id),
  tipo text NOT NULL,
  texto text NOT NULL,
  fecha timestamptz NOT NULL
);

CREATE TABLE intentos_negados (
  id bigserial PRIMARY KEY,
  negocio_id integer NOT NULL REFERENCES negocios (id),
  metodo text NOT NULL,
  ruta text NOT NULL,
  fecha timestamptz NOT NULL
);

-- Cuantos webhooks llegan por numero: para la alerta de "no llegan mensajes".
CREATE TABLE webhook_eventos (
  id bigserial PRIMARY KEY,
  numero_id integer NOT NULL REFERENCES numeros (id),
  fecha timestamptz NOT NULL
);
CREATE INDEX webhook_eventos_numero ON webhook_eventos (numero_id, fecha);
