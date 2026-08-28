# bridge

El puente entre Telegram y el gateway. **Corre en Render**, no en la VM.

Vino del repo `multicodigo-vm` (con su historia) cuando los servicios se
repartieron por destino de despliegue. Lo unico que cambio con la mudanza:

- Dejo de ser un paquete del workspace de `vm`. Tiene su propio `package.json`,
  su lockfile y su tsconfig.
- `@multicodigo/shared` —el contrato de zod con el gateway y los agentes— pasa
  de `workspace:*` a una dependencia publicada. **Un cambio en el contrato ahora
  son tres pasos**, ver el README de ese repo.
- El contexto de build de la imagen es este directorio, no la raiz del repo, y
  el `CMD` es `dist/main.js` (antes `src/bridge/dist/main.js`).

Vive en el mismo repo que `panel-api` porque los dos van a Render, pero no
comparten nada: son dos servicios independientes con dos Dockerfiles.

## Local

```bash
pnpm install
pnpm test        # 114 tests
pnpm build
```

## Render

Web Service, Docker, **Root Directory `bridge`**. Las variables salen del schema
de zod en `src/main.ts`: si falta una, el proceso no arranca y el error dice
cual. La lista completa esta en `docs/despliegue.md` del repo `multicodigo-vm`.
