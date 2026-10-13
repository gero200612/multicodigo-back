-- Reels que se publican en Instagram (de prueba) y en la pagina de Facebook
-- (spec 2026-10-13-homero-subir-reels-design.md). Por ahora los manda Gero
-- por Telegram; despues tambien los arma Homero (`origen`).
CREATE TABLE IF NOT EXISTS homero.reels (
  id                 BIGSERIAL PRIMARY KEY,
  origen             TEXT NOT NULL DEFAULT 'gero' CHECK (origen IN ('gero', 'homero')),
  -- El video en el volumen de medios. Se vacia al publicar o descartar.
  archivo            TEXT,
  duracion           NUMERIC(6, 2) NOT NULL,
  peso               INT NOT NULL,
  caption            TEXT NOT NULL DEFAULT '',
  por_que            TEXT NOT NULL DEFAULT '',
  telegram_msg       BIGINT,
  -- `escribiendo`: el publicista arma el texto; Gero todavia no lo vio.
  estado             TEXT NOT NULL DEFAULT 'escribiendo'
                     CHECK (estado IN ('escribiendo', 'propuesto', 'subiendo', 'publicado', 'fallido', 'descartado')),
  -- Como reel de prueba (solo a los que no siguen; Instagram lo pasa si rinde).
  prueba             BOOLEAN NOT NULL DEFAULT true,
  -- Gero toco 📣: el anuncio se crea solo cuando rinde.
  promocionar        BOOLEAN NOT NULL DEFAULT false,
  ig_contenedor      TEXT,
  ig_media_id        TEXT,
  fb_video_id        TEXT,
  anuncio_id         BIGINT REFERENCES homero.anuncios(id),
  metricas           JSONB,
  propuesta_promo_en TIMESTAMPTZ,
  motivo             TEXT,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  aprobado_en        TIMESTAMPTZ,
  publicado_en       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reels_estado_idx ON homero.reels (estado);
CREATE INDEX IF NOT EXISTS reels_telegram_idx ON homero.reels (telegram_msg);

-- El anuncio hecho con un reel: el creativo usa el reel publicado tal cual.
ALTER TABLE homero.anuncios ADD COLUMN IF NOT EXISTS reel_id BIGINT;
