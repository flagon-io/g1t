#!/usr/bin/env bash
# What the desktop app's Windows cross build needs on g1t's Linux machines,
# besides cargo-xwin: Debian's packages (scripts/apt-install.sh, from the
# job's cache when it has them), the names cargo-xwin runs LLVM's tools by,
# and an NSIS header Debian lacks. desktop-release.yml's Windows build and
# caches.yml, which keeps its cache warm on main, both run it.
set -euo pipefail

bash "$(dirname "$0")/apt-install.sh" tauri-windows
# cargo-xwin compiles C (ring's, among others) with clang-cl and
# links with lld-link and llvm-lib. Each is a mode of a tool
# Debian does install, chosen by the name it is run as: clang-cl
# is clang, lld-link is lld, and llvm-lib is llvm-ar. Debian ships
# none of the three names, so each is linked to its tool.
for pair in clang-cl:clang lld-link:lld llvm-lib:llvm-ar; do
  name="${pair%%:*}" tool="${pair##*:}"
  command -v "$name" >/dev/null && continue
  found="$(command -v "$tool" || ls /usr/lib/llvm-*/bin/"$tool" 2>/dev/null | sort -V | tail -1)"
  [ -n "$found" ] || { echo "::error::$tool is not installed, so there is no $name"; exit 1; }
  sudo ln -sf "$(readlink -f "$found")" "/usr/local/bin/$name"
  echo "$name: $(readlink -f "$found")"
done
# Tauri's installer script includes Win\RestartManager.nsh, which
# NSIS ships from 3.10 on; Debian's is 3.08. The header stands
# alone (defines and System calls), so it is added from NSIS 3.11's
# source, checked against its SHA-256.
rm_nsh=/usr/share/nsis/Include/Win/RestartManager.nsh
if [ ! -f "$rm_nsh" ]; then
  curl -fsSL --retry 3 -o /tmp/RestartManager.nsh https://raw.githubusercontent.com/kichik/nsis/v311/Include/Win/RestartManager.nsh
  echo "67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e  /tmp/RestartManager.nsh" | sha256sum -c -
  sudo install -m 0644 /tmp/RestartManager.nsh "$rm_nsh"
fi
