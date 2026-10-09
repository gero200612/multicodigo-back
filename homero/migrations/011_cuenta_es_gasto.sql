-- Cada cuenta de Claude se puede sacar del gasto (una que no paga Gero, una de
-- prueba): se sigue viendo, pero no suma. Idempotente.
ALTER TABLE homero.cuentas_claude ADD COLUMN IF NOT EXISTS es_gasto BOOLEAN NOT NULL DEFAULT true;
