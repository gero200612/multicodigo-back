-- Meta invalida un token (error 190) y los envios se frenan hasta que vuelva a andar.
ALTER TABLE numeros ADD COLUMN token_caido boolean NOT NULL DEFAULT false;
