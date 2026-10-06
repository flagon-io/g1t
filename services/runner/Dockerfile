# syntax=docker/dockerfile:1.7
#
# The sandbox a g1t agent works in, and where workflow jobs and g1t.page
# builds run: the base image (services/runner/base/Dockerfile, everything
# but the runner) and the g1t runner, a static Linux binary built outside
# Docker by scripts/build-runner.mjs.
#
# Built by scripts/deploy.mjs, which passes BASE (the image recorded in
# services/runner/base.json) and uses a build context holding only the
# binary, so this takes seconds. docs/DEPLOYING.md explains the two images.

ARG BASE
FROM ${BASE}
COPY --chmod=0755 g1t-runner /usr/local/bin/g1t-runner
ENTRYPOINT ["g1t-runner"]
