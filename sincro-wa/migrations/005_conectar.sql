-- Embedded Signup: la empresa conecta su propio numero desde su app.
-- telefono: el numero visible (display_phone_number), para mostrarlo en la app.
-- coexistencia: el numero sigue en la app WhatsApp Business del celu (no se registra con PIN).
-- pin_cifrado: el PIN de verificacion en dos pasos que puso el bot al registrarlo (cifrado).
ALTER TABLE numeros ADD COLUMN telefono text;
ALTER TABLE numeros ADD COLUMN coexistencia boolean NOT NULL DEFAULT false;
ALTER TABLE numeros ADD COLUMN pin_cifrado text;
