FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PULSEDECK_HOST=0.0.0.0
ENV PULSEDECK_PORT=14770
ENV PULSEDECK_DATA_FILE=/data/pulsedeck.json

COPY package.json ./
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/agent ./apps/agent
COPY --from=build /app/dist ./dist

VOLUME ["/data"]
EXPOSE 14770
CMD ["node", "apps/api/src/main.mjs"]
