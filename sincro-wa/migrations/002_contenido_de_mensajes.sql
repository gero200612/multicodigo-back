-- Lo que se ve en el celu y el texto plano no guarda: botones, texto ya armado
-- de una plantilla, el boton que toco la persona, reacciones. Nulo en los viejos.
ALTER TABLE mensajes ADD COLUMN contenido jsonb;
