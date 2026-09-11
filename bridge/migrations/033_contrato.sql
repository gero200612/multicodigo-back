-- El contrato entre el front y el back de una corrida.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-10-piso-minimo-y-cuatro-analistas-design.md`.
--
-- Nace de `despacho2` (2026-09-10): el front llamaba a `/pedidos` y el back
-- exponia `/api/pedidos`. Los dos con sus tests en verde, porque cada uno
-- testeo contra lo que el mismo invento. Nadie estaba equivocado y nada
-- funcionaba junto.
--
-- El planificador lo fija ANTES de escribir las tareas, y de aca se inyecta en
-- el prompt de cada una.
--
-- En la base y NO en un archivo del repo, a proposito: un `contrato.md` solo
-- lo ve el slot que lo tiene en su worktree, y llega a los demas recien cuando
-- su merge entra a main. Que un merge no entre es justo lo que paso esa noche.
-- En la corrida lo ven todos los slots siempre.
ALTER TABLE public.corridas
  ADD COLUMN IF NOT EXISTS contrato TEXT;
