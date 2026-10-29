# Plain CommonJS/Express app: there is no bundling or compilation step, so a
# single stage is sufficient. Node 24 is pinned because the app uses the
# built-in node:sqlite module (package.json requires Node >= 22.5).
FROM node:24.18.0-alpine3.24

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
COPY ["top 250.txt", "./"]

# Create required directories and non-root user
RUN mkdir -p data uploads backups && \
    addgroup -S fmz && \
    adduser -S fmz -G fmz && \
    chown -R fmz:fmz /app

# Expose the application port and define volumes for persistent data
EXPOSE 3000
VOLUME ["/app/data", "/app/backups"]

# Health check - assumes /healthz endpoint returns 200 when healthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# Run as non-root user
USER fmz

# Start the application
CMD ["node", "src/server.js"]
