FROM rust:1.87-bookworm AS agent-build

WORKDIR /agent
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./
COPY apps/agent/src ./src
RUN rustup target add \
  x86_64-unknown-linux-musl \
  aarch64-unknown-linux-musl \
  armv7-unknown-linux-musleabihf
RUN cargo build --release --locked --target x86_64-unknown-linux-musl
RUN CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
  cargo build --release --locked --target aarch64-unknown-linux-musl
RUN CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_LINKER=rust-lld \
  cargo build --release --locked --target armv7-unknown-linux-musleabihf
RUN mkdir -p /agent-dist/linux-x64 \
  /agent-dist/linux-arm64 \
  /agent-dist/linux-armv7l \
  && cp target/x86_64-unknown-linux-musl/release/pulsedeck-agent /agent-dist/linux-x64/pulsedeck-agent \
  && cp target/aarch64-unknown-linux-musl/release/pulsedeck-agent /agent-dist/linux-arm64/pulsedeck-agent \
  && cp target/armv7-unknown-linux-musleabihf/release/pulsedeck-agent /agent-dist/linux-armv7l/pulsedeck-agent

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
COPY --from=agent-build /agent-dist ./agent-dist

VOLUME ["/data"]
EXPOSE 14770
CMD ["node", "apps/api/src/main.mjs"]
