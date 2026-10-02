# The sandbox a g1t agent works in: git, the agent, the g1t runner, and
# the toolchains an agent needs to build and test what it changes.
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
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl build-essential pkg-config libssl-dev \
      python3 python3-pip python3-venv golang-go ripgrep jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code \
 && mkdir /work && chown node:node /work
COPY --from=build /src/target/release/g1t-runner /usr/local/bin/g1t-runner
# Claude Code refuses to skip permission prompts as root.
USER node
ENV HOME=/home/node
# Rust, for the agent's own use, installed for the user it runs as.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/home/node/.cargo/bin:$PATH
# Commits are the g1t agent's; the harness does not sign them as its own.
RUN mkdir -p /home/node/.claude \
 && echo '{"includeCoAuthoredBy": false}' > /home/node/.claude/settings.json
ENTRYPOINT ["g1t-runner"]
