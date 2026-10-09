-- Punchi publica en el VPS (Coolify).
--
-- Ver `docs/superpowers/specs/2026-10-09-punchi-hosting-vps-design.md`.
--
-- `vps` se suma a los destinos de un repo. NO es una conexion de una persona
-- (no hay token propio): es el VPS del sistema, y el token de Coolify vive en
-- el entorno del bridge.
--
-- `vps_recursos` es lo UNICO sobre lo que Punchi puede actuar en Coolify:
-- apagar y borrar usan estos uuids y nunca buscan por nombre. Lo que esta en
-- Coolify y no esta aca (SincroResto, Justadama) se ve, pero no se toca.
--
-- `secreto` es la conexion a la base, CIFRADA con `cifrado.ts`: lleva la
-- contraseña. RLS prendido y sin policies, como `conexiones_despliegue`: solo
-- el bridge lee y escribe.
--
-- Idempotente: las migraciones corren TODAS en cada arranque del bridge.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repos_destino_valido') THEN
    ALTER TABLE public.repos DROP CONSTRAINT repos_destino_valido;
  END IF;
  ALTER TABLE public.repos ADD CONSTRAINT repos_destino_valido
    CHECK (destino IS NULL OR destino IN ('render', 'vercel', 'netlify', 'railway', 'vps'));
END $$;

CREATE TABLE IF NOT EXISTS public.vps_recursos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id    UUID NOT NULL REFERENCES public.proyectos(id) ON DELETE CASCADE,
  -- proyecto | base | back | front | app
  parte          TEXT NOT NULL CHECK (parte IN ('proyecto', 'base', 'back', 'front', 'app')),
  -- El repo de la parte; '' para el proyecto de Coolify y la base.
  repo           TEXT NOT NULL DEFAULT '',
  coolify_uuid   TEXT NOT NULL UNIQUE,
  url            TEXT,
  estado         TEXT NOT NULL DEFAULT 'creando'
                 CHECK (estado IN ('creando', 'construyendo', 'andando', 'apagado', 'fallo')),
  motivo         TEXT,
  secreto        TEXT,
  produccion     BOOLEAN NOT NULL DEFAULT false,
  actualizado_el TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proyecto_id, parte, repo)
);
ALTER TABLE public.vps_recursos ENABLE ROW LEVEL SECURITY;

-- Las demos de Homero se apagan solas a los 14 dias de la reunion. Nunca se
-- borran solas. `demo_avisada` evita mandar el aviso dos veces.
ALTER TABLE public.proyectos ADD COLUMN IF NOT EXISTS demo_apagar_el TIMESTAMPTZ;
ALTER TABLE public.proyectos ADD COLUMN IF NOT EXISTS demo_avisada BOOLEAN NOT NULL DEFAULT false;
