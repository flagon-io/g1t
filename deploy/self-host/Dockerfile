# Self-hosted g1t: every Worker of the core forge in one workerd, through
# `wrangler dev`, with D1, KV and Queues kept on the /data volume.
# Build context: the repository root (see docker-compose.yml).

# ── The Rust services, compiled to WebAssembly as they are for Workers ──
FROM rust:1-slim-bookworm AS rust
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && cargo install -q worker-build@0.8.7 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/api apps/api
COPY crates crates
COPY services services
# The same build hosted g1t deploys (each wrangler.jsonc's build command).
# No cache mount for target/: cargo trusts file times, and a cached build
# from a newer tree would be taken as fresh for an older one.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    for service in identity repos work events search billing security actions webhooks integrations; do \
      (cd services/$service && worker-build --release) || exit 1; \
    done

# ── The site, built by React Router; the TypeScript services' packages ──
FROM node:24-bookworm-slim AS node
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
      --include-workspace-root \
      -w @g1t/web -w @g1t/projects -w @g1t/deployments -w @g1t/contracts -w @g1t/theme -w @g1t/status \
 && npm run build -w @g1t/web

# ── Runtime ──
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=node --chown=node:node /app /app
COPY --from=rust /src/services /tmp/rust-services
RUN for service in identity repos work events search billing security actions webhooks integrations; do \
      cp -r /tmp/rust-services/$service/build services/$service/build; \
    done \
 && rm -rf /tmp/rust-services \
 && mkdir -p /data && chown node:node /data
ENV WRANGLER_SEND_METRICS=false \
    PUBLIC_URL=http://localhost:8787 \
    GITSTORE_URL=http://gitstore:8080 \
    G1T_DATA=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["bash", "deploy/self-host/start.sh"]
