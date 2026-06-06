FROM --platform=linux/amd64 rust:1.87-alpine AS agent-build-linux-x64

WORKDIR /agent
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./
COPY apps/agent/src ./src
RUN cargo build --release --locked
RUN mkdir -p /agent-dist/linux-x64 \
  && cp target/release/pulsedeck-agent /agent-dist/linux-x64/pulsedeck-agent

FROM --platform=linux/arm64 rust:1.87-alpine AS agent-build-linux-arm64

WORKDIR /agent
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./
COPY apps/agent/src ./src
RUN cargo build --release --locked
RUN mkdir -p /agent-dist/linux-arm64 \
  && cp target/release/pulsedeck-agent /agent-dist/linux-arm64/pulsedeck-agent

FROM --platform=linux/arm/v7 rust:1.87-alpine AS agent-build-linux-armv7l

WORKDIR /agent
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./
COPY apps/agent/src ./src
RUN cargo build --release --locked
RUN mkdir -p /agent-dist/linux-armv7l \
  && cp target/release/pulsedeck-agent /agent-dist/linux-armv7l/pulsedeck-agent

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
COPY --from=build /app/dist ./dist
COPY --from=agent-build-linux-x64 /agent-dist/linux-x64 ./agent-dist/linux-x64
COPY --from=agent-build-linux-arm64 /agent-dist/linux-arm64 ./agent-dist/linux-arm64
COPY --from=agent-build-linux-armv7l /agent-dist/linux-armv7l ./agent-dist/linux-armv7l

VOLUME ["/data"]
EXPOSE 14770
CMD ["node", "apps/api/src/main.mjs"]
