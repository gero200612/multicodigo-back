-- La cuenta con la que `mirar` entra a la app para sacar las capturas.
--
-- Sin esto, el agente entraba con "el usuario de prueba del proyecto" que
-- encontrara en el codigo: casi siempre una cuenta vacia (o ninguna), y el
-- analisis funcional salia con todas las pantallas sin datos, donde el cambio
-- no se nota. Ahora cada proyecto puede tener UNA cuenta con datos que alguien
-- con escritura carga desde el panel.
--
-- La contraseña la cifra el bridge (AES-256-GCM, src/cifrado.ts) y nunca pasa
-- por el modelo: el gateway la pide al bridge cuando el agente llama a `mirar`
-- sin login. RLS prendido y SIN policies: ningun cliente con JWT la lee.
CREATE TABLE IF NOT EXISTS public.cuentas_demo (
  proyecto_id       UUID PRIMARY KEY REFERENCES public.proyectos(id) ON DELETE CASCADE,
  ruta_login        TEXT NOT NULL DEFAULT '/login',
  usuario           TEXT NOT NULL,
  password_cifrada  TEXT NOT NULL,
  actualizado_por   UUID,
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cuentas_demo_ruta_valida CHECK (ruta_login ~ '^/[A-Za-z0-9._~/-]{0,99}$'),
  CONSTRAINT cuentas_demo_usuario_valido CHECK (length(usuario) BETWEEN 1 AND 200)
);

ALTER TABLE public.cuentas_demo ENABLE ROW LEVEL SECURITY;
