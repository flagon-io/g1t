#!/usr/bin/env bash
# sccache for a workflow's Rust builds. Every rustc call that makes a
# library is looked up by what it compiles (sources, flags, toolchain,
# dependencies) in the repository's Actions cache, the one `actions/cache`
# uses, through sccache's GitHub Actions backend. A checkout gives every
# source file a new mtime, so Cargo calls rustc again for the workspace's
# own crates however much of `target/` was restored; with sccache, the
# crates whose inputs did not change come back from the cache instead of
# being compiled. Binaries, cdylibs (a Worker's own crate), proc macros and
# test harnesses are linked, and sccache compiles those as before.
#
#   bash scripts/sccache.sh install   # a step before the first cargo
#   bash scripts/sccache.sh stats     # the last step, with if: always()
#
# install downloads the pinned release and checks its sha256, starts the
# server (which reads and writes a check entry in the cache), and only then
# sets RUSTC_WRAPPER for the steps after it. If anything there fails, the
# job builds as it did without sccache, and the step says why.
# stats prints the server's hits and misses, and adds them to the job's
# summary.
#
# See docs/DEPLOYING.md ("Build speed") and the Actions guide's
# "Caching Rust builds".
set -euo pipefail

VERSION=0.18.0
TARGET=x86_64-unknown-linux-musl
# sccache-v0.18.0-x86_64-unknown-linux-musl.tar.gz, from the release's
# .sha256 file.
SHA256=45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89

BIN="$HOME/.cargo/bin"
SCCACHE="$BIN/sccache"

# What sccache and Cargo read, here and in the steps after this one.
export SCCACHE_GHA_ENABLED=true
# One server for the whole job: its statistics are the job's.
export SCCACHE_IDLE_TIMEOUT=0
# If the server goes away mid-build, rustc runs without it.
export SCCACHE_IGNORE_SERVER_IO_ERROR=1
# sccache cannot cache incremental builds; a fresh checkout gains nothing
# from them anyway.
export CARGO_INCREMENTAL=0

warn() { echo "::warning title=sccache::$1, so this job builds without it"; }

fetch() {
  local name="sccache-v${VERSION}-${TARGET}"
  local dir="${RUNNER_TEMP:-/tmp}/sccache-${VERSION}"
  if [ -x "$SCCACHE" ] && [ "$("$SCCACHE" --version 2>/dev/null | awk '{print $2}')" = "$VERSION" ]; then
    return 0
  fi
  mkdir -p "$dir" "$BIN"
  curl -fsSL --retry 3 -o "$dir/$name.tar.gz" "https://github.com/mozilla/sccache/releases/download/v${VERSION}/${name}.tar.gz" || return 1
  echo "${SHA256}  $dir/$name.tar.gz" | sha256sum -c --quiet - || return 1
  tar -xzf "$dir/$name.tar.gz" -C "$dir" || return 1
  install -m 0755 "$dir/$name/sccache" "$SCCACHE"
}

install_sccache() {
  if [ -z "${ACTIONS_RUNTIME_TOKEN:-}" ] || [ -z "${ACTIONS_CACHE_URL:-}${ACTIONS_RESULTS_URL:-}" ]; then
    warn "The job has no Actions cache to use (ACTIONS_RUNTIME_TOKEN, ACTIONS_CACHE_URL)"
    return 0
  fi
  if ! fetch; then
    warn "sccache ${VERSION} could not be downloaded or did not match its checksum"
    return 0
  fi
  if ! "$SCCACHE" --start-server; then
    warn "sccache's server did not start (it could not read the cache)"
    return 0
  fi
  {
    echo "RUSTC_WRAPPER=$SCCACHE"
    echo "SCCACHE_GHA_ENABLED=$SCCACHE_GHA_ENABLED"
    echo "SCCACHE_IDLE_TIMEOUT=$SCCACHE_IDLE_TIMEOUT"
    echo "SCCACHE_IGNORE_SERVER_IO_ERROR=$SCCACHE_IGNORE_SERVER_IO_ERROR"
    echo "CARGO_INCREMENTAL=$CARGO_INCREMENTAL"
  } >> "$GITHUB_ENV"
  echo "sccache ${VERSION}: rustc goes through it from here on, cached in this repository's Actions cache."
}

stats() {
  if [ -z "${RUSTC_WRAPPER:-}" ] || [ ! -x "$SCCACHE" ]; then
    echo "sccache was not used in this job."
    return 0
  fi
  local out
  out="$("$SCCACHE" --show-stats 2>&1)" || true
  echo "$out"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### sccache"
      echo
      echo '```'
      echo "$out"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

case "${1:-}" in
  install) install_sccache ;;
  stats) stats ;;
  *)
    echo "usage: bash scripts/sccache.sh install|stats" >&2
    exit 2
    ;;
esac
