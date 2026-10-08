# syntax=docker/dockerfile:1.7
#
# g1t-runner-base: everything a g1t sandbox has apart from the g1t runner
# itself. Agents, checks, the merge queue, workflow jobs and g1t.page
# builds all run in it: git, Node, Python, Go, Rust (with the formatter,
# the linter, and the wasm32 and musl targets), Java (Temurin 21), .NET
# (SDK 8), Ruby (3.3), the usual build tools, Docker (Engine, Buildx,
# Compose), and the Claude Code CLI.
#
# Built and pushed by `node scripts/deploy.mjs build-base` (by hand, or by
# .g1t/workflows/runner-base.yml), which records what it pushed in
# services/runner/base.json. The runner's own image
# (services/runner/Dockerfile) is this plus one file, so a change to the
# runner builds in seconds. docs/DEPLOYING.md explains the two.
#
# Layers go from what changes least to what changes most: the system's
# packages, Docker, then Go, then Rust, then Java, .NET and Ruby, then the
# Claude Code CLI on top, so a new CLI version rebuilds and pushes one
# layer.
#
# Java and Ruby live in the runner's tool cache (RUNNER_TOOL_CACHE,
# /home/runner/_tool), laid out as the setup actions look for them, so
# `actions/setup-java` (temurin, 21) and `ruby/setup-ruby` (3.3) find them
# there instead of downloading. .NET is in /usr/share/dotnet, where
# `actions/setup-dotnet` installs, so it finds the SDK already there.
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
# musl-tools is musl-gcc, with which (and `rustup target add
# x86_64-unknown-linux-musl`) the static g1t runner builds in a workflow
# job (scripts/build-runner.mjs).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-unsafe-io \
      git ca-certificates curl build-essential pkg-config libssl-dev \
      python3 python3-pip python3-venv ripgrep jq zstd \
      sudo unzip zip xz-utils wget file gnupg lsb-release openssh-client \
      musl-tools \
 && rm -rf /var/log/apt /var/log/dpkg.log /var/cache/debconf/*-old

# Docker, for workflow jobs: the CLI with Buildx and Compose, and the
# Engine (dockerd, containerd, runc), which the runner starts as a job's
# own the first time the job uses it (crates/runner/src/docker). From
# Docker's own repository, its signing key checked against the fingerprint
# Docker publishes. Nothing here runs until a job asks for it.
ARG DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && GNUPGHOME="$(mktemp -d)" gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc \
      | grep -q "^fpr:::::::::${DOCKER_KEY_FINGERPRINT}:" \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-unsafe-io \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/log/apt /var/log/dpkg.log /var/cache/debconf/*-old \
 && docker --version && dockerd --version && docker buildx version && docker compose version

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

USER root

# What Java, .NET and Ruby need from the system: ICU for .NET, and the
# headers that gems with native extensions compile against (Ruby's own
# were built with them).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-unsafe-io \
      libicu72 libyaml-dev libffi-dev zlib1g-dev libgmp-dev libreadline-dev \
 && rm -rf /var/log/apt /var/log/dpkg.log /var/cache/debconf/*-old

# Java: Eclipse Temurin 21 (LTS), from Adoptium, in the tool cache under
# the name `actions/setup-java` gives it (Adoptium's semver with `+`
# written as `-`), with the `x64.complete` marker it checks for. The JDK's
# source archive is left out.
ARG TEMURIN_RELEASE=jdk-21.0.12.1+1
ARG TEMURIN_TOOLCACHE_VERSION=21.0.12-101.0.LTS
ARG TEMURIN_SHA256=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94
RUN file="$(echo "${TEMURIN_RELEASE#jdk-}" | tr + _)" \
 && tag="$(echo "${TEMURIN_RELEASE}" | sed 's/+/%2B/')" \
 && curl -fsSLo /tmp/jdk.tgz "https://github.com/adoptium/temurin21-binaries/releases/download/${tag}/OpenJDK21U-jdk_x64_linux_hotspot_${file}.tar.gz" \
 && echo "${TEMURIN_SHA256}  /tmp/jdk.tgz" | sha256sum -c - \
 && dir="/home/runner/_tool/Java_Temurin-Hotspot_jdk/${TEMURIN_TOOLCACHE_VERSION}" \
 && mkdir -p "$dir/x64" \
 && tar -C "$dir/x64" --strip-components=1 -xzf /tmp/jdk.tgz \
 && rm -f /tmp/jdk.tgz "$dir/x64/lib/src.zip" \
 && touch "$dir/x64.complete" \
 && chown -R node:node /home/runner/_tool
ENV JAVA_HOME=/home/runner/_tool/Java_Temurin-Hotspot_jdk/${TEMURIN_TOOLCACHE_VERSION}/x64
ENV JAVA_HOME_21_X64=${JAVA_HOME}

# .NET: the SDK 8 (LTS), from Microsoft's builds, checked against the
# SHA-512 in its release metadata. In /usr/share/dotnet, owned by the
# job's user, so `actions/setup-dotnet` can add other SDKs beside it. The
# SDK's translated messages (about 100 MB) are left out: it speaks English.
ARG DOTNET_SDK_VERSION=8.0.425
ARG DOTNET_SDK_SHA512=934b8060a7190e5909ad1fd0785db542f487b3bbf6cdd14826b02095fdd0d0394298b1634085eff302928fccc33f7c1a7253e9b87df555fc36fce819bcd2e798
RUN curl -fsSLo /tmp/dotnet.tgz "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz" \
 && echo "${DOTNET_SDK_SHA512}  /tmp/dotnet.tgz" | sha512sum -c - \
 && mkdir -p /usr/share/dotnet \
 && tar -C /usr/share/dotnet -xzf /tmp/dotnet.tgz \
 && rm /tmp/dotnet.tgz \
 && find /usr/share/dotnet/sdk -type d \( -name cs -o -name de -o -name es -o -name fr -o -name it \
      -o -name ja -o -name ko -o -name pl -o -name pt-BR -o -name ru -o -name tr -o -name zh-Hans -o -name zh-Hant \) \
      -prune -exec rm -rf {} + \
 && chown -R node:node /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_MULTILEVEL_LOOKUP=0

# Ruby 3.3, built from ruby-lang.org's source in the tool cache, where
# `ruby/setup-ruby` looks on a Debian machine (its prebuilt Rubies are for
# other systems), with the `x64.complete` marker it checks for. The prefix
# is fixed when Ruby is built, so it is built in place. One step, so the
# source and objects never reach a layer, and the previous base's inline
# cache covers it.
ARG RUBY_VERSION=3.3.12
ARG RUBY_SHA256=b06d63beae271933033e27f0a389bc582a009e7845357d44365c39de525a051b
RUN prefix="/home/runner/_tool/Ruby/${RUBY_VERSION}/x64" \
 && curl -fsSLo /tmp/ruby.tgz "https://cache.ruby-lang.org/pub/ruby/${RUBY_VERSION%.*}/ruby-${RUBY_VERSION}.tar.gz" \
 && echo "${RUBY_SHA256}  /tmp/ruby.tgz" | sha256sum -c - \
 && mkdir /tmp/ruby && tar -C /tmp/ruby --strip-components=1 -xzf /tmp/ruby.tgz \
 && cd /tmp/ruby \
 && ./configure --prefix="$prefix" --enable-shared --disable-install-doc \
 && make -j"$(nproc)" \
 && make install \
 && cd / && rm -rf /tmp/ruby /tmp/ruby.tgz \
 && "$prefix/bin/ruby" -ropenssl -rpsych -rzlib -rfiddle -e 'puts RUBY_DESCRIPTION' \
 && touch "$prefix.complete" \
 && chown -R node:node "/home/runner/_tool/Ruby"
ENV PATH=${JAVA_HOME}/bin:/home/runner/_tool/Ruby/${RUBY_VERSION}/x64/bin:$PATH

USER node

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
