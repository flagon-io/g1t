# syntax=docker/dockerfile:1.7
#
# The self-hosted runner's image: `g1t-runner` with a Docker Engine of its
# own, for Sysbox. The runner starts `dockerd` inside this container and
# runs each job in a fresh container on it, so jobs are containers inside
# the runner's container and nothing reaches the machine: Sysbox gives the
# container its own user namespace (its root is no one on the machine) and
# lets it run Docker without --privileged. Never mount the machine's
# /var/run/docker.sock: the runner refuses to start when it sees one.
#
#   docker run -d --name g1t-runner --restart unless-stopped \
#     --runtime=sysbox-runc \
#     -v g1t-runner:/data \
#     -e G1T_RUNNER_URL=https://g1t.sh -e G1T_RUNNER_TOKEN=g1trt_… \
#     g1t.sh/flagon-io/g1t-runner
#
# PID 1 is docker-init (tini), which supervises g1t-runner and reaps what it
# leaves; g1t-runner supervises dockerd (crates/runner/src/selfhosted/engine.rs).
# git, bash and Node stay for host mode (G1T_RUNNER_NO_DOCKER=1), which is
# deprecated.
#
# Build context: a folder holding `g1t-runner` for the image's platform,
# the static Linux build that scripts/runner-release.mjs makes (or
# scripts/build-runner.mjs, for x64). The release workflow builds and
# pushes it for linux/amd64 and linux/arm64.

# Docker's static builds: the engine, containerd, runc, the CLI, tini.
FROM docker:28-dind AS docker

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl iptables procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /home/runner
COPY --from=docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 \
     /usr/local/bin/ctr /usr/local/bin/runc /usr/local/bin/docker-proxy /usr/local/bin/docker-init \
     /usr/local/bin/docker /usr/local/bin/
COPY --chmod=0755 g1t-runner /usr/local/bin/g1t-runner
# Its configuration and credential live on this volume. Sysbox keeps the
# engine's /var/lib/docker on the machine's disk for this container alone.
ENV G1T_RUNNER_DIR=/data \
    G1T_RUNNER_SANDBOX=nested
VOLUME /data
ENTRYPOINT ["docker-init", "--", "g1t-runner"]
CMD ["register-and-run"]
