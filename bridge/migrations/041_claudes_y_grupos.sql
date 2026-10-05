-- Claudes por persona y grupos que los comparten (parte B).
--
-- Spec: docs/superpowers/specs/2026-10-04-empresas-design.md
--
-- Un slot (c1..c99) tiene UNA cuenta de Claude cargada en su HOME. Hasta ahora
-- era del proyecto: lo usaba cualquiera que pudiera escribir ahi. Ahora es de
-- la persona que lo crea, y lo usa solo ella o la gente de un grupo con el que
-- lo comparta. Los slots que ya existian quedan sin dueño y siguen con la regla
-- de antes: nadie pierde un Claude que hoy usa.
--
-- Igual que la 040: corre en cada arranque, tiene que ser idempotente.

-- --- grupos -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.grupos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,
  creado_por UUID NOT NULL,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT grupos_nombre_valido CHECK (length(btrim(nombre)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS grupos_empresa_idx ON public.grupos (empresa_id);

CREATE TABLE IF NOT EXISTS public.grupo_miembros (
  grupo_id   UUID NOT NULL REFERENCES public.grupos(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL,
  rol        TEXT NOT NULL DEFAULT 'miembro',
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (grupo_id, usuario_id),
  CONSTRAINT grupo_miembros_rol_valido CHECK (rol IN ('dueño', 'miembro'))
);

CREATE INDEX IF NOT EXISTS grupo_miembros_usuario_idx ON public.grupo_miembros (usuario_id);

ALTER TABLE public.grupos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grupo_miembros ENABLE ROW LEVEL SECURITY;

-- --- dueño del slot ----------------------------------------------------------

-- El dueño lo escribe el BRIDGE al registrar un slot recien creado (el panel se
-- lo pide despues de que el gateway arma el contenedor). Las filas que ya
-- existian quedan en NULL: slots de antes, del proyecto.
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS usuario_id UUID;
ALTER TABLE public.agentes ADD COLUMN IF NOT EXISTS grupo_id UUID REFERENCES public.grupos(id) ON DELETE SET NULL;
ALTER TABLE public.agentes ALTER COLUMN usuario_id DROP DEFAULT;

CREATE INDEX IF NOT EXISTS agentes_usuario_idx ON public.agentes (usuario_id);

-- Por REST no se crea ni se apropia ningun slot. Registrar uno es del bridge:
-- con INSERT abierto, cualquiera anotaria a su nombre un slot que ya existe
-- (con la cuenta de Claude de otra persona adentro) y se quedaria con el.
-- Compartir va por `compartir_claude`. Por REST queda solo cambiarle el
-- nombre y la marca de cuota que deja el panel despues de un test.
REVOKE INSERT, UPDATE ON public.agentes FROM anon, authenticated;
GRANT UPDATE (nombre) ON public.agentes TO authenticated;
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agentes' AND column_name = 'sin_cuota_hasta'
  ) THEN
    GRANT UPDATE (sin_cuota_hasta) ON public.agentes TO authenticated;
  END IF;
END
$do$;

-- --- la regla ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._es_de_grupo(p_usuario UUID, p_grupo UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.grupo_miembros WHERE grupo_id = p_grupo AND usuario_id = p_usuario);
$$;

REVOKE EXECUTE ON FUNCTION public._es_de_grupo(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Si esa persona puede mandarle trabajo a ese Claude. La usa el bridge en
-- CADA turno (panel, Telegram y corridas pasan por el mismo lugar).
--
-- Sin EXECUTE para el navegador, igual que `acceso_a_proyecto`: recibe un
-- usuario cualquiera.
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
  -- Un slot sin fila no es de nadie que el sistema conozca: puede tener la
  -- cuenta de cualquiera adentro, y dejarlo abierto lo usaria gente de
  -- cualquier empresa. Solo el superadmin (arriba).
  IF a.slot IS NULL THEN
    RETURN false;
  END IF;
  IF a.usuario_id = p_usuario THEN
    RETURN true;
  END IF;
  IF a.grupo_id IS NOT NULL AND public._es_de_grupo(p_usuario, a.grupo_id) THEN
    RETURN true;
  END IF;
  -- Sin dueño ni grupo: un Claude de antes, del proyecto. Lo usa quien puede
  -- escribir en ese proyecto.
  IF a.usuario_id IS NULL AND a.grupo_id IS NULL THEN
    RETURN COALESCE(public.acceso_a_proyecto(p_usuario, a.proyecto_id) = 'escribir', false);
  END IF;
  RETURN false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.puede_usar_slot(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- --- lecturas ----------------------------------------------------------------

-- Para las policies, que corren como quien consulta: solo pregunta por VOS.
-- `_es_de_grupo` recibe cualquier usuario y queda cerrada.
CREATE OR REPLACE FUNCTION public.soy_de_grupo(p_grupo UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public._es_de_grupo((SELECT auth.uid()), p_grupo);
$$;

REVOKE EXECUTE ON FUNCTION public.soy_de_grupo(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soy_de_grupo(UUID) TO authenticated;

DROP POLICY IF EXISTS "grupos: leer los mios" ON public.grupos;
CREATE POLICY "grupos: leer los mios" ON public.grupos
  FOR SELECT TO authenticated
  USING (public.soy_de_grupo(id));

DROP POLICY IF EXISTS "grupo_miembros: leer los de mis grupos" ON public.grupo_miembros;
CREATE POLICY "grupo_miembros: leer los de mis grupos" ON public.grupo_miembros
  FOR SELECT TO authenticated
  USING (public.soy_de_grupo(grupo_id));

-- La gente de mi empresa, para elegir a quien sumar a un grupo. Solo usuario
-- y mail: el rango y el resto lo ve el admin con `gente_de_empresa`.
CREATE OR REPLACE FUNCTION public.companeros()
RETURNS TABLE (usuario_id UUID, email TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT em.usuario_id, u.email::text
    FROM public.empresa_miembros yo
    JOIN public.empresa_miembros em ON em.empresa_id = yo.empresa_id
    LEFT JOIN auth.users u ON u.id = em.usuario_id
   WHERE yo.usuario_id = (SELECT auth.uid())
   ORDER BY u.email;
$$;

REVOKE EXECUTE ON FUNCTION public.companeros() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.companeros() TO authenticated;

-- Los Claudes que puedo usar: los mios, los de mis grupos y los de antes (sin
-- dueño) de proyectos donde trabajo.
CREATE OR REPLACE FUNCTION public.mis_claudes()
RETURNS TABLE (
  slot TEXT, nombre TEXT, proyecto TEXT, duenio TEXT, grupo_id UUID, grupo TEXT, es_mio BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.slot, a.nombre, p.nombre, u.email::text, a.grupo_id, g.nombre,
         a.usuario_id = (SELECT auth.uid())
    FROM public.agentes a
    JOIN public.proyectos p ON p.id = a.proyecto_id
    LEFT JOIN auth.users u ON u.id = a.usuario_id
    LEFT JOIN public.grupos g ON g.id = a.grupo_id
   WHERE public.puede_usar_slot((SELECT auth.uid()), a.slot)
     AND public.acceso_a_proyecto((SELECT auth.uid()), a.proyecto_id) IS NOT NULL
   ORDER BY a.slot;
$$;

REVOKE EXECUTE ON FUNCTION public.mis_claudes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mis_claudes() TO authenticated;

CREATE OR REPLACE FUNCTION public.mis_grupos()
RETURNS TABLE (id UUID, nombre TEXT, soy_duenio BOOLEAN, miembros JSONB)
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
           WHERE gm.grupo_id = g.id)
    FROM public.grupos g
    JOIN public.grupo_miembros yo ON yo.grupo_id = g.id AND yo.usuario_id = (SELECT auth.uid())
   ORDER BY g.nombre;
$$;

REVOKE EXECUTE ON FUNCTION public.mis_grupos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mis_grupos() TO authenticated;

-- --- escrituras ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_grupo(p_nombre TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_empresa UUID;
  v_rango TEXT;
  v_id UUID;
BEGIN
  SELECT empresa_id, rango INTO v_empresa, v_rango FROM public.empresa_miembros WHERE usuario_id = v_usuario;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'sin_empresa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Un lector no lanza agentes: no tiene Claudes que compartir.
  IF v_rango = 'lector' THEN
    RAISE EXCEPTION 'solo_lectura' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.grupos (empresa_id, nombre, creado_por)
  VALUES (v_empresa, btrim(p_nombre), v_usuario)
  RETURNING id INTO v_id;
  INSERT INTO public.grupo_miembros (grupo_id, usuario_id, rol) VALUES (v_id, v_usuario, 'dueño');
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crear_grupo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_grupo(TEXT) TO authenticated;

-- Corta si quien llama no es dueño del grupo.
CREATE OR REPLACE FUNCTION public._exigir_duenio_de_grupo(p_grupo UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID;
BEGIN
  SELECT g.empresa_id INTO v_empresa
    FROM public.grupos g
    JOIN public.grupo_miembros gm ON gm.grupo_id = g.id
   WHERE g.id = p_grupo AND gm.usuario_id = (SELECT auth.uid()) AND gm.rol = 'dueño';
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'solo_duenio_del_grupo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_empresa;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._exigir_duenio_de_grupo(UUID) FROM PUBLIC, anon, authenticated;

-- Sumar es directo, sin invitacion que aceptar: es gente de la MISMA empresa,
-- que ya entro por un alta. Compartir credenciales con alguien de afuera no se
-- puede por ningun camino.
CREATE OR REPLACE FUNCTION public.sumar_a_grupo(p_grupo UUID, p_usuario UUID)
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
  INSERT INTO public.grupo_miembros (grupo_id, usuario_id) VALUES (p_grupo, p_usuario)
  ON CONFLICT (grupo_id, usuario_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sumar_a_grupo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sumar_a_grupo(UUID, UUID) TO authenticated;

-- El dueño saca a cualquiera; cualquiera se puede ir solo. El dueño no se va:
-- borra el grupo.
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
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sacar_de_grupo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sacar_de_grupo(UUID, UUID) TO authenticated;

-- Los Claudes compartidos con el grupo vuelven a ser solo de su dueño
-- (ON DELETE SET NULL en agentes.grupo_id).
CREATE OR REPLACE FUNCTION public.borrar_grupo(p_grupo UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._exigir_duenio_de_grupo(p_grupo);
  DELETE FROM public.grupos WHERE id = p_grupo;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.borrar_grupo(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.borrar_grupo(UUID) TO authenticated;

-- Compartir (o dejar de compartir, con NULL) un Claude propio con un grupo
-- del que soy parte. Solo el dueño del Claude: son SUS credenciales.
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
  UPDATE public.agentes SET grupo_id = p_grupo WHERE slot = p_slot;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.compartir_claude(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compartir_claude(TEXT, UUID) TO authenticated;

-- Quien sale de la empresa sale tambien de sus grupos. Se redefine la de la
-- 040 agregando eso; sus Claudes quedan con dueño (nadie mas los usa, salvo
-- un grupo con el que los haya compartido, que el admin puede borrar).
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
  -- Sus Claudes tienen SU cuenta de Claude adentro: dejan de estar compartidos.
  UPDATE public.agentes SET grupo_id = NULL WHERE usuario_id = p_usuario;
  -- Los grupos que era dueño quedan sin dueño: se borran, y sus Claudes
  -- compartidos vuelven a ser solo de quien los creo.
  DELETE FROM public.grupos g
   WHERE g.empresa_id = p_empresa
     AND NOT EXISTS (SELECT 1 FROM public.grupo_miembros gm WHERE gm.grupo_id = g.id AND gm.rol = 'dueño');
  DELETE FROM public.empresa_miembros WHERE empresa_id = p_empresa AND usuario_id = p_usuario;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) TO authenticated;
