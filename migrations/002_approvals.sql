CREATE TABLE IF NOT EXISTS approvals (
  approval_id UUID PRIMARY KEY,
  job_id      UUID   NOT NULL,
  chat_id     BIGINT NOT NULL,
  message_id  BIGINT NOT NULL,
  agent       TEXT   NOT NULL,
  tool        TEXT   NOT NULL,
  summary     TEXT   NOT NULL,
  -- NULL = todavia pendiente. La transicion de NULL a no-NULL es la que se
  -- hace de forma atomica y es la que da la idempotencia del boton.
  decision    TEXT,
  feedback    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS approvals_job_idx ON approvals (job_id);

-- A que aprobacion le corresponde el proximo mensaje del chat, cuando el
-- usuario toco "Rechazar y explicar". NULL o fila ausente = ninguna.
CREATE TABLE IF NOT EXISTS awaiting_feedback (
  chat_id     BIGINT PRIMARY KEY,
  approval_id UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
