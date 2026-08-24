CREATE TABLE IF NOT EXISTS chat_state (
  chat_id      BIGINT PRIMARY KEY,
  active_agent TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_session (
  chat_id    BIGINT NOT NULL,
  agent      TEXT   NOT NULL,
  project    TEXT   NOT NULL,
  session_id TEXT   NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, agent, project)
);

CREATE TABLE IF NOT EXISTS jobs (
  id         UUID PRIMARY KEY,
  chat_id    BIGINT NOT NULL,
  agent      TEXT   NOT NULL,
  project    TEXT   NOT NULL,
  prompt     TEXT   NOT NULL,
  status     TEXT   NOT NULL,
  message_id BIGINT,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS jobs_chat_created_idx ON jobs (chat_id, created_at DESC);
