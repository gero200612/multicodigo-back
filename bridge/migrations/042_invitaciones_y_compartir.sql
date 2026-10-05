-- Grupos con invitacion, y un Claude compartido con VARIOS grupos.
--
-- Dos cambios sobre la 041, pedidos por el usuario:
--
-- 1. Sumar a alguien a un grupo ya no lo mete de una: le llega una invitacion
--    y la tiene que aceptar. Antes el dueño del grupo podia meter a cualquiera
--    de la empresa sin que se enterara.
-- 2. Un Claude se comparte grupo por grupo (un interruptor en cada grupo), no
--    con UN grupo. `agentes.grupo_id` admitia uno solo; ahora es la tabla
--    `claude_grupos`. Lo compartido antes se pasa a la tabla y la columna
--    queda en NULL (no se borra: la 041 la vuelve a crear en cada arranque).
--
-- Igual que la 040 y la 041: corre en cada arranque, tiene que ser idempotente.
-- Y como la 041 corre ANTES y redefine sus funciones cada vez, aca no se puede
-- cambiar el tipo de retorno de `mis_claudes` ni de `mis_grupos` (el segundo
-- arranque fallaria en la 041). Las lecturas nuevas son funciones nuevas.

-- --- un Claude, varios grupos -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.claude_grupos (
  slot      TEXT NOT NULL REFERENCES public.agentes(slot) ON DELETE CASCADE,
  grupo_id  UUID NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (slot, grupo_id)
);

CREATE INDEX IF NOT EXISTS claude_grupos_grupo_idx ON public.claude_grupos (grupo_id);

-- Sin policies: se lee y escribe solo por las funciones de abajo.
ALTER TABLE public.claude_grupos ENABLE ROW LEVEL SECURITY;

INSERT INTO public.claude_grupos (slot, grupo_id)
SELECT slot, grupo_id FROM public.agentes WHERE grupo_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE public.agentes SET grupo_id = NULL WHERE grupo_id IS NOT NULL;

-- --- invitaciones -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.grupo_invitaciones (
  grupo_id     UUID NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  usuario_id   UUID NOT NULL,
  invitado_por UUID NOT NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (grupo_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS grupo_invitaciones_usuario_idx ON public.grupo_invitaciones (usuario_id);

ALTER TABLE public.grupo_invitaciones ENABLE ROW LEVEL SECURITY;

-- --- la regla -----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.puede_usar_slot(p_usuario UUID, p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a public.agentes;
BEGIN
  IF p_usuario IS NULL THEN
    RETURN false;
  END IF;
  IF public._es_superadmin(p_usuario) THEN
    RETURN true;
  END IF;
  SELECT * INTO a FROM public.agentes WHERE slot = p_slot;
  -- Slot sin fila: puede tener la cuenta de cualquiera. Solo el superadmin.
  IF a.slot IS NULL THEN
    RETURN false;
  END IF;
  IF a.usuario_id = p_usuario THEN
    RETURN true;
  END IF;
  -- Compartido con algun grupo del que soy parte.
  IF EXISTS (
    SELECT 1 FROM public.claude_grupos cg
      JOIN public.grupo_miembros gm ON gm.grupo_id = cg.grupo_id
     WHERE cg.slot = p_slot AND gm.usuario_id = p_usuario
  ) THEN
    RETURN true;
  END IF;
  -- Sin dueño: un Claude de antes, del proyecto. Lo usa quien puede escribir
  -- en ese proyecto.
  IF a.usuario_id IS NULL THEN
    RETURN COALESCE(public.acceso_a_proyecto(p_usuario, a.proyecto_id) = 'escribir', false);
  END IF;
  RETURN false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.puede_usar_slot(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- --- lecturas -----------------------------------------------------------------

-- Los Claudes que puedo usar, con TODOS los grupos con los que estan
-- compartidos (de los que yo soy parte: los demas grupos no los veo).
CREATE OR REPLACE FUNCTION public.claudes_disponibles()
RETURNS TABLE (slot TEXT, nombre TEXT, proyecto TEXT, duenio TEXT, es_mio BOOLEAN, grupos JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.slot, a.nombre, p.nombre, u.email::text,
         COALESCE(a.usuario_id = (SELECT auth.uid()), false),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'nombre', g.nombre) ORDER BY g.nombre), '[]'::jsonb)
            FROM public.claude_grupos cg
            JOIN public.grupos g ON g.id = cg.grupo_id
           WHERE cg.slot = a.slot AND public._es_de_grupo((SELECT auth.uid()), g.id))
    FROM public.agentes a
    JOIN public.proyectos p ON p.id = a.proyecto_id
    LEFT JOIN auth.users u ON u.id = a.usuario_id
   WHERE public.puede_usar_slot((SELECT auth.uid()), a.slot)
     AND public.acceso_a_proyecto((SELECT auth.uid()), a.proyecto_id) IS NOT NULL
   ORDER BY a.slot;
$$;

REVOKE EXECUTE ON FUNCTION public.claudes_disponibles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claudes_disponibles() TO authenticated;

-- Mis grupos con sus miembros, las invitaciones pendientes y los Claudes que
-- hay compartidos en cada uno.
CREATE OR REPLACE FUNCTION public.grupos_mios()
RETURNS TABLE (id UUID, nombre TEXT, soy_duenio BOOLEAN, miembros JSONB, invitados JSONB, claudes JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id, g.nombre, yo.rol = 'dueño',
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'usuario_id', gm.usuario_id, 'email', u.email, 'rol', gm.rol) ORDER BY u.email), '[]'::jsonb)
            FROM public.grupo_miembros gm
            LEFT JOIN auth.users u ON u.id = gm.usuario_id
           WHERE gm.grupo_id = g.id),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'usuario_id', gi.usuario_id, 'email', u.email) ORDER BY u.email), '[]'::jsonb)
            FROM public.grupo_invitaciones gi
            LEFT JOIN auth.users u ON u.id = gi.usuario_id
           WHERE gi.grupo_id = g.id),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'slot', a.slot, 'nombre', a.nombre, 'duenio', u.email) ORDER BY a.slot), '[]'::jsonb)
            FROM public.claude_grupos cg
            JOIN public.agentes a ON a.slot = cg.slot
            LEFT JOIN auth.users u ON u.id = a.usuario_id
           WHERE cg.grupo_id = g.id)
    FROM public.grupos g
    JOIN public.grupo_miembros yo ON yo.grupo_id = g.id AND yo.usuario_id = (SELECT auth.uid())
   ORDER BY g.nombre;
