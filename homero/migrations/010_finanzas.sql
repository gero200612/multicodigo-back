-- El Administrador: los números de la empresa (gastos fijos, cuentas de Claude,
-- clientes, pagos y el dólar de cada día). Idempotente: corre entera en cada
-- arranque.

-- Lo que se paga todos los meses (o por año) fuera de Claude y de Meta: la VPS,
-- la prepaga del celular. `hasta` vacío = sigue.
CREATE TABLE IF NOT EXISTS homero.fijos (
  id       BIGSERIAL PRIMARY KEY,
  nombre   TEXT NOT NULL,
  monto    NUMERIC(14, 2) NOT NULL CHECK (monto >= 0),
  moneda   TEXT NOT NULL CHECK (moneda IN ('ARS', 'USD')),
  periodo  TEXT NOT NULL CHECK (periodo IN ('mensual', 'anual')),
  desde    DATE NOT NULL,
  hasta    DATE,
  creado   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El plan de cada cuenta de Claude. CUÁNTAS hay lo dice Punchi (los slots con
-- cuenta); esto guarda solo cuánto sale cada una si no es la Pro de USD 20.
CREATE TABLE IF NOT EXISTS homero.cuentas_claude (
  slot     TEXT PRIMARY KEY,
  plan     TEXT NOT NULL,
  precio   NUMERIC(10, 2) NOT NULL CHECK (precio >= 0)
);

-- La foto de qué cuentas había vinculadas cada día: una cuenta que entra a
-- mitad de mes paga la parte de los días que estuvo.
CREATE TABLE IF NOT EXISTS homero.cuentas_por_dia (
  dia      DATE PRIMARY KEY,
  slots    JSONB NOT NULL
);

-- A quién se le cobra. `proyecto` es el nombre del proyecto de Punchi (la app).
CREATE TABLE IF NOT EXISTS homero.clientes (
  id       BIGSERIAL PRIMARY KEY,
  nombre   TEXT NOT NULL,
  proyecto TEXT,
  armado   NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (armado >= 0),
  abono    NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (abono >= 0),
  desde    DATE NOT NULL,
  estado   TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'baja')),
  creado   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homero.pagos (
  id         BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES homero.clientes(id) ON DELETE CASCADE,
  dia        DATE NOT NULL,
  monto      NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
  moneda     TEXT NOT NULL CHECK (moneda IN ('ARS', 'USD')),
  concepto   TEXT NOT NULL CHECK (concepto IN ('armado', 'abono', 'otro')),
  creado     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pagos_dia ON homero.pagos (dia);

-- El dólar tarjeta de cada día (pesos por dólar). Se guarda para que un mes
-- cerrado no cambie cuando se mueve el dólar.
CREATE TABLE IF NOT EXISTS homero.cotizaciones (
  dia      DATE PRIMARY KEY,
  valor    NUMERIC(12, 2) NOT NULL CHECK (valor > 0)
);
