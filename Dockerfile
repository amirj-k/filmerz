# ---- build stage: none needed (plain Node, no bundler) ----
FROM node:24-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# bcryptjs is pure JS; skip python/make toolchain entirely
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p data uploads backups && addgroup -S fmz && adduser -S fmz -G fmz \
    && chown -R fmz:fmz /app
USER fmz

EXPOSE 3000
VOLUME ["/app/data", "/app/uploads", "/app/backups"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
