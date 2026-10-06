# syntax=docker/dockerfile:1.7
#
# The self-hosted runner's image: `g1t-runner`, the Docker CLI (to start
# each job in a sibling container through the host's Docker socket), and
# what a job needs to run in this container itself with --no-docker
# (git, bash, Node), for Kubernetes pods that take one job each.
#
#   docker run -d --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock -v g1t-runner:/data \
#     -e G1T_RUNNER_URL=https://g1t.sh -e G1T_RUNNER_TOKEN=g1trt_… \
#     flagonio/g1t-runner
#
# Build context: a folder holding `g1t-runner` for the image's platform,
# the static Linux build that scripts/runner-release.mjs makes (or
# scripts/build-runner.mjs, for x64). The release workflow builds and
# pushes it for linux/amd64 and linux/arm64.

FROM docker:28-cli AS docker

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /home/runner && chown -R node:node /data /home/runner
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --chmod=0755 g1t-runner /usr/local/bin/g1t-runner
# Its configuration and credential live on this volume.
ENV G1T_RUNNER_DIR=/data
VOLUME /data
ENTRYPOINT ["g1t-runner"]
CMD ["register-and-run"]
