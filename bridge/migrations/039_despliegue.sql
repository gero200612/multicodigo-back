-- Despliegue a la app que elija cada persona: Render, Vercel, Netlify o Railway.
--
-- `conexiones_despliegue`: el token de cada proveedor, CIFRADO por el bridge
-- (AES-256-GCM, ver src/cifrado.ts). RLS prendido y SIN policies: ningun
-- cliente con JWT lo lee; solo el bridge, que entra con el rol del servicio.
-- `extra` guarda lo que cada proveedor necesita ademas del token (el owner de
-- Render, el team de Vercel, la instalacion de GitHub de Netlify).
CREATE TABLE IF NOT EXISTS public.conexiones_despliegue (
  usuario_id    UUID NOT NULL,
  proveedor     TEXT NOT NULL CHECK (proveedor IN ('render', 'vercel', 'netlify', 'railway')),
  token_cifrado TEXT NOT NULL,
  extra         JSONB NOT NULL DEFAULT '{}'::jsonb,
  cuenta        TEXT,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, proveedor)
);
ALTER TABLE public.conexiones_despliegue ENABLE ROW LEVEL SECURITY;

-- Donde se publica cada repo. NULL = como antes (Render del sistema, si hay).
-- `destino_id` es el id del lado del proveedor (servicio, proyecto, sitio) y
-- `destino_url` la URL publica, para poder darla.
ALTER TABLE public.repos ADD COLUMN IF NOT EXISTS destino TEXT;
ALTER TABLE public.repos ADD COLUMN IF NOT EXISTS destino_id TEXT;
ALTER TABLE public.repos ADD COLUMN IF NOT EXISTS destino_url TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repos_destino_valido') THEN
    ALTER TABLE public.repos ADD CONSTRAINT repos_destino_valido
      CHECK (destino IS NULL OR destino IN ('render', 'vercel', 'netlify', 'railway'));
  END IF;
END $$;
