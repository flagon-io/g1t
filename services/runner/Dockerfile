# The sandbox a hosted attempt runs in: git, Claude Code, and the g1t runner.
# Build context: the repository root.

# The same Debian release as the runtime image, so glibc matches.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY services services
RUN cargo build --release --package g1t-runner

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code \
 && mkdir /work && chown node:node /work
COPY --from=build /src/target/release/g1t-runner /usr/local/bin/g1t-runner
# Claude Code refuses to skip permission prompts as root.
USER node
ENV HOME=/home/node
ENTRYPOINT ["g1t-runner"]
