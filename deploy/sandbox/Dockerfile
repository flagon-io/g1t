# syntax=docker/dockerfile:1.7
#
# The sandbox's Linux: what `g1t-runner sandbox up` runs on a person's own
# computer, in a VM of the runner's own (crates/runner/src/selfhosted/launcher/).
# It holds a Docker Engine with Sysbox and the runner's binary; the runner
# itself runs as the runner's image (deploy/runner/Dockerfile) under
# `--runtime=sysbox-runc`, as on a Linux server, and each job is a container
# inside that. Three walls from the computer: the job's container, the
# runner's Sysbox container, and the VM.
#
# Two targets, built by scripts/sandbox-image.mjs for each release:
#
#   wsl  A root filesystem for a WSL distribution on Windows (`wsl --import`),
#        with /etc/wsl.conf turning off drives, Windows programs and PATH.
#   vm   The same with a kernel and systemd, made into a disk for a VM on
#        macOS (vfkit) or Linux (QEMU) with no shared folders.
#
# Build context: this folder plus `g1t-runner`, the static Linux build for
# the image's platform.

FROM docker:28-dind AS docker

FROM debian:bookworm-slim AS sysbox
ARG TARGETARCH
# Sysbox 0.7 or later: earlier ones cannot run runc 1.2's checks of /proc
# inside a Sysbox container ("unsafe procfs detected"), which Docker 28's
# runc does. Pinned by SHA-256.
ARG SYSBOX_VERSION=0.7.1
ARG SYSBOX_SHA256_AMD64=9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5
ARG SYSBOX_SHA256_ARM64=04ca894ae0b53f0fa54eaacc173ce40363c9a95ea5450f773716a84ef650a69b
ADD https://github.com/nestybox/sysbox/releases/download/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}.linux_${TARGETARCH}.deb /tmp/sysbox.deb
RUN expected="$([ "$TARGETARCH" = arm64 ] && echo "$SYSBOX_SHA256_ARM64" || echo "$SYSBOX_SHA256_AMD64")" \
 && echo "$expected  /tmp/sysbox.deb" | sha256sum -c - \
 && dpkg-deb -x /tmp/sysbox.deb /tmp/sysbox \
 && mkdir -p /out && cp /tmp/sysbox/usr/bin/sysbox-runc /tmp/sysbox/usr/bin/sysbox-mgr /tmp/sysbox/usr/bin/sysbox-fs /out/

FROM debian:bookworm-slim AS base
# iptables: the engine's networks and the rules that keep jobs off the
# computer; rsync and fuse3: Sysbox's; e2fsprogs and util-linux: the VM's
# state disk.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates iptables rsync fuse3 procps kmod e2fsprogs util-linux \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && mkdir -p /var/lib/g1t-sandbox/state /etc/docker
COPY --from=docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 \
     /usr/local/bin/runc /usr/local/bin/docker-proxy /usr/local/bin/docker-init /usr/local/bin/docker /usr/local/bin/
COPY --from=sysbox /out/ /usr/local/bin/
COPY --chmod=0755 g1t-runner /usr/local/bin/g1t-runner
ARG IMAGE_VERSION=dev
RUN echo "$IMAGE_VERSION" > /etc/g1t-sandbox-version

FROM base AS wsl
COPY wsl.conf /etc/wsl.conf

FROM base AS vm
# A kernel, an init, and the unit that runs the sandbox at boot. The VM's
# console (hvc0) is where it says how it is (launcher/vm.rs reads it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv "linux-image-cloud-$(dpkg --print-architecture)" \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && echo g1t-sandbox > /etc/hostname \
 && systemctl mask getty@tty1.service serial-getty@hvc0.service serial-getty@ttyS0.service
COPY g1t-sandbox.service /etc/systemd/system/g1t-sandbox.service
COPY vm-network.network /etc/systemd/network/80-g1t.network
RUN systemctl enable g1t-sandbox.service systemd-networkd.service systemd-resolved.service