$$;

REVOKE EXECUTE ON FUNCTION public.grupos_mios() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grupos_mios() TO authenticated;

-- Las invitaciones que me hicieron y todavia no conteste.
CREATE OR REPLACE FUNCTION public.mis_invitaciones()
RETURNS TABLE (grupo_id UUID, grupo TEXT, invito TEXT, creado_en TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT gi.grupo_id, g.nombre, u.email::text, gi.creado_en
    FROM public.grupo_invitaciones gi
    JOIN public.grupos g ON g.id = gi.grupo_id
    LEFT JOIN auth.users u ON u.id = gi.invitado_por
   WHERE gi.usuario_id = (SELECT auth.uid())
   ORDER BY gi.creado_en;
$$;

REVOKE EXECUTE ON FUNCTION public.mis_invitaciones() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mis_invitaciones() TO authenticated;

-- --- escrituras ---------------------------------------------------------------

-- Invitar: el dueño del grupo, a alguien de la misma empresa que pueda lanzar
-- agentes. No entra hasta que acepta.
CREATE OR REPLACE FUNCTION public.invitar_a_grupo(p_grupo UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID := public._exigir_duenio_de_grupo(p_grupo);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.empresa_miembros
     WHERE empresa_id = v_empresa AND usuario_id = p_usuario AND rango <> 'lector'
  ) THEN
    RAISE EXCEPTION 'no_es_de_la_empresa' USING ERRCODE = 'check_violation';
  END IF;
  IF public._es_de_grupo(p_usuario, p_grupo) THEN
    RAISE EXCEPTION 'ya_es_del_grupo' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.grupo_invitaciones (grupo_id, usuario_id, invitado_por)
  VALUES (p_grupo, p_usuario, (SELECT auth.uid()))
  ON CONFLICT (grupo_id, usuario_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invitar_a_grupo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invitar_a_grupo(UUID, UUID) TO authenticated;

-- La de la 041 sumaba directo. Queda con el mismo nombre (un panel viejo la
-- sigue llamando) pero ahora invita: nadie entra a un grupo sin aceptar.
CREATE OR REPLACE FUNCTION public.sumar_a_grupo(p_grupo UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.invitar_a_grupo(p_grupo, p_usuario);
$$;

REVOKE EXECUTE ON FUNCTION public.sumar_a_grupo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sumar_a_grupo(UUID, UUID) TO authenticated;

-- El dueño se arrepiente antes de que la acepten.
CREATE OR REPLACE FUNCTION public.cancelar_invitacion(p_grupo UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._exigir_duenio_de_grupo(p_grupo);
  DELETE FROM public.grupo_invitaciones WHERE grupo_id = p_grupo AND usuario_id = p_usuario;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancelar_invitacion(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_invitacion(UUID, UUID) TO authenticated;

-- Aceptar o rechazar una invitacion propia. Al aceptar se vuelve a mirar que
-- siga en la empresa: la invitacion pudo quedar de antes de que lo sacaran.
CREATE OR REPLACE FUNCTION public.responder_invitacion(p_grupo UUID, p_acepta BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  DELETE FROM public.grupo_invitaciones WHERE grupo_id = p_grupo AND usuario_id = v_usuario;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sin_invitacion' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT p_acepta THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.grupos g
      JOIN public.empresa_miembros em ON em.empresa_id = g.empresa_id
     WHERE g.id = p_grupo AND em.usuario_id = v_usuario AND em.rango <> 'lector'
  ) THEN
    RAISE EXCEPTION 'no_es_de_la_empresa' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.grupo_miembros (grupo_id, usuario_id) VALUES (p_grupo, v_usuario)
  ON CONFLICT (grupo_id, usuario_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.responder_invitacion(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responder_invitacion(UUID, BOOLEAN) TO authenticated;

-- Prender o apagar un Claude propio en un grupo del que soy parte.
CREATE OR REPLACE FUNCTION public.compartir_en_grupo(p_slot TEXT, p_grupo UUID, p_prendido BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agentes WHERE slot = p_slot AND usuario_id = v_usuario) THEN
    RAISE EXCEPTION 'no_es_tu_claude' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public._es_de_grupo(v_usuario, p_grupo) THEN
    RAISE EXCEPTION 'no_es_tu_grupo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_prendido THEN
    INSERT INTO public.claude_grupos (slot, grupo_id) VALUES (p_slot, p_grupo)
    ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.claude_grupos WHERE slot = p_slot AND grupo_id = p_grupo;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compartir_en_grupo(TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compartir_en_grupo(TEXT, UUID, BOOLEAN) TO authenticated;

-- La de la 041 (un grupo o ninguno), sobre la tabla nueva: deja el Claude
-- compartido SOLO con ese grupo, o con ninguno si viene NULL.
CREATE OR REPLACE FUNCTION public.compartir_claude(p_slot TEXT, p_grupo UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agentes WHERE slot = p_slot AND usuario_id = v_usuario) THEN
    RAISE EXCEPTION 'no_es_tu_claude' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_grupo IS NOT NULL AND NOT public._es_de_grupo(v_usuario, p_grupo) THEN
    RAISE EXCEPTION 'no_es_tu_grupo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.claude_grupos WHERE slot = p_slot AND grupo_id IS DISTINCT FROM p_grupo;
  IF p_grupo IS NOT NULL THEN
    INSERT INTO public.claude_grupos (slot, grupo_id) VALUES (p_slot, p_grupo) ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compartir_claude(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compartir_claude(TEXT, UUID) TO authenticated;

-- Quien se va de un grupo (o lo sacan) deja de compartir ahi sus Claudes: son
-- SUS credenciales, y ya no esta para decidir sobre ese grupo.
CREATE OR REPLACE FUNCTION public.sacar_de_grupo(p_grupo UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  IF p_usuario <> v_usuario THEN
    PERFORM public._exigir_duenio_de_grupo(p_grupo);
  END IF;
  DELETE FROM public.grupo_miembros
   WHERE grupo_id = p_grupo AND usuario_id = p_usuario AND rol <> 'dueño';
  IF FOUND THEN
    DELETE FROM public.claude_grupos cg
     USING public.agentes a
     WHERE cg.slot = a.slot AND cg.grupo_id = p_grupo AND a.usuario_id = p_usuario;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sacar_de_grupo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sacar_de_grupo(UUID, UUID) TO authenticated;

-- La de la 041, con la tabla nueva y las invitaciones.
CREATE OR REPLACE FUNCTION public.quitar_de_empresa(p_empresa UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actual TEXT;
BEGIN
  PERFORM public._exigir_admin(p_empresa);
  SELECT rango INTO v_actual FROM public.empresa_miembros
   WHERE empresa_id = p_empresa AND usuario_id = p_usuario FOR UPDATE;
  IF v_actual IS NULL THEN
    RETURN;
  END IF;
  IF v_actual = 'admin' AND NOT public._quedan_admins(p_empresa, p_usuario) THEN
    RAISE EXCEPTION 'ultimo_admin' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM public.miembros
   WHERE usuario_id = p_usuario
     AND proyecto_id IN (SELECT id FROM public.proyectos WHERE empresa_id = p_empresa);
  DELETE FROM public.grupo_miembros
   WHERE usuario_id = p_usuario
     AND grupo_id IN (SELECT id FROM public.grupos WHERE empresa_id = p_empresa);
  DELETE FROM public.grupo_invitaciones
   WHERE (usuario_id = p_usuario OR invitado_por = p_usuario)
     AND grupo_id IN (SELECT id FROM public.grupos WHERE empresa_id = p_empresa);
  -- Sus Claudes tienen SU cuenta de Claude adentro: dejan de estar compartidos.
  DELETE FROM public.claude_grupos
   WHERE slot IN (SELECT slot FROM public.agentes WHERE usuario_id = p_usuario);
  UPDATE public.agentes SET grupo_id = NULL WHERE usuario_id = p_usuario;
  DELETE FROM public.grupos g
   WHERE g.empresa_id = p_empresa
     AND NOT EXISTS (SELECT 1 FROM public.grupo_miembros gm WHERE gm.grupo_id = g.id AND gm.rol = 'dueño');
  DELETE FROM public.empresa_miembros WHERE empresa_id = p_empresa AND usuario_id = p_usuario;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) TO authenticated;
