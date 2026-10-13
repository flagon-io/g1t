# syntax=docker/dockerfile:1.7
#
# The sandbox workflow jobs, g1t.page builds and g1t's own work (the merge
# queue, merge checks, dependency updates, backups) run in: the base image
# (services/runner/base/Dockerfile, everything but the runner) and the g1t
# runner, a static Linux binary built outside Docker by
# scripts/build-runner.mjs.
#
# Deploys do not build this file: scripts/deploy/registry.mjs makes the
# same image in the registry, adding one layer with the binary to the
# base's layers (the same path, mode and entrypoint; a test in
# scripts/deploy holds the two together), so a deploy job never pulls the
# base. scripts/deploy.mjs builds it with Docker for a dry run, or when
# that fails, passing BASE (the image recorded in services/runner/base.json)
# and a build context holding only the binary.

ARG BASE
FROM ${BASE}
COPY --chmod=0755 g1t-runner /usr/local/bin/g1t-runner
ENTRYPOINT ["g1t-runner"]
