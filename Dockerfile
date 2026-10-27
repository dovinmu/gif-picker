FROM node:24-bookworm-slim AS build
WORKDIR /app/web
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm server:typecheck && pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8090
WORKDIR /app/web
COPY --from=build --chown=node:node /app/web/package.json ./package.json
COPY --from=build --chown=node:node /app/web/server ./server
COPY --from=build --chown=node:node /app/web/src/lib/types.ts ./src/lib/types.ts
COPY --from=build --chown=node:node /app/web/dist ./dist
USER node
EXPOSE 8090
CMD ["node", "/app/web/server/index.ts"]
