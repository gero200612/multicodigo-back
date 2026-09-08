-- El paso donde se elige la organizacion.
--
-- El CHECK de la migracion 025 solo aceptaba 'nombre' y 'pliego', y sin un paso
-- propio para la org habia un circulo:
--
--   1. Se pregunta la org con botones, y el borrador queda en paso 'nombre'.
--   2. La persona la ESCRIBE en vez de tocar el boton —porque los botones no
--      llegaban, ver el fix de `responderPaso`, pero tambien porque escribir es
--      lo natural en un chat—.
--   3. Ese texto se lee como la respuesta al paso 'nombre', o sea como el
--      nombre del proyecto.
--   4. Sigue sin org, y se pregunta de nuevo.
--
-- Con un paso propio, el texto se interpreta como lo que es. Y el boton sigue
-- andando: son dos formas de contestar lo mismo, no una alternativa a la otra.
ALTER TABLE public.corrida_borrador DROP CONSTRAINT IF EXISTS borrador_paso_valido;
ALTER TABLE public.corrida_borrador
  ADD CONSTRAINT borrador_paso_valido CHECK (paso IN ('nombre', 'org', 'pliego'));
