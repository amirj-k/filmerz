# Plain CommonJS/Express app: there is no bundling or compilation step, so a
# single stage is sufficient. Node 24 is pinned because the app uses the
# built-in node:sqlite module (package.json requires Node >= 22.5).
FROM node:24.18.0-alpine3.24

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Reproducible production install from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Runtime code and assets. Local DBs, data/, backups/, .env, logs and tests
# are excluded through .dockerignore.
COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node ["top 250.txt", "./"]

# Persistent locations. Compose mounts named volumes over data/ and backups/.
RUN mkdir -p /app/data/uploads /app/data/cache/posters /app/backups \
    && chown -R node:node /app/data /app/backups

USER node

EXPOSE 3000
VOLUME ["/app/data", "/app/backups"]

STOPSIGNAL SIGTERM

# /healthz executes a real SQLite query. Node's built-in fetch avoids relying
# on wget/curl being present in the image.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run node directly (not through npm) so SIGTERM reaches the shutdown handler.
CMD ["node", "src/server.js"]
