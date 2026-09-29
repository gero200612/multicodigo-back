-- Fases 2 a 4: leads, secuencias de mails, agenda.

-- Un negocio encontrado. El email es unico: a una misma direccion no se la
-- contacta dos veces aunque aparezca en dos busquedas.
CREATE TABLE IF NOT EXISTS homero.leads (
  id            BIGSERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  rubro         TEXT NOT NULL,
  ciudad        TEXT NOT NULL,
  web           TEXT,
  email         TEXT UNIQUE,
  telefono      TEXT,
  fuente        TEXT NOT NULL,
  -- Id del lugar en la fuente (Google o OSM), para no traer dos veces el mismo.
  externo       TEXT UNIQUE,
  -- Lo que la IA saco de la web: resumen de la empresa, dolor, idea.
  investigacion JSONB,
  estado        TEXT NOT NULL DEFAULT 'nuevo'
                CHECK (estado IN ('nuevo', 'descartado', 'borrador', 'aprobado', 'contactado',
                                  'respondio', 'reunion', 'cerrado', 'baja', 'rebotado')),
  casilla       TEXT,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_estado_idx ON homero.leads (estado);

-- Cada mail que Homero escribe: el inicial, los seguimientos, las respuestas.
CREATE TABLE IF NOT EXISTS homero.salientes (
  id              BIGSERIAL PRIMARY KEY,
  lead_id         BIGINT NOT NULL REFERENCES homero.leads(id),
  tipo            TEXT NOT NULL CHECK (tipo IN ('inicial', 'seguimiento', 'respuesta', 'confirmacion', 'recordatorio')),
  paso            INT NOT NULL DEFAULT 0,
  casilla         TEXT,
  asunto          TEXT NOT NULL,
  cuerpo          TEXT NOT NULL,
  en_respuesta_a  TEXT,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador', 'aprobado', 'enviado', 'cancelado')),
  message_id      TEXT,
  -- El mensaje de Telegram con los botones, para editarlo al decidir y para
  -- reconocer cuando Gero le contesta con una correccion.
  telegram_msg    BIGINT,
  -- La reunion a la que se refiere (confirmacion y recordatorio).
  reunion_id      BIGINT,
  creado          TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_en      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS salientes_lead_idx ON homero.salientes (lead_id);
CREATE INDEX IF NOT EXISTS salientes_telegram_idx ON homero.salientes (telegram_msg);

-- Horarios ofrecidos a un lead: cuando contesta "el martes", se elige de aca.
CREATE TABLE IF NOT EXISTS homero.ofertas (
  lead_id  BIGINT PRIMARY KEY REFERENCES homero.leads(id),
  horarios JSONB NOT NULL,
  creada   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homero.reuniones (
  id      BIGSERIAL PRIMARY KEY,
  lead_id BIGINT NOT NULL REFERENCES homero.leads(id),
  inicio  TIMESTAMPTZ NOT NULL,
  fin     TIMESTAMPTZ NOT NULL,
  link    TEXT NOT NULL,
  estado  TEXT NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada', 'cancelada')),
  creada  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dos reuniones confirmadas no pueden empezar a la misma hora.
CREATE UNIQUE INDEX IF NOT EXISTS reuniones_inicio_idx
  ON homero.reuniones (inicio) WHERE estado = 'confirmada';

-- Dias que Gero bloqueo con /ocupado.
CREATE TABLE IF NOT EXISTS homero.ocupados (
  dia DATE PRIMARY KEY
);

-- Que rubro y ciudad ya se buscaron, para no repetir y para rotar.
CREATE TABLE IF NOT EXISTS homero.busquedas (
  id       BIGSERIAL PRIMARY KEY,
  rubro    TEXT NOT NULL,
  ciudad   TEXT NOT NULL,
  fuente   TEXT NOT NULL,
  hallados INT NOT NULL,
  hecha    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Los rebotes, para frenar una casilla que esta mandando a direcciones malas.
CREATE TABLE IF NOT EXISTS homero.rebotes (
  id      BIGSERIAL PRIMARY KEY,
  cuenta  TEXT NOT NULL,
  email   TEXT,
  llegado TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Los tipos nuevos de tarea no necesitan cambio de esquema: `tipo` es TEXT.
