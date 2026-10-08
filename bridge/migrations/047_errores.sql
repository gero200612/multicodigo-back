-- El registro de errores del servidor.
--
-- El 2026-10-08 el Ticket de Punchi fallo durante horas con "El servidor no
-- esta respondiendo" y el servidor andaba: el bridge y el gateway rechazaban el
-- turno por tener mas de 50 documentos. Encontrarlo fue entrar por SSH a leer
-- `docker logs` de tres servicios. Esta tabla es donde queda cada falla, con su
-- contexto, para verla en la pantalla de Errores y mandarla a arreglar.
--
-- Escribe SOLO el bridge (los demas servicios le reportan por
-- `POST /interno/errores`): RLS prendido y SIN policies, como
-- `conexiones_despliegue`. El `detalle` puede traer stacks y rutas internas, y
-- ningun cliente con JWT tiene por que leerlo directo por PostgREST.
--
-- `huella` = `servicio|codigo|<lo que distingue>`: el mismo bug repetido es una
-- sola fila que suma `veces`. El indice unico es PARCIAL a proposito: un error
-- ya `publicado` o `descartado` que vuelve a pasar abre una fila nueva, porque
-- eso quiere decir que el arreglo no anduvo y hay que verlo.
--
-- Idempotente: las migraciones corren TODAS en cada arranque del bridge.
CREATE TABLE IF NOT EXISTS public.errores (
  id          BIGSERIAL PRIMARY KEY,
  huella      TEXT NOT NULL,
  servicio    TEXT NOT NULL,
  codigo      TEXT NOT NULL,
  mensaje     TEXT NOT NULL,
  detalle     JSONB NOT NULL DEFAULT '{}'::jsonb,
  proyecto_id UUID,
  usuario_id  UUID,
  veces       INT NOT NULL DEFAULT 1,
  primera     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- nuevo | arreglando | en_rama | publicado | descartado
  estado      TEXT NOT NULL DEFAULT 'nuevo'
              CHECK (estado IN ('nuevo', 'arreglando', 'en_rama', 'publicado', 'descartado')),
  -- job, agente, resumen, ramas, error del arreglo
  arreglo     JSONB
);
ALTER TABLE public.errores ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS errores_huella_abierta ON public.errores (huella)
  WHERE estado IN ('nuevo', 'arreglando', 'en_rama');
-- La pantalla lista por `ultima` desc, filtrando por estado.
CREATE INDEX IF NOT EXISTS errores_ultima ON public.errores (ultima DESC);
