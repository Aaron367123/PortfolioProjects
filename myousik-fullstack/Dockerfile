# Myousik 2.0 — production image
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/myousik.db

WORKDIR /app

# Install production dependencies first so this layer is cached.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# The SQLite file lives on a volume owned by the unprivileged "node" user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
