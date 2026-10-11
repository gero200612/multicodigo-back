# sincro-wa, el bot general de WhatsApp. Misma receta que Homero.
FROM node:22-slim
RUN useradd -m -u 1001 sincro
WORKDIR /app

# Manifiestos primero: el install se reusa mientras el lockfile no cambie.
COPY --chown=sincro:sincro package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY --chown=sincro:sincro . .
RUN pnpm build
USER sincro
ENV HOME=/home/sincro NODE_ENV=production
# 3000: el webhook (publico, por Traefik). 3001: la API (solo VPN y red de Coolify).
EXPOSE 3000 3001
CMD ["node", "dist/main.js"]
