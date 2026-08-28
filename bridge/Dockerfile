# El bridge, en su propia imagen.
#
# El contexto de build es ESTE directorio y no la raiz del repo: desde que el
# bridge dejo de ser un paquete del workspace de `vm`, no necesita nada de
# afuera. `@multicodigo/shared` se clona de su repo publico durante el
# install, asi que no depende de que el contrato este en el arbol.
FROM node:22-slim
# git no es para el bridge: es para el install. `@multicodigo/shared` se
# consume como dependencia de git y sin el binario pnpm no puede clonarlo
# (ERR_PNPM_GIT_FETCHER_GIT_NOT_FOUND).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 bridge
WORKDIR /app
COPY --chown=bridge:bridge . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
USER bridge
# El bridge no toca el disco: habla con Telegram, Postgres y el gateway. Por eso
# si puede correr sin root, a diferencia del gateway.
#
# La ruta cambio con la mudanza: antes era src/bridge/dist/main.js porque el
# WORKDIR era la raiz del monorepo. Las migraciones se resuelven contra este
# modulo (`../migrations`), asi que siguen cayendo en /app/migrations.
CMD ["node", "dist/main.js"]
