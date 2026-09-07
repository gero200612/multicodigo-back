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

# El orden de las capas es lo que hace que un deploy tarde segundos y no
# minutos. Es la misma leccion que ya estaba aprendida en
# `multicodigo-vm/src/agent/Dockerfile`, y este archivo se habia quedado atras.
#
# Antes era `COPY . .` y despues `pnpm install`: como el COPY traia TODO el
# directorio, cambiar una linea de un .ts invalidaba la capa y obligaba a
# reinstalar node_modules entero. Medido en el server: **50 segundos** por
# build, repetidos aunque las dependencias no se hubieran tocado. El deploy
# tardaba lo mismo por un typo que por un cambio de dependencias.
#
# Ahora se copian PRIMERO los manifiestos —que cambian cuando cambian las
# dependencias, o sea casi nunca— se instala, y recien despues entra el codigo.
# Docker reusa la capa del install mientras el lockfile no se toque.
#
# El `pnpm-workspace.yaml` va aunque el bridge no sea un workspace: pnpm lo lee
# para resolver, y sin el el install se comporta distinto al que genero el
# lockfile.
COPY --chown=bridge:bridge package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY --chown=bridge:bridge . .
RUN pnpm build
USER bridge
# El bridge no toca el disco: habla con Telegram, Postgres y el gateway. Por eso
# si puede correr sin root, a diferencia del gateway.
#
# La ruta cambio con la mudanza: antes era src/bridge/dist/main.js porque el
# WORKDIR era la raiz del monorepo. Las migraciones se resuelven contra este
# modulo (`../migrations`), asi que siguen cayendo en /app/migrations.
CMD ["node", "dist/main.js"]
