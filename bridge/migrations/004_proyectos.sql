-- Proyectos, y quienes pertenecen a ellos.
--
-- El proyecto pasa a ser la unidad de agrupacion del sistema: agrupa agentes y
-- personas. Reemplaza a config/projects.json, que vivia en el filesystem de la
-- VM y por lo tanto no podia consultarlo ni el panel ni el bridge.

CREATE TABLE IF NOT EXISTS public.proyectos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El nombre termina en `/srv/work/<agente>/<proyecto>`, asi que no puede
  -- traer separadores. Mismo criterio que `esNombreValido` en router.ts.
  nombre     TEXT NOT NULL UNIQUE,
  repo_url   TEXT,
  -- Las tareas que el gateway sabe correr: {"test": ["pnpm","test"], ...}.
  -- Salen de config/projects.json.
  tareas     JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT proyectos_nombre_forma CHECK (nombre ~ '^[a-zA-Z0-9._-]+$'),
  CONSTRAINT proyectos_nombre_no_relativo CHECK (nombre <> '.' AND nombre <> '..')
);

CREATE TABLE IF NOT EXISTS public.miembros (
  proyecto_id UUID NOT NULL REFERENCES public.proyectos(id) ON DELETE CASCADE,
  usuario_id  UUID NOT NULL,
  rol         TEXT NOT NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (proyecto_id, usuario_id),
  CONSTRAINT miembros_rol_valido CHECK (rol IN ('dueño', 'miembro'))
);

-- El indice inverso: "de que proyectos es miembro este usuario" es la consulta
-- que hace CADA policy de RLS, en cada request. Sin esto es un scan por tabla.
CREATE INDEX IF NOT EXISTS miembros_usuario_idx ON public.miembros (usuario_id);

CREATE TABLE IF NOT EXISTS public.invitaciones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id  UUID NOT NULL REFERENCES public.proyectos(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  rol          TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  invitado_por UUID NOT NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en    TIMESTAMPTZ NOT NULL,
  aceptada_en  TIMESTAMPTZ,

  CONSTRAINT invitaciones_rol_valido CHECK (rol IN ('dueño', 'miembro'))
);

CREATE INDEX IF NOT EXISTS invitaciones_proyecto_idx
  ON public.invitaciones (proyecto_id);
