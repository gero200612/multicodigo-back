-- Lo que hace falta para publicar solo al cerrar una corrida.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-08-deploy-render-design.md`.
--
-- `creado_por_el_bot` existe porque `repos` no distinguia un repo que creo el
-- bot de uno que conecto una persona. Conviven con la misma forma:
--
--   propinas-back        Sincro-arg/propinas-back        <- lo creo el bot
--   multicodigo-back     gero200612/multicodigo-back     <- el repo de ESTE sistema
--
-- El merge automatico a main solo puede tocar los primeros. Sin esta columna la
-- feature no se puede hacer segura, y el default `false` es el lado correcto:
-- todo lo que ya existe queda afuera.
ALTER TABLE public.repos
  ADD COLUMN IF NOT EXISTS creado_por_el_bot BOOLEAN NOT NULL DEFAULT false;

-- El servicio ya creado. Es lo que da idempotencia: dos corridas sobre el mismo
-- proyecto no pueden dejar dos servicios facturando.
--
-- Se guarda aca y no se pregunta a Render porque preguntar significa buscar por
-- nombre, y un nombre repetido no dice si el servicio es de este proyecto o de
-- otro que se llamo igual.
ALTER TABLE public.repos
  ADD COLUMN IF NOT EXISTS render_service_id TEXT;
