FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 bridge
WORKDIR /app
COPY --chown=bridge:bridge . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
USER bridge
# El bridge no toca el disco: habla con Telegram, Postgres y el gateway. Por eso
# si puede correr sin root, a diferencia del gateway.
CMD ["node", "src/bridge/dist/main.js"]
