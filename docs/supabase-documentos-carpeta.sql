-- Carpetas para los documentos del proyecto (Archivos del panel).
--
-- Solo organización: el archivo sigue plano en /srv/docs/<proyecto>/<nombre> y
-- en el `_docs` del agente. Vacía es la raíz. La forma la valida el panel
-- (Documentos.CarpetaValida); acá va el piso: sin `..`, sin barras de más.
--
-- Idempotente: se puede correr de nuevo sin romper nada.

alter table documentos add column if not exists carpeta text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documentos_carpeta_forma') then
    alter table documentos add constraint documentos_carpeta_forma check (
      length(carpeta) <= 150
      and carpeta !~ '(^/|/$|//|\.\.|\\)'
    );
  end if;
end $$;

-- Que PostgREST vea la columna nueva sin esperar.
notify pgrst, 'reload schema';
