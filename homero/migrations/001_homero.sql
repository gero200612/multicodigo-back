-- Homero vive en su propio esquema: comparte la base de Supabase con el bridge
-- de Punchi, pero no una sola tabla. Las de Punchi estan keyeadas por chat_id
-- sin id de bot, y dos bots escribiendo en ellas se pisarian.
--
-- Idempotente como las del bridge: corre entera en cada arranque.
CREATE SCHEMA IF NOT EXISTS homero;

-- Estado suelto del proceso: pausa manual, pausa de la IA por limite, etc.
-- Vive en la base y no en memoria para que un reinicio no olvide que estaba
-- esperando un reset.
CREATE TABLE IF NOT EXISTS homero.estado (
  clave       TEXT PRIMARY KEY,
  valor       JSONB NOT NULL,
  actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homero.cuentas (
  email       TEXT PRIMARY KEY,
  -- El calentamiento se cuenta desde aca: el cupo diario sube con los dias
  -- que la casilla lleva mandando, no con los que lleva creada.
  primer_envio TIMESTAMPTZ,
  creada      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homero.envios (
  id         BIGSERIAL PRIMARY KEY,
  cuenta     TEXT NOT NULL REFERENCES homero.cuentas(email),
  para       TEXT NOT NULL,
  asunto     TEXT NOT NULL,
  message_id TEXT,
  enviado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS envios_cuenta_fecha_idx ON homero.envios (cuenta, enviado_en DESC);

CREATE TABLE IF NOT EXISTS homero.recibidos (
  cuenta      TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  de          TEXT NOT NULL,
  asunto      TEXT NOT NULL,
  cuerpo      TEXT NOT NULL,
  recibido_en TIMESTAMPTZ NOT NULL,
  guardado    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cuenta, message_id)
);

-- A quien no se le escribe nunca mas. Se consulta antes de CADA envio.
CREATE TABLE IF NOT EXISTS homero.bajas (
  email  TEXT PRIMARY KEY,
  motivo TEXT NOT NULL,
  creada TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La cola. Todo lo que Homero hace pasa por aca, asi un corte (reinicio o
-- limite de Claude) retoma en la tarea exacta y nada se hace dos veces.
CREATE TABLE IF NOT EXISTS homero.tareas (
  id               BIGSERIAL PRIMARY KEY,
  tipo             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  requiere_ia      BOOLEAN NOT NULL,
  -- Para no encolar dos veces lo mismo (p. ej. resumir el mismo mail).
  clave            TEXT UNIQUE,
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente', 'corriendo', 'lista', 'fallida')),
  intentos         INT NOT NULL DEFAULT 0,
  disponible_desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_error     TEXT,
  creada           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tareas_pendientes_idx
  ON homero.tareas (disponible_desde) WHERE estado = 'pendiente';
