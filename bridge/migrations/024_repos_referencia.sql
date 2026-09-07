-- Repos de REFERENCIA: se leen, no se escriben.
--
-- Ver `multicodigo-vm/docs/superpowers/specs/2026-09-07-corrida-desatendida-design.md`.
--
-- Nace de querer que un proyecto nuevo se construya MIRANDO uno que ya existe
-- en vez de arrancar de cero. El repo de ejemplo se monta en el worktree y el
-- agente lo lee con Read y Grep, igual que los suyos.
--
-- El problema que resuelve la columna: en modo `desatendido` el agente puede
-- commitear y pushear a `claude/<agente>/*` de CUALQUIER repo del proyecto. Sin
-- esta marca, una corrida nocturna para un cliente dejaria ramas en el repo que
-- se presto de ejemplo — que puede ser el de otro cliente.
--
-- Lo que la marca NO hace es proteger sola: la hace cumplir el GATEWAY
-- (`gitCommit` y `gitPush` en src/gateway/src/git.ts), que es el lado al que el
-- modelo no llega. Esta fila solo se lo cuenta.
ALTER TABLE public.repos
  ADD COLUMN IF NOT EXISTS solo_lectura BOOLEAN NOT NULL DEFAULT false;

-- El default en false y NOT NULL: todo lo que ya estaba vinculado sigue siendo
-- escribible, que es como funcionaba hasta ahora. Un nullable haria que "no se
-- sabe" y "se puede escribir" se vean iguales en el codigo que lo lee.
