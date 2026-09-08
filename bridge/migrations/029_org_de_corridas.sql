-- En que organizacion de GitHub nacen los repos de las corridas.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Nace de una critica al diseño anterior, y es correcta: la org se puso como
-- una OPCION del comando (`/corrida proyecto=x org=y`) para resolver "hay
-- varias cuentas conectadas". Pero eso no es un dato del pedido, es
-- configuracion: no cambia entre una corrida y la siguiente, y escribirla cada
-- vez es un lugar mas donde equivocarse.
--
-- Ahora se pregunta UNA vez —con botones, no escribiendola— y queda guardada.
--
-- Del USUARIO y no del chat: es una decision sobre donde va el codigo de sus
-- clientes, y sigue valiendo si cambia de telefono o suma otro chat. El modo de
-- permisos, en cambio, es del chat, porque es una preferencia de comodidad de
-- quien lee las preguntas.
CREATE TABLE IF NOT EXISTS public.org_de_corridas (
  usuario_id  UUID PRIMARY KEY,
  -- El nombre de la cuenta de GitHub, como lo devuelve la API ("Sincro-arg").
  -- Se guarda el nombre y no el installation_id porque la instalacion se puede
  -- reinstalar —y cambia de id— mientras la org sigue siendo la misma.
  cuenta      TEXT NOT NULL,
  cambiado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT org_cuenta_no_vacia CHECK (length(btrim(cuenta)) > 0)
);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.org_de_corridas ENABLE ROW LEVEL SECURITY;
