-- El fixture de los tests de RLS.
--
-- Lo consume `bridge/test/rls.test.ts`, que es el unico test que prueba las
-- policies contra Supabase de verdad: dos usuarios, cada uno en su proyecto, y
-- las afirmaciones de que ninguno ve el del otro. El resto de la suite corre con
-- dobles y no lo necesita.
--
-- **Por que existe este archivo.** El fixture se creo a mano durante el plan 1 y
-- solo quedaba escrito en el brief de esa task, asi que borrar las filas de la
-- base dejaba el test muerto sin que nada lo dijera. Se borraron el 2026-09-01
-- —aparecian en el selector de proyectos del panel, al lado de los reales— y
-- esto es lo que hay que correr para volver a habilitarlo.
--
-- Idempotente: se puede correr las veces que sea.

-- Los dos proyectos, con id FIJO. El test apunta a
-- '00000000-0000-4000-8000-000000000002' directamente para probar que un insert
-- en un proyecto ajeno se rechaza, asi que los ids no pueden ser aleatorios.
insert into public.proyectos (id, nombre) values
  ('00000000-0000-4000-8000-000000000001', 'rls-proyecto-a'),
  ('00000000-0000-4000-8000-000000000002', 'rls-proyecto-b')
on conflict (id) do nothing;

-- Y cada usuario en el suyo.
--
-- Los usuarios NO los crea este archivo: van a mano en Authentication -> Users
-- -> Add user, con "Auto Confirm" tildado, porque el test se loguea con
-- password y necesita el mail confirmado. Los ids salen de auth.users, asi que
-- este insert los busca por mail en vez de hardcodearlos.
insert into public.miembros (proyecto_id, usuario_id, rol)
select '00000000-0000-4000-8000-000000000001', id, 'dueño'
from auth.users where email = 'rls-a@ejemplo.test'
on conflict do nothing;

insert into public.miembros (proyecto_id, usuario_id, rol)
select '00000000-0000-4000-8000-000000000002', id, 'dueño'
from auth.users where email = 'rls-b@ejemplo.test'
on conflict do nothing;

-- Para correr el test, con las credenciales de esos dos usuarios:
--
--   cd bridge
--   SUPABASE_URL=... SUPABASE_ANON_KEY=... \
--   RLS_TEST_EMAIL_A=rls-a@ejemplo.test RLS_TEST_PASSWORD_A=... \
--   RLS_TEST_EMAIL_B=rls-b@ejemplo.test RLS_TEST_PASSWORD_B=... \
--   npx vitest run test/rls.test.ts
--
-- Sin esas variables el describe se saltea (`skipIf`), que es por lo que la
-- suite pasa en verde igual sin este fixture.

-- --- para volver a sacarlos --------------------------------------------------
--
-- Las filas de `miembros` se van solas por el ON DELETE CASCADE del proyecto.
--
--   delete from public.proyectos where nombre in ('rls-proyecto-a', 'rls-proyecto-b');
