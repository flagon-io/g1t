#!/usr/bin/env bash
# Finds g1t-runner for the g1t/deploy and g1t/detect actions and prints its
# path: G1T_RUNNER if it names one, else the one on PATH (g1t's machines
# have it at /usr/local/bin/g1t-runner), else the newest release from
# g1t.sh/downloads/runner, checked against that release's SHA256SUMS, as
# docs.g1t.sh/guides/self-hosted-runners/ downloads it.
#
# actions/deploy/runner.sh and actions/detect/runner.sh are the same file:
# each action is published as a repository of its own.
set -euo pipefail

if [ -n "${G1T_RUNNER:-}" ] && [ -x "${G1T_RUNNER}" ]; then
  echo "${G1T_RUNNER}"
  exit 0
fi
if found="$(command -v g1t-runner 2>/dev/null)"; then
  echo "${found}"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) platform=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  Darwin-arm64) platform=macos-arm64 ;;
  Darwin-x86_64) platform=macos-x64 ;;
  *)
    echo "::error::g1t-runner is not on PATH, and g1t has no release of it for $(uname -s) $(uname -m)." >&2
    exit 1
    ;;
esac

downloads="${G1T_RUNNER_DOWNLOADS:-https://g1t.sh/downloads/runner/latest}"
dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/g1t-runner-${platform}"
file="g1t-runner-${platform}"
if [ ! -x "${dir}/g1t-runner" ]; then
  mkdir -p "${dir}"
  echo "Downloading ${file} from ${downloads}" >&2
  curl -fsSL --retry 3 -o "${dir}/${file}" "${downloads}/${file}"
  curl -fsSL --retry 3 -o "${dir}/SHA256SUMS" "${downloads}/SHA256SUMS"
  expected="$(awk -v name="${file}" '$2 == name { print $1 }' "${dir}/SHA256SUMS")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${dir}/${file}" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "${dir}/${file}" | awk '{ print $1 }')"
  fi
  if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then
    echo "::error::The downloaded ${file} does not match the release's SHA256SUMS." >&2
    rm -f "${dir}/${file}"
    exit 1
  fi
  chmod +x "${dir}/${file}"
  mv "${dir}/${file}" "${dir}/g1t-runner"
fi
echo "${dir}/g1t-runner"
