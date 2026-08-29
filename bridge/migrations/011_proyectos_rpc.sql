-- Las escrituras que dependen de un rol: crear un proyecto, invitar y aceptar.
--
-- Las tres tocan `miembros`, que no tiene policy de INSERT a proposito: si
-- fuera escribible desde el navegador, cualquiera se agrega a cualquier
-- proyecto. La 008 decia que esas escrituras las hace "el panel con su propia
-- credencial", y esa credencial seria la `service_role`: una clave que puede
-- TODO sobre TODAS las tablas, viajando a Render y viviendo en el entorno de un
-- proceso que ademas habla con internet.
--
-- Esto lo resuelve sin esa clave. Cada operacion es una funcion SECURITY
-- DEFINER que hace su propio chequeo de permiso contra `auth.uid()` —o sea
-- contra el JWT del usuario, que ya viene verificado— y escribe solo lo que esa
-- operacion necesita. El panel las llama por RPC reenviando el JWT, igual que
-- todas sus otras lecturas. No hay ninguna credencial nueva en ningun lado.
--
-- `SET search_path = ''` en todas: sin eso, alguien que pueda crear un esquema
-- en el search_path del llamador secuestra los nombres sin calificar y la
-- funcion corre codigo suyo con los privilegios del definidor.

-- --- crear un proyecto -----------------------------------------------------

CREATE OR REPLACE FUNCTION public.crear_proyecto(p_nombre TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_id UUID;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'sin sesion' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- El CHECK de la tabla valida la forma del nombre: no se repite aca para no
  -- tener dos definiciones de "nombre valido" que se puedan separar.
  INSERT INTO public.proyectos (nombre) VALUES (p_nombre) RETURNING id INTO v_id;

  -- Lo que hace que esto sea una funcion y no dos consultas del cliente: crear
  -- el proyecto y quedar como dueño son una sola cosa. Un proyecto sin dueño no
  -- lo puede ver nadie —ni siquiera quien lo creo— y no habria forma de
  -- arreglarlo desde la aplicacion.
  INSERT INTO public.miembros (proyecto_id, usuario_id, rol)
  VALUES (v_id, v_usuario, 'dueño');

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crear_proyecto(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_proyecto(TEXT) TO authenticated;

-- --- el rol de alguien en un proyecto --------------------------------------

CREATE OR REPLACE FUNCTION public.mi_rol(p_proyecto UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT rol FROM public.miembros
  WHERE proyecto_id = p_proyecto AND usuario_id = (SELECT auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.mi_rol(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mi_rol(UUID) TO authenticated;

-- --- invitar ---------------------------------------------------------------

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
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_token TEXT;
BEGIN
  -- Invitar es de dueños. El panel lo chequea tambien, pero el chequeo que
  -- vale es este: es el que no se puede saltear llamando al RPC directo.
  IF NOT EXISTS (
    SELECT 1 FROM public.miembros
    WHERE proyecto_id = p_proyecto AND usuario_id = v_usuario AND rol = 'dueño'
  ) THEN
    RAISE EXCEPTION 'no sos dueño de ese proyecto' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_rol NOT IN ('dueño', 'miembro') THEN
    RAISE EXCEPTION 'rol invalido' USING ERRCODE = 'check_violation';
  END IF;

  -- El token va a viajar por fuera del sistema (se comparte a mano) y es lo
  -- unico que hace falta para entrar a un proyecto: tiene que ser imposible de
  -- adivinar. gen_random_uuid dos veces son 256 bits.
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.invitaciones (proyecto_id, email, rol, token, invitado_por, expira_en)
  VALUES (p_proyecto, lower(btrim(p_email)), p_rol, v_token, v_usuario, now() + (p_dias || ' days')::interval);

  RETURN v_token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invitar(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invitar(UUID, TEXT, TEXT, INT) TO authenticated;

-- --- aceptar una invitacion ------------------------------------------------

CREATE OR REPLACE FUNCTION public.aceptar_invitacion(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_usuario UUID := (SELECT auth.uid());
  v_inv public.invitaciones;
BEGIN
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'sin sesion' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- FOR UPDATE: dos aceptaciones simultaneas del mismo token no pueden pasar
  -- las dos por el chequeo de `aceptada_en`.
  SELECT * INTO v_inv FROM public.invitaciones
  WHERE token = p_token FOR UPDATE;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'invitacion desconocida' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.aceptada_en IS NOT NULL THEN
    RAISE EXCEPTION 'invitacion ya usada' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.expira_en <= now() THEN
    RAISE EXCEPTION 'invitacion vencida' USING ERRCODE = 'no_data_found';
  END IF;

  -- Sin ON CONFLICT DO NOTHING el que ya era miembro choca con la PK y ve un
  -- error de base de datos por hacer algo inocuo.
  INSERT INTO public.miembros (proyecto_id, usuario_id, rol)
  VALUES (v_inv.proyecto_id, v_usuario, v_inv.rol)
  ON CONFLICT (proyecto_id, usuario_id) DO NOTHING;

  UPDATE public.invitaciones SET aceptada_en = now() WHERE id = v_inv.id;

  RETURN v_inv.proyecto_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.aceptar_invitacion(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.aceptar_invitacion(TEXT) TO authenticated;
