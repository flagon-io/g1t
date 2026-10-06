# syntax=docker/dockerfile:1.7
#
# g1t's reviewer as a ReviewBench agent image: the g1t sandbox's base image
# (the Claude Code CLI and toolchains production reviews run with) plus the
# contract adapter in agent/. Built by `node bench/reviewbench/run.mjs build`,
# which passes BASE from services/runner/base.json and regenerates
# agent/instructions.txt from crates/runner/src/review.rs first.
#
# linux/amd64, as the contract requires.

ARG BASE
FROM --platform=linux/amd64 ${BASE}
COPY agent/ /bench/
# /work/change.diff and /work/review.json are where the production prompt
# tells the agent to read and write; the benchmark mounts the rest of /work.
RUN mkdir -p /work && chmod 0777 /work
ENTRYPOINT ["node", "/bench/agent.mjs"]
