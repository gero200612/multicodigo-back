# Homero, el agente comercial. Misma receta que el bridge.
FROM node:22-slim
# git es para el install: `@multicodigo/shared` es una dependencia de git.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
# uid 1001, EL MISMO que el login y los slots: la sesion de Claude la deposita
# el servicio de login con modo 0600 en /srv/homes/<slot>, y este proceso la
# monta como su HOME. Con otro uid no la puede leer y parece un error de auth.
RUN useradd -m -u 1001 homero
WORKDIR /app

# Manifiestos primero: el install se reusa mientras el lockfile no cambie.
COPY --chown=homero:homero package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY --chown=homero:homero . .
RUN pnpm build
USER homero
ENV HOME=/home/homero
CMD ["node", "dist/main.js"]
