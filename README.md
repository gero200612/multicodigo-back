# multicodigo-back

Lo que corre en **Render**. Dos servicios independientes que no comparten nada
mas que el repo:

| Directorio | Que es | Root Directory en Render |
|---|---|---|
| `panel-api/` | la API .NET del panel: `/api/*` con el JWT de Supabase, `/config.json` | `panel-api` |
| `bridge/` | el puente con Telegram: jobs, aprobaciones, Postgres | `bridge` |

Los dos son Web Services de tipo Docker, cada uno con su Dockerfile y su
contexto de build en su propio directorio. No hay build compartido: uno es .NET
y el otro Node.

Estan juntos porque los repos se dividieron **por destino de despliegue**. Lo
que corre en la VM esta en `multicodigo-vm`, el panel web en
`multicodigo-front` (Vercel), y el contrato que comparten los servicios en
`multicodigo-shared`.

## A quien le habla cada uno

```
bridge    --> gateway (VM, por Caddy)   + Supabase (Postgres) + Telegram + Gemini
panel-api --> gateway (VM, por Caddy)   + login (VM, por Caddy)
          --> bridge (para "ultimas peticiones")
          --> Supabase (JWKS y PostgREST)
```

Las dos flechas hacia la VM pasan por Caddy y estan protegidas por un bearer mas
la allowlist de IPs de salida de Render. Esas IPs estan en Settings → Outbound
IPs y hay que cargarlas en dos lugares: el gateway y el `Caddyfile`. El detalle
esta en `docs/despliegue.md` del repo `multicodigo-vm`.

## Variables

Ninguno de los dos arranca con la configuracion incompleta, y es a proposito:
un servicio arriba pero sin poder hablarle a sus dependencias es peor que uno
que no levanta. El bridge valida con zod y el panel con un `Requerido()` que
tira al arrancar. La lista completa de los dos esta en el paso 7 de
`docs/despliegue.md`.

`BRIDGE_API_TOKEN` es la unica variable que los dos comparten y tiene que ser
identica: es el bearer con el que el panel le pide al bridge las ultimas
peticiones.
