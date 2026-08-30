-- El usuario puede ver SUS vinculos de Telegram.
--
-- La 008 dejo `telegram_vinculos` con RLS y sin ninguna policy, junto a las
-- otras tablas internas del bridge, con el argumento de que nadie con la anon
-- key las ve. Para los codigos sigue siendo lo correcto —un codigo a la vista
-- es un chat que otro puede reclamar— pero para los vinculos deja al panel sin
-- forma de contestar "¿este chat ya esta vinculado?", que es lo que la pantalla
-- necesita para dejar de ofrecer vincular algo que ya esta.
--
-- Solo los propios y solo para leer: `usuario_id = auth.uid()`. Crear un vinculo
-- sigue pasando por el bridge, que es el unico que puede canjear un codigo.

DROP POLICY IF EXISTS "telegram: ver mis vinculos" ON public.telegram_vinculos;
CREATE POLICY "telegram: ver mis vinculos" ON public.telegram_vinculos
  FOR SELECT TO authenticated
  USING (usuario_id = (SELECT auth.uid()));
