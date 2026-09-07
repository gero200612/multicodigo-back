-- El borrador de una corrida: el paso a paso antes de arrancar.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Nace de que abrir una corrida pedia un comando de cinco opciones que hay que
-- escribir bien de una: nombre del proyecto, org, los dos repos y las dos
-- referencias. Un dedazo en el medio y el comando entero se pierde. Ahora se
-- pregunta de a una cosa.
--
-- Tabla propia y NO un estado mas en `corridas`: esto es el estado de una
-- CONVERSACION, no de una corrida. Meterlo ahi obligaria a que `corridaAbierta`
-- —que la usa el ciclo en cada vuelta— filtre un estado que no le importa, y a
-- que los CHECK de cierre contemplen filas que nunca se van a cerrar.
--
-- Muere cuando la corrida se abre. Si alguien abandona a mitad, queda una fila
-- por chat que el proximo /corrida pisa.
CREATE TABLE IF NOT EXISTS public.corrida_borrador (
  chat_id    BIGINT PRIMARY KEY,
  -- En que paso quedo la conversacion.
  paso       TEXT NOT NULL,
  -- El nombre que se dicto en el paso 1. Nulo mientras se lo esta pidiendo.
  proyecto   TEXT,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT borrador_paso_valido CHECK (paso IN ('nombre', 'pliego'))
);

-- Sin policies: la escribe el bridge, que es `postgres`.
ALTER TABLE public.corrida_borrador ENABLE ROW LEVEL SECURITY;
