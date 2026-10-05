-- Empresas, rangos y proyectos publicos/privados.
--
-- Spec: docs/superpowers/specs/2026-10-04-empresas-design.md
--
-- El producto pasa a venderse a empresas, y entre empresas el aislamiento es
-- total. Todo el control de acceso sigue pasando por UNA funcion
-- (`acceso_a_proyecto`), que usan las policies via `es_miembro` y
-- `puede_escribir`, y el bridge directo. Asi el panel y el bridge no pueden
-- aplicar reglas distintas.
--
-- Corre en CADA arranque, como todas: tiene que ser idempotente. Y corre
-- DESPUES de la 008 y la 011, que en cada arranque vuelven a definir
-- `es_miembro`, `crear_proyecto` y las policies con su version vieja: por eso
-- esta las vuelve a pisar siempre, no solo la primera vez.

-- --- tablas -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.empresas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  creada_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  creada_por UUID,

  CONSTRAINT empresas_nombre_no_vacio CHECK (length(btrim(nombre)) > 0),
  CONSTRAINT empresas_slug_forma CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$')
);

-- `usuario_id` UNIQUE: cada persona es de UNA sola empresa. Es lo que hace
-- que "de que empresa sos" tenga una sola respuesta.
CREATE TABLE IF NOT EXISTS public.empresa_miembros (
  empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL UNIQUE,
  rango      TEXT NOT NULL,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (empresa_id, usuario_id),
  CONSTRAINT empresa_miembros_rango_valido CHECK (rango IN ('admin', 'programador', 'lector'))
);

-- Sin policies a proposito: con RLS prendido y ninguna policy, nadie la lee
-- ni la escribe desde el navegador. Se carga desde la base.
CREATE TABLE IF NOT EXISTS public.superadmins (
  usuario_id UUID PRIMARY KEY,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.proyectos ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES public.empresas(id);
ALTER TABLE public.proyectos ADD COLUMN IF NOT EXISTS visibilidad TEXT NOT NULL DEFAULT 'privado';

CREATE INDEX IF NOT EXISTS proyectos_empresa_idx ON public.proyectos (empresa_id);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proyectos_visibilidad_valida') THEN
    ALTER TABLE public.proyectos
      ADD CONSTRAINT proyectos_visibilidad_valida CHECK (visibilidad IN ('publico', 'privado'));
  END IF;
END
$do$;

-- Las invitaciones sirven ahora tambien para el ALTA: una fila con empresa y
-- rango, sin proyecto. El `email` es el usuario ya completado
-- (`pedro@multicodigo.app`) y `usuario` lo que escribio el admin.
ALTER TABLE public.invitaciones ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES public.empresas(id) ON DELETE CASCADE;
ALTER TABLE public.invitaciones ADD COLUMN IF NOT EXISTS rango TEXT;
ALTER TABLE public.invitaciones ADD COLUMN IF NOT EXISTS usuario TEXT;
ALTER TABLE public.invitaciones ALTER COLUMN proyecto_id DROP NOT NULL;
ALTER TABLE public.invitaciones ALTER COLUMN rol DROP NOT NULL;

CREATE INDEX IF NOT EXISTS invitaciones_empresa_idx ON public.invitaciones (empresa_id);

DO $do$
BEGIN
  -- El CHECK viejo pedia un rol siempre; un alta no tiene rol de proyecto.
  ALTER TABLE public.invitaciones DROP CONSTRAINT IF EXISTS invitaciones_rol_valido;
  ALTER TABLE public.invitaciones
    ADD CONSTRAINT invitaciones_rol_valido CHECK (rol IS NULL OR rol IN ('dueño', 'miembro'));

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitaciones_tipo') THEN
    ALTER TABLE public.invitaciones ADD CONSTRAINT invitaciones_tipo CHECK (
      (proyecto_id IS NOT NULL AND rol IS NOT NULL)
      OR (empresa_id IS NOT NULL AND rango IN ('admin', 'programador', 'lector'))
    );
  END IF;
END
$do$;

-- --- la migracion de lo que ya habia (una sola vez) -------------------------
--
-- Todo lo de hoy pasa a una empresa inicial. Nadie gana ni pierde acceso: los
-- proyectos quedan privados con sus asignaciones, los dueños pasan a admin y el
-- resto a programador. Va adentro del IF para que una persona que despues se
-- saque de la empresa no vuelva a entrar en el proximo arranque.

DO $do$
DECLARE
  v_empresa UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE slug = 'multicodigo') THEN
    INSERT INTO public.empresas (nombre, slug) VALUES ('MultiCodigo', 'multicodigo')
    RETURNING id INTO v_empresa;

    UPDATE public.proyectos SET empresa_id = v_empresa WHERE empresa_id IS NULL;

    INSERT INTO public.empresa_miembros (empresa_id, usuario_id, rango)
    SELECT v_empresa, m.usuario_id,
           CASE WHEN bool_or(m.rol = 'dueño') THEN 'admin' ELSE 'programador' END
      FROM public.miembros m
     GROUP BY m.usuario_id
    ON CONFLICT (usuario_id) DO NOTHING;

    INSERT INTO public.superadmins (usuario_id)
    SELECT id FROM auth.users WHERE lower(email) = 'gero200612@gmail.com'
    ON CONFLICT (usuario_id) DO NOTHING;

    -- El superadmin tambien es de la empresa inicial: es la suya.
    INSERT INTO public.empresa_miembros (empresa_id, usuario_id, rango)
    SELECT v_empresa, s.usuario_id, 'admin' FROM public.superadmins s
    ON CONFLICT (usuario_id) DO NOTHING;
  END IF;
