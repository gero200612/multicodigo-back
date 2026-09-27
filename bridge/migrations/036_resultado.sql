-- Como termino una tarea, dicho por el agente que la hizo.
--
-- Hasta ahora el cierre se deducia de que el turno contestara: cualquier
-- respuesta era `lista`. En AH (2026-09-27) el 40% de las `lista` no habian
-- avanzado nada: la mitad decia "ya estaba hecho" y la otra mitad "no pude,
-- falta un token". El informe las contaba como trabajo hecho y los analistas
-- volvian a encolar lo que estaba bloqueado.
--
-- Dos estados nuevos para la cola:
--   sin_cambios: no hacia falta tocar nada. Cierra la tarea, no es avance.
--   bloqueada:   hace falta algo que solo una persona puede dar.
--
-- La declaracion vive en el job del turno (la herramienta la manda con el
-- jobId) y el bridge la lee al cerrar la tarea.
--
-- Idempotente: se corre en cada arranque.
ALTER TABLE public.cola_tareas
  DROP CONSTRAINT IF EXISTS cola_estado_valido;

ALTER TABLE public.cola_tareas
  ADD CONSTRAINT cola_estado_valido
  CHECK (estado IN (
    'pendiente', 'corriendo', 'lista', 'fallida', 'cortada', 'cancelada',
    'sin_cambios', 'bloqueada'
  ));

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS resultado_declarado text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS motivo_declarado text;

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_resultado_valido;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_resultado_valido
  CHECK (resultado_declarado IS NULL
         OR resultado_declarado IN ('hecho', 'sin_cambios', 'bloqueada'));
