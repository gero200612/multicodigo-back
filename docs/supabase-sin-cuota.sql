-- Hasta cuando un slot se quedo sin cuota de Claude.
--
-- Aplicado el 2026-09-01. No hay migraciones versionadas contra Supabase en este
-- repo, asi que esto queda como el registro de lo que hay que correr.
--
-- **Por que una columna y no el historial de tests.** El resultado de un test ya
-- se guarda en `test_runs`, y quedarse sin cuota podria escribirse ahi como un
-- fallo mas. No alcanza por dos razones: el estado tiene que sobrevivir a que
-- nadie vuelva a probar —"sin cuota" es cierto hasta las 19:50 aunque no toques
-- nada— y hay que poder saber HASTA CUANDO sin leer un texto libre. Con la hora
-- en una columna, el panel puede decir "vuelve a las 19:50" y el bridge puede
-- saltear ese slot al elegir a quien relevar.
--
-- NULL significa "tiene cuota", que es el caso normal: la columna solo se llena
-- cuando un turno falla con `usage_limit`.

alter table public.agentes
  add column if not exists sin_cuota_hasta timestamptz;

comment on column public.agentes.sin_cuota_hasta is
  'Hasta cuando la cuenta de este slot no tiene cuota. NULL = tiene. Lo escribe '
  'el panel cuando un turno falla con usage_limit; se limpia solo al pasar la '
  'hora o en el primer test que funcione.';

-- Las policies de `agentes` ya cubren esta columna: son por tabla, no por
-- columna, y RLS filtra por membresia igual que antes. No hace falta tocarlas.
