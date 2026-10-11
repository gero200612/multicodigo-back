# sincro-wa

El bot general de WhatsApp (Cloud API oficial de Meta). Conecta cada número una
vez y le da a cada app **solo** las capacidades que pidió el cliente: `leads`,
`facturas`, `avisos`, `promociones` y `atender`. Para una clave, una ruta que no
está en sus capacidades no existe (404).

- Diseño: `docs/superpowers/specs/2026-10-10-sincro-wa-bot-design.md`
- Contrato de la API (rutas, códigos, formatos): [`CONTRATO.md`](CONTRATO.md)

## Cómo está armado

Dos servidores Fastify en el mismo proceso:

| Puerto | Quién llega | Qué sirve |
|---|---|---|
| 3000 | Internet, por Traefik (`wa.apps.punchi.dev`) | `GET/POST /webhook` (firma de Meta obligatoria) y `GET /salud` |
| 3001 | Solo VPN y la red de Coolify | La API de las apps y la de admin (`/admin/*`, la usa Homero) |

Postgres propio; las migraciones (`migrations/`) corren solas al arrancar y quedan
anotadas en la tabla `migraciones`. La IA (leer facturas, atender) la corre Homero
con el fondo común de cuentas: el bot deja trabajos en una cola y Homero los toma
con `GET /admin/ia/pendientes`.

## Entorno

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Postgres del bot |
| `META_APP_SECRET` | Secreto de la app de Meta: verifica `X-Hub-Signature-256` |
| `META_VERIFY_TOKEN` | El que se pone en Meta al configurar el webhook |
| `META_TOKEN` | Token del system user (lo usan los números sin token propio) |
| `META_API_VERSION` | Opcional, `v23.0` por defecto |
| `SINCRO_WA_ADMIN_KEY` | Clave de admin, 32 caracteres o más. Solo la tiene Homero |
| `SINCRO_WA_CIFRADO` | 32 bytes en base64 (`openssl rand -base64 32`): cifra tokens de clientes y secretos de eventos. Si se pierde, hay que volver a cargar esos tokens |
| `PUERTO_PUBLICO` / `PUERTO_PRIVADO` | 3000 / 3001 |

Ningún log imprime un token: todo pasa por `taparTokens()`.

## Desplegar

En Coolify, en el VPS de OVH: servicio con este `Dockerfile` y un Postgres propio.
Solo el puerto 3000 va al dominio público `wa.apps.punchi.dev` (Traefik); el 3001
no se publica. En Meta, el webhook apunta a `https://wa.apps.punchi.dev/webhook`
con `META_VERIFY_TOKEN`, suscrito a `messages`, `message_template_status_update`,
`template_category_update` y `phone_number_quality_update`.

## Dar de alta un negocio

Con la clave de admin, por la VPN:

```sh
# 1. El negocio, con EXACTAMENTE las capacidades que pidió el cliente y su tope.
curl -s -X POST http://sincro-wa:3001/admin/negocios \
  -H "Authorization: Bearer $SINCRO_WA_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"nombre":"Taller Pepe","app":"taller","capacidades":["facturas"],"tope_mensual_ars":20000,"quien":"punchi"}'
# → {"negocio":{...},"clave":"swa_...","secreto_eventos":"..."}  (se muestran UNA vez)

# 2. Su número. Sin "token" usa META_TOKEN (el número de Sincro).
curl -s -X POST http://sincro-wa:3001/admin/numeros \
  -H "Authorization: Bearer $SINCRO_WA_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"negocio_id":1,"phone_number_id":"1405287685995571","waba_id":"1786410379074282","quien":"punchi"}'
```

La `clave` va al entorno de la app como `SINCRO_WA_KEY`. Si la app expone
`/bot/...`, se carga `url_base` y recibe los eventos por push firmados con el
`secreto_eventos` (`X-Sincro-Firma`); si no, los levanta con `GET /eventos`.

## Desarrollo

```sh
pnpm install
pnpm test        # sin Postgres: la lógica corre contra una base en memoria (test/memoria.ts)
pnpm typecheck
pnpm build
```