END
$do$;

-- Un proyecto sin empresa puede aparecer si el bridge viejo vuelve por un
-- rollback y crea uno. Va a la empresa de su dueño, o a la inicial. Corre
-- siempre: sin esto el NOT NULL de abajo frenaria el arranque.
UPDATE public.proyectos p
   SET empresa_id = COALESCE(
         (SELECT em.empresa_id
            FROM public.miembros m
            JOIN public.empresa_miembros em ON em.usuario_id = m.usuario_id
           WHERE m.proyecto_id = p.id AND m.rol = 'dueño'
           LIMIT 1),
         (SELECT id FROM public.empresas WHERE slug = 'multicodigo'))
 WHERE p.empresa_id IS NULL;

ALTER TABLE public.proyectos ALTER COLUMN empresa_id SET NOT NULL;

-- --- RLS de las tablas nuevas -----------------------------------------------

ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.empresa_miembros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.superadmins ENABLE ROW LEVEL SECURITY;

-- --- la funcion central -----------------------------------------------------

-- 'escribir', 'ver' o NULL. Es LA regla de quien ve que; todo lo demas la usa.
--
-- Sin EXECUTE para `authenticated`: recibe un usuario cualquiera, y dejarla
-- abierta le permitiria a alguien preguntar a que proyectos tiene acceso otra
-- persona. La llaman `es_miembro`/`puede_escribir` (con `auth.uid()`) y el
-- bridge, que entra como `postgres`.
CREATE OR REPLACE FUNCTION public.acceso_a_proyecto(p_usuario UUID, p_proyecto UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID;
  v_visibilidad TEXT;
  v_rango TEXT;
BEGIN
  IF p_usuario IS NULL OR p_proyecto IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT empresa_id, visibilidad INTO v_empresa, v_visibilidad
    FROM public.proyectos WHERE id = p_proyecto;
  IF v_empresa IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.superadmins WHERE usuario_id = p_usuario) THEN
    RETURN 'escribir';
  END IF;

  -- El aislamiento entre empresas es esta linea: sin rango en LA empresa del
  -- proyecto, no hay nada, este asignado o no.
  SELECT rango INTO v_rango
    FROM public.empresa_miembros
   WHERE empresa_id = v_empresa AND usuario_id = p_usuario;
  IF v_rango IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_rango = 'admin' THEN
    RETURN 'escribir';
  END IF;

  IF v_visibilidad <> 'publico' AND NOT EXISTS (
    SELECT 1 FROM public.miembros WHERE proyecto_id = p_proyecto AND usuario_id = p_usuario
  ) THEN
    RETURN NULL;
  END IF;

  IF v_rango = 'lector' THEN
    RETURN 'ver';
  END IF;
  RETURN 'escribir';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.acceso_a_proyecto(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- La misma firma que la 008, para que las ~17 policies que la usan sigan
-- andando sin tocarlas. Ahora significa "puede VER".
CREATE OR REPLACE FUNCTION public.es_miembro(p_proyecto UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.acceso_a_proyecto((SELECT auth.uid()), p_proyecto) IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION public.es_miembro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_miembro(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.puede_escribir(p_proyecto UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.acceso_a_proyecto((SELECT auth.uid()), p_proyecto) = 'escribir';
$$;

REVOKE EXECUTE ON FUNCTION public.puede_escribir(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_escribir(UUID) TO authenticated;

-- --- las policies de escritura: de es_miembro a puede_escribir ---------------
--
-- Se recorren todas y no una lista a mano: varias tablas (repos, documentos,
-- storage) se crearon desde `docs/` y no viven en estas migraciones. Una
-- policy de escritura que siguiera con `es_miembro` dejaria escribir a un
-- lector. FOR ALL no se toca: tambien cubre las lecturas, y pasarla a
-- puede_escribir le sacaria la vista al lector.

DO $do$
DECLARE
  r RECORD;
  v_using TEXT;
  v_check TEXT;
  v_roles TEXT;
  v_sql TEXT;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
     WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE')
       AND (COALESCE(qual, '') ~ 'es_miembro\(' OR COALESCE(with_check, '') ~ 'es_miembro\(')
  LOOP
    v_using := regexp_replace(r.qual, '(public\.)?es_miembro\(', 'public.puede_escribir(', 'g');
    v_check := regexp_replace(r.with_check, '(public\.)?es_miembro\(', 'public.puede_escribir(', 'g');
    SELECT string_agg(CASE WHEN x = 'public' THEN 'public' ELSE quote_ident(x) END, ', ')
      INTO v_roles FROM unnest(r.roles) AS x;

    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    v_sql := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
                    r.policyname, r.schemaname, r.tablename, r.permissive, r.cmd, v_roles);
    IF v_using IS NOT NULL THEN
      v_sql := v_sql || ' USING (' || v_using || ')';
    END IF;
    IF v_check IS NOT NULL THEN
      v_sql := v_sql || ' WITH CHECK (' || v_check || ')';
    END IF;
    EXECUTE v_sql;
  END LOOP;
END
$do$;

-- La 008 deja crear proyectos a cualquiera por REST directo. Ahora crear es de
-- admins y pasa por `crear_proyecto_en_empresa`.
DROP POLICY IF EXISTS "proyectos: crear" ON public.proyectos;

-- "proyectos: editar los mios" deja a quien puede escribir hacer UPDATE por
-- REST, y su chequeo mira el `id`, que no cambia. Sin esto, un programador
-- haria publico un privado, o se llevaria el proyecto a OTRA empresa
-- cambiando `empresa_id`. Un trigger y no columnas en el GRANT: el chequeo de
-- la visibilidad depende de QUIEN la cambia.
--
-- Sin `auth.uid()` es el bridge (que entra como `postgres`) o una migracion:
-- esos pasan.
CREATE OR REPLACE FUNCTION public._proteger_proyecto()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  IF v_usuario IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.empresa_id IS DISTINCT FROM OLD.empresa_id THEN
    RAISE EXCEPTION 'no_se_cambia_de_empresa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.visibilidad IS DISTINCT FROM OLD.visibilidad
     AND NOT public._es_superadmin(v_usuario)
     AND NOT EXISTS (
       SELECT 1 FROM public.empresa_miembros
        WHERE empresa_id = OLD.empresa_id AND usuario_id = v_usuario AND rango = 'admin'
     ) THEN
    RAISE EXCEPTION 'solo_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proyectos_proteger ON public.proyectos;
CREATE TRIGGER proyectos_proteger
  BEFORE UPDATE ON public.proyectos
  FOR EACH ROW EXECUTE FUNCTION public._proteger_proyecto();

-- Permisos por COLUMNA sobre proyectos, para el navegador.
--
-- `db_conexion` es la connection string (con contraseña) de la base del
-- proyecto: se guarda del lado del servidor para que la lea `publicar()`, y
-- por REST la leia cualquier miembro —ahora tambien un lector—. `tareas` son
-- comandos que corre el gateway: si se pudieran escribir por REST, cualquiera
-- que escriba en el proyecto elegiria que se ejecuta.
--
-- Nadie escribe proyectos por REST: crear, cambiar visibilidad y asignar van
-- por funciones, y lo demas lo escribe el bridge como `postgres`. Una columna
-- nueva NO queda legible sola: hay que sumarla aca a proposito.
REVOKE INSERT, UPDATE, DELETE ON public.proyectos FROM anon, authenticated;
REVOKE SELECT ON public.proyectos FROM anon, authenticated;
GRANT SELECT (id, nombre, repo_url, creado_en, empresa_id, visibilidad)
  ON public.proyectos TO authenticated;

-- --- lecturas de las tablas nuevas ------------------------------------------

DROP POLICY IF EXISTS "empresas: leer la mia" ON public.empresas;
CREATE POLICY "empresas: leer la mia" ON public.empresas
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT empresa_id FROM public.empresa_miembros WHERE usuario_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.superadmins WHERE usuario_id = (SELECT auth.uid()))
  );

-- Solo la fila propia. La lista de la gente de la empresa sale de
-- `gente_de_empresa`, que chequea que seas admin.
DROP POLICY IF EXISTS "empresa_miembros: leer la mia" ON public.empresa_miembros;
CREATE POLICY "empresa_miembros: leer la mia" ON public.empresa_miembros
  FOR SELECT TO authenticated
  USING (usuario_id = (SELECT auth.uid()));

-- --- ayudantes de las funciones de abajo ------------------------------------

CREATE OR REPLACE FUNCTION public._es_superadmin(p_usuario UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.superadmins WHERE usuario_id = p_usuario);
$$;

REVOKE EXECUTE ON FUNCTION public._es_superadmin(UUID) FROM PUBLIC, anon, authenticated;

-- Corta con 42501 (que PostgREST devuelve como 403) si quien llama no es
-- admin de esa empresa ni superadmin.
CREATE OR REPLACE FUNCTION public._exigir_admin(p_empresa UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'sin sesion' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF public._es_superadmin(v_usuario) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.empresa_miembros
     WHERE empresa_id = p_empresa AND usuario_id = v_usuario AND rango = 'admin'
  ) THEN
    RAISE EXCEPTION 'solo_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._exigir_admin(UUID) FROM PUBLIC, anon, authenticated;

-- `pedro` -> `pedro@multicodigo.app`. Mismo dominio que `aEmail` del front:
-- tienen que coincidir o el alta crea una cuenta con la que despues no se
-- puede entrar.
--
-- Solo nombres de usuario, NUNCA un mail completo: con un mail, el admin de
-- cualquier empresa podria crear la cuenta de `alguien@gmail.com` antes que
-- esa persona y quedarse con su direccion. El dominio interno no es de nadie.
CREATE OR REPLACE FUNCTION public._email_de_usuario(p_usuario TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v TEXT := lower(btrim(COALESCE(p_usuario, '')));
BEGIN
  IF v !~ '^[a-z0-9][a-z0-9._-]{1,39}$' THEN
    RAISE EXCEPTION 'usuario_invalido' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v || '@multicodigo.app';
END;
$$;

REVOKE EXECUTE ON FUNCTION public._email_de_usuario(TEXT) FROM PUBLIC, anon, authenticated;

-- 256 bits: el token viaja por WhatsApp y es lo unico que hace falta para
-- crear una cuenta adentro de una empresa.
CREATE OR REPLACE FUNCTION public._token_nuevo()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

REVOKE EXECUTE ON FUNCTION public._token_nuevo() FROM PUBLIC, anon, authenticated;

-- --- quien soy --------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mi_perfil()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'empresa_id', e.id,
    'empresa', e.nombre,
    'slug', e.slug,
    'rango', em.rango,
    'superadmin', public._es_superadmin((SELECT auth.uid()))
  )
  FROM (SELECT 1) AS uno
  LEFT JOIN public.empresa_miembros em ON em.usuario_id = (SELECT auth.uid())
  LEFT JOIN public.empresas e ON e.id = em.empresa_id;
$$;

REVOKE EXECUTE ON FUNCTION public.mi_perfil() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_perfil() TO authenticated;

-- --- plataforma (superadmin) ------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_alta(
  p_empresa UUID,
  p_usuario TEXT,
  p_rango TEXT,
  p_dias INT DEFAULT 7
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT;
  v_token TEXT;
BEGIN
  PERFORM public._exigir_admin(p_empresa);

  IF p_rango NOT IN ('admin', 'programador', 'lector') THEN
    RAISE EXCEPTION 'rango_invalido' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.empresas WHERE id = p_empresa) THEN
    RAISE EXCEPTION 'empresa_desconocida' USING ERRCODE = 'no_data_found';
  END IF;

  v_email := public._email_de_usuario(p_usuario);

  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'usuario_existe' USING ERRCODE = 'unique_violation';
  END IF;
  -- Dos altas vigentes para el mismo usuario terminarian en una que falla al
  -- usarse; mejor decirlo ahora.
  IF EXISTS (
    SELECT 1 FROM public.invitaciones
     WHERE empresa_id IS NOT NULL AND email = v_email
       AND aceptada_en IS NULL AND expira_en > now()
  ) THEN
    RAISE EXCEPTION 'alta_pendiente' USING ERRCODE = 'unique_violation';
  END IF;

  v_token := public._token_nuevo();
  INSERT INTO public.invitaciones
    (empresa_id, email, usuario, rango, token, invitado_por, expira_en)
  VALUES
    (p_empresa, v_email, lower(btrim(p_usuario)), p_rango, v_token,
     (SELECT auth.uid()), now() + make_interval(days => GREATEST(1, LEAST(p_dias, 30))));

  RETURN v_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crear_alta(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_alta(UUID, TEXT, TEXT, INT) TO authenticated;

-- Crea la empresa y el alta de su primer admin en una sola operacion: una
-- empresa sin nadie adentro no la puede administrar nadie mas que vos.
CREATE OR REPLACE FUNCTION public.crear_empresa(p_nombre TEXT, p_slug TEXT, p_usuario_admin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_id UUID;
BEGIN
  IF NOT public._es_superadmin(v_usuario) THEN
    RAISE EXCEPTION 'solo_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.empresas (nombre, slug, creada_por)
  VALUES (btrim(p_nombre), lower(btrim(p_slug)), v_usuario)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'empresa_id', v_id,
    'token', public.crear_alta(v_id, p_usuario_admin, 'admin')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crear_empresa(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_empresa(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.empresas_resumen()
RETURNS TABLE (id UUID, nombre TEXT, slug TEXT, creada_en TIMESTAMPTZ, personas INT, proyectos INT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public._es_superadmin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'solo_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT e.id, e.nombre, e.slug, e.creada_en,
           (SELECT count(*)::int FROM public.empresa_miembros em WHERE em.empresa_id = e.id),
           (SELECT count(*)::int FROM public.proyectos p WHERE p.empresa_id = e.id)
      FROM public.empresas e
     ORDER BY e.nombre;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.empresas_resumen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.empresas_resumen() TO authenticated;

-- --- la gente de una empresa (admin) ----------------------------------------

CREATE OR REPLACE FUNCTION public.gente_de_empresa(p_empresa UUID)
RETURNS TABLE (usuario_id UUID, email TEXT, rango TEXT, creado_en TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._exigir_admin(p_empresa);
  RETURN QUERY
    SELECT em.usuario_id, u.email::text, em.rango, em.creado_en
      FROM public.empresa_miembros em
      LEFT JOIN auth.users u ON u.id = em.usuario_id
     WHERE em.empresa_id = p_empresa
     ORDER BY u.email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.gente_de_empresa(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gente_de_empresa(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.altas_pendientes(p_empresa UUID)
RETURNS TABLE (token TEXT, usuario TEXT, rango TEXT, creado_en TIMESTAMPTZ, expira_en TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._exigir_admin(p_empresa);
  RETURN QUERY
    SELECT i.token, i.usuario, i.rango, i.creado_en, i.expira_en
      FROM public.invitaciones i
     WHERE i.empresa_id = p_empresa AND i.aceptada_en IS NULL AND i.expira_en > now()
     ORDER BY i.creado_en DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.altas_pendientes(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.altas_pendientes(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.revocar_alta(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID;
BEGIN
  SELECT empresa_id INTO v_empresa FROM public.invitaciones
   WHERE token = p_token AND empresa_id IS NOT NULL AND aceptada_en IS NULL;
  IF v_empresa IS NULL THEN
    RETURN;
  END IF;
  PERFORM public._exigir_admin(v_empresa);
  DELETE FROM public.invitaciones WHERE token = p_token AND aceptada_en IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revocar_alta(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revocar_alta(TEXT) TO authenticated;

-- Una empresa nunca se queda sin admin: es la unica forma de que alguien de
-- adentro pueda volver a dar altas.
CREATE OR REPLACE FUNCTION public._quedan_admins(p_empresa UUID, p_sin UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.empresa_miembros
     WHERE empresa_id = p_empresa AND rango = 'admin' AND usuario_id <> p_sin
  );
$$;

REVOKE EXECUTE ON FUNCTION public._quedan_admins(UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cambiar_rango(p_empresa UUID, p_usuario UUID, p_rango TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actual TEXT;
BEGIN
  PERFORM public._exigir_admin(p_empresa);
  IF p_rango NOT IN ('admin', 'programador', 'lector') THEN
    RAISE EXCEPTION 'rango_invalido' USING ERRCODE = 'check_violation';
  END IF;
  SELECT rango INTO v_actual FROM public.empresa_miembros
   WHERE empresa_id = p_empresa AND usuario_id = p_usuario FOR UPDATE;
  IF v_actual IS NULL THEN
    RAISE EXCEPTION 'no_es_de_la_empresa' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_actual = 'admin' AND p_rango <> 'admin' AND NOT public._quedan_admins(p_empresa, p_usuario) THEN
    RAISE EXCEPTION 'ultimo_admin' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.empresa_miembros SET rango = p_rango
   WHERE empresa_id = p_empresa AND usuario_id = p_usuario;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cambiar_rango(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cambiar_rango(UUID, UUID, TEXT) TO authenticated;

-- Saca a la persona de la empresa y de todos sus proyectos. La cuenta de Auth
-- queda (no se borra gente): sin empresa no ve nada.
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
  DELETE FROM public.empresa_miembros WHERE empresa_id = p_empresa AND usuario_id = p_usuario;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quitar_de_empresa(UUID, UUID) TO authenticated;

-- --- el alta, del lado de quien la recibe -----------------------------------

-- Para la pantalla de alta, que se abre SIN sesion: por eso va a `anon`. De un
-- token vencido, usado o inventado no dice nada, ni cual de las tres.
CREATE OR REPLACE FUNCTION public.ver_alta(p_token TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('empresa', e.nombre, 'usuario', i.usuario, 'rango', i.rango)
    FROM public.invitaciones i
    JOIN public.empresas e ON e.id = i.empresa_id
   WHERE i.token = p_token AND i.aceptada_en IS NULL AND i.expira_en > now();
$$;

REVOKE EXECUTE ON FUNCTION public.ver_alta(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ver_alta(TEXT) TO anon, authenticated;

-- --- proyectos ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_proyecto_en_empresa(
  p_nombre TEXT,
  p_visibilidad TEXT DEFAULT 'privado',
  p_empresa UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_empresa UUID := p_empresa;
  v_id UUID;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'sin sesion' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_empresa IS NULL THEN
    SELECT empresa_id INTO v_empresa FROM public.empresa_miembros WHERE usuario_id = v_usuario;
  END IF;
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'sin_empresa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public._exigir_admin(v_empresa);

  IF p_visibilidad NOT IN ('publico', 'privado') THEN
    RAISE EXCEPTION 'visibilidad_invalida' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.proyectos (nombre, empresa_id, visibilidad)
  VALUES (p_nombre, v_empresa, p_visibilidad)
  RETURNING id INTO v_id;

  -- Quien lo crea queda de dueño: el despliegue publica con las cuentas del
  -- dueño del proyecto.
  INSERT INTO public.miembros (proyecto_id, usuario_id, rol)
  VALUES (v_id, v_usuario, 'dueño');

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crear_proyecto_en_empresa(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_proyecto_en_empresa(TEXT, TEXT, UUID) TO authenticated;

-- La firma de la 011, que la vuelve a crear en cada arranque. Se pisa para
-- que un panel viejo tambien pase por la regla nueva.
CREATE OR REPLACE FUNCTION public.crear_proyecto(p_nombre TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.crear_proyecto_en_empresa(p_nombre, 'privado', NULL);
$$;

REVOKE EXECUTE ON FUNCTION public.crear_proyecto(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_proyecto(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public._empresa_de_proyecto(p_proyecto UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT empresa_id FROM public.proyectos WHERE id = p_proyecto;
$$;

REVOKE EXECUTE ON FUNCTION public._empresa_de_proyecto(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cambiar_visibilidad(p_proyecto UUID, p_visibilidad TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID := public._empresa_de_proyecto(p_proyecto);
BEGIN
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'proyecto_desconocido' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public._exigir_admin(v_empresa);
  IF p_visibilidad NOT IN ('publico', 'privado') THEN
    RAISE EXCEPTION 'visibilidad_invalida' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.proyectos SET visibilidad = p_visibilidad WHERE id = p_proyecto;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cambiar_visibilidad(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cambiar_visibilidad(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.asignar(p_proyecto UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID := public._empresa_de_proyecto(p_proyecto);
BEGIN
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'proyecto_desconocido' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public._exigir_admin(v_empresa);
  -- Solo gente de la MISMA empresa: asignar es la unica puerta a un privado, y
  -- por aca no puede entrar alguien de afuera.
  IF NOT EXISTS (
    SELECT 1 FROM public.empresa_miembros WHERE empresa_id = v_empresa AND usuario_id = p_usuario
  ) THEN
    RAISE EXCEPTION 'no_es_de_la_empresa' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.miembros (proyecto_id, usuario_id, rol)
  VALUES (p_proyecto, p_usuario, 'miembro')
  ON CONFLICT (proyecto_id, usuario_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.asignar(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.asignar(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.desasignar(p_proyecto UUID, p_usuario UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID := public._empresa_de_proyecto(p_proyecto);
BEGIN
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'proyecto_desconocido' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public._exigir_admin(v_empresa);
  -- El dueño no se saca: el despliegue publica con sus cuentas.
  DELETE FROM public.miembros
   WHERE proyecto_id = p_proyecto AND usuario_id = p_usuario AND rol <> 'dueño';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.desasignar(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desasignar(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.asignados(p_proyecto UUID)
RETURNS TABLE (usuario_id UUID, email TEXT, rol TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_empresa UUID := public._empresa_de_proyecto(p_proyecto);
BEGIN
  IF v_empresa IS NULL THEN
    RAISE EXCEPTION 'proyecto_desconocido' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public._exigir_admin(v_empresa);
  RETURN QUERY
    SELECT m.usuario_id, u.email::text, m.rol
      FROM public.miembros m
      LEFT JOIN auth.users u ON u.id = m.usuario_id
     WHERE m.proyecto_id = p_proyecto
     ORDER BY u.email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.asignados(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.asignados(UUID) TO authenticated;

-- --- lo viejo de la 011, con la regla nueva ---------------------------------

-- `mi_rol` lo usa el panel para decidir si alguien puede invitar. Ahora
-- "dueño" es ser admin de la empresa del proyecto.
CREATE OR REPLACE FUNCTION public.mi_rol(p_proyecto UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_empresa UUID := public._empresa_de_proyecto(p_proyecto);
BEGIN
  IF public.acceso_a_proyecto(v_usuario, p_proyecto) IS NULL THEN
    RETURN NULL;
  END IF;
  IF public._es_superadmin(v_usuario) OR EXISTS (
    SELECT 1 FROM public.empresa_miembros
     WHERE empresa_id = v_empresa AND usuario_id = v_usuario AND rango = 'admin'
  ) THEN
    RETURN 'dueño';
  END IF;
  RETURN 'miembro';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mi_rol(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_rol(UUID) TO authenticated;

-- Las invitaciones por proyecto quedan cerradas: la gente entra por alta y se
-- asigna con `asignar`. Una invitacion vieja podria meter a alguien de OTRA
-- empresa a un proyecto, que es justo lo que no puede pasar.
CREATE OR REPLACE FUNCTION public.invitar(
  p_proyecto UUID,
  p_email TEXT,
  p_rol TEXT,
  p_dias INT DEFAULT 7
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'usar_altas' USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invitar(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invitar(UUID, TEXT, TEXT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.aceptar_invitacion(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'usar_altas' USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.aceptar_invitacion(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aceptar_invitacion(TEXT) TO authenticated;

-- --- decidir una aprobacion -------------------------------------------------

-- El panel la consulta antes de mandar la decision al bridge. Aprobar es
-- escribir: deja al agente tocar el repo. Un lector ve las aprobaciones (RLS)
-- pero no las decide.
CREATE OR REPLACE FUNCTION public.puede_decidir(p_aprobacion UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT public.acceso_a_proyecto((SELECT auth.uid()), a.proyecto_id) = 'escribir'
       FROM public.approvals a WHERE a.approval_id = p_aprobacion),
    false);
$$;

REVOKE EXECUTE ON FUNCTION public.puede_decidir(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.puede_decidir(UUID) TO authenticated;
