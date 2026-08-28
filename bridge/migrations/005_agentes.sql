-- Los agentes, y a que proyecto pertenece cada uno.
--
-- Reemplaza a slot_nombres, que era global y sin dueño. Su propio SQL lo
-- advertia: "si alguna vez hay mas de un equipo sobre el mismo Supabase, esta
-- tabla necesita una columna de dueño y estas politicas hay que rehacerlas".
--
-- Esta tabla NO es el registro de que agentes existen: eso lo contesta Docker,
-- listando contenedores. Aca vive lo que Docker no sabe — de quien es el slot y
-- como se llama para las personas.

CREATE TABLE IF NOT EXISTS public.agentes (
  -- Espeja AgentId del contrato compartido (`^c[1-9][0-9]?$`). Los dos tienen
  -- que moverse juntos.
  slot        TEXT PRIMARY KEY,
  proyecto_id UUID NOT NULL REFERENCES public.proyectos(id) ON DELETE CASCADE,
  nombre      TEXT,
  -- La cuenta de Claude cargada en el slot, para mostrarla. El token NO vive
  -- aca ni en ninguna tabla: vive en el HOME del slot, en la VM.
  cuenta      TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT agentes_slot_forma CHECK (slot ~ '^c[1-9][0-9]?$'),
  CONSTRAINT agentes_nombre_largo CHECK (nombre IS NULL OR length(nombre) <= 60),
  CONSTRAINT agentes_nombre_no_vacio CHECK (nombre IS NULL OR length(btrim(nombre)) > 0)
);

CREATE INDEX IF NOT EXISTS agentes_proyecto_idx ON public.agentes (proyecto_id);

-- slot_nombres NO se borra todavia, aunque `agentes` la reemplaza: el panel
-- desplegado la sigue consultando (panel-api/Clientes.cs:300 y :334) y
-- borrarla ahora lo dejaria logueando un error en cada request. El DROP va en
-- el plan 6, que es donde el panel deja de leerla.
