-- Las cuentas de Claude vuelven a ser un fondo comun de todos los bots.
--
-- La 038 agrego `agentes.bot` para decir "esta cuenta es de Homero (o de
-- Patan)" y que Punchi no la usara: dos procesos con la misma credencial se
-- pisaban el refresh token. Desde 2026-10-07 el unico proceso que usa
-- credenciales es el gateway —Homero le pide turnos como cualquiera—, asi que
-- no hay cuentas de un bot ni nada que separar. Todas las filas valian
-- 'punchi' y nada lee la columna: se borra entera, con su CHECK.
--
-- La 038 quedo vacia en vez de borrarse: las migraciones corren TODAS en cada
-- arranque, y si siguiera agregando la columna esta la volveria a sacar cada vez.
ALTER TABLE public.agentes DROP CONSTRAINT IF EXISTS agentes_bot_valido;
ALTER TABLE public.agentes DROP COLUMN IF EXISTS bot;
