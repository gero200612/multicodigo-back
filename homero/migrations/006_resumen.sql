-- Una linea concreta de lo que hizo cada corrida ("Anotó 2: B&OKO, Aguilar"),
-- armada por el codigo con lo que el agente efectivamente hizo. Es lo que Gero
-- lee en el historial; el informe entero queda para el detalle.
ALTER TABLE homero.corridas ADD COLUMN IF NOT EXISTS resumen TEXT;
