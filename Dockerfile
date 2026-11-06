FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Coolify's health check runs curl inside the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS "http://127.0.0.1:${PORT:-3020}/health" || exit 1
CMD ["node", "src/index.ts"]
