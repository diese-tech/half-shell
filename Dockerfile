# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# The protocol is loaded at runtime, so it has to be present to compile against.
COPY skills ./skills
RUN npm run build

# Drop dev dependencies from the layer that ships.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The canonical review protocol. The runtime reads it on every review.
COPY --from=build /app/skills ./skills

# Persisted findings and run records live here; mount a volume in production.
RUN mkdir -p /data && chown node:node /data
ENV HALF_SHELL_DATA_DIR=/data
ENV HALF_SHELL_DATABASE_PATH=/data/half-shell.db
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
