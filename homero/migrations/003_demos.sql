-- Demos: Homero le pasa a Punchi lo que sabe de una empresa con reunion y
-- Punchi arma una corrida entera. Una por reunion.
CREATE TABLE IF NOT EXISTS homero.demos (
  id           BIGSERIAL PRIMARY KEY,
  reunion_id   BIGINT NOT NULL UNIQUE REFERENCES homero.reuniones(id),
  lead_id      BIGINT NOT NULL REFERENCES homero.leads(id),
  -- El nombre del proyecto en Punchi: slug de la empresa + "-demo".
  proyecto     TEXT NOT NULL,
  pliego       TEXT,
  estado       TEXT NOT NULL DEFAULT 'redactando'
               CHECK (estado IN ('redactando', 'pliego', 'enviada', 'lista', 'fallida')),
  corrida_id   TEXT,
  url          TEXT,
  error        TEXT,
  -- La tarjeta de Telegram con el pliego: para editarlo respondiendole y para
  -- sacarle los botones si se decide desde la web.
  telegram_msg BIGINT,
  creada       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demos_telegram_idx ON homero.demos (telegram_msg);
