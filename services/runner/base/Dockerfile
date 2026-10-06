# syntax=docker/dockerfile:1.7
#
# g1t-runner-base: everything a g1t sandbox has apart from the g1t runner
# itself. Agents, checks, the merge queue, workflow jobs and g1t.page
# builds all run in it: git, Node, Python, Go, Rust (with the formatter,
# the linter and the wasm32 target), the usual build tools, and the
# Claude Code CLI.
#
# Built and pushed by `node scripts/deploy.mjs build-base` (by hand, or by
# .g1t/workflows/runner-base.yml), which records what it pushed in
# services/runner/base.json. The runner's own image
# (services/runner/Dockerfile) is this plus one file, so a change to the
# runner builds in seconds. docs/DEPLOYING.md explains the two.
#
# Layers go from what changes least to what changes most: the system's
# packages, then Go, then Rust, then the Claude Code CLI on top, so a new
# CLI version rebuilds and pushes one layer.
#
# Build context: this folder (nothing is copied from it).

FROM node:24-bookworm-slim

# Docs, man pages and translations are never read in a sandbox; dpkg
# leaves them out of every package installed from here on (copyright
# files stay). Downloaded packages are kept for the build's apt cache.
RUN printf '%s\n' \
      'path-exclude=/usr/share/doc/*' \
      'path-include=/usr/share/doc/*/copyright' \
      'path-exclude=/usr/share/man/*' \
      'path-exclude=/usr/share/info/*' \
      'path-exclude=/usr/share/groff/*' \
      'path-exclude=/usr/share/lintian/*' \
      'path-exclude=/usr/share/linda/*' \
      'path-exclude=/usr/share/locale/*' \
      'path-include=/usr/share/locale/locale.alias' \
      > /etc/dpkg/dpkg.cfg.d/01-g1t-slim \
 && rm -f /etc/apt/apt.conf.d/docker-clean \
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-downloads

# The system's packages. The apt cache and package lists live in
# BuildKit's cache, not the image (run `sudo apt-get update` before
# installing more). dpkg skips its fsync after every file, which an image
# build has no use for and which made this step several times slower.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-unsafe-io \
      git ca-certificates curl build-essential pkg-config libssl-dev \
      python3 python3-pip python3-venv ripgrep jq zstd \
      sudo unzip zip xz-utils wget file gnupg lsb-release openssh-client \
 && rm -rf /var/log/apt /var/log/dpkg.log /var/cache/debconf/*-old

# Workflows expect GitHub's runner layout under /home/runner, and sudo
# without a password. The agent works in /work.
RUN mkdir /work && chown node:node /work \
 && mkdir -p /home/runner/work /home/runner/_temp /home/runner/_tool /home/runner/_actions \
 && chown -R node:node /home/runner \
 && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
 && chmod 0440 /etc/sudoers.d/node

# Go, from go.dev (Debian's is years behind), without its own test suite
# and API history, which only Go's developers use.
ARG GO_VERSION=1.27.1
ARG GO_SHA256=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
RUN curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm -rf /tmp/go.tgz /usr/local/go/test /usr/local/go/api /usr/local/go/doc \
 && ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/

# Claude Code refuses to skip permission prompts as root.
USER node
ENV HOME=/home/node
ENV PATH=/home/node/.cargo/bin:/home/node/go/bin:$PATH

# Rust stable, for the user the agent runs as, with the formatter and
# linter that CI so often checks with (an agent that cannot run them only
# finds out from a failed workflow), and the wasm32 target that Workers,
# and g1t's own deploys, build for.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
      --component rustfmt --component clippy --target wasm32-unknown-unknown \
 && rm -rf /home/node/.rustup/downloads /home/node/.rustup/tmp \
           /home/node/.rustup/toolchains/*/share/doc \
           /home/node/.rustup/toolchains/*/share/man

# Commits are the g1t agent's; the harness does not sign them as its own.
RUN mkdir -p /home/node/.claude \
 && echo '{"includeCoAuthoredBy": false}' > /home/node/.claude/settings.json

# The Claude Code CLI, pinned, on top: it changes most often of anything
# here, and is one layer to rebuild and push.
ARG CLAUDE_CODE_VERSION=2.1.291
USER root
# npm's cache stays in BuildKit's cache, out of the image.
RUN --mount=type=cache,target=/tmp/npm-cache \
    npm install --global --no-audit --no-fund --cache /tmp/npm-cache "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version
USER node
