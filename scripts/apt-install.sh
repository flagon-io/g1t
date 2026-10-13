#!/usr/bin/env bash
# Installs a named set of Debian packages, from the job's cache when it has
# them. CI's desktop job spent 110 s of its 175 s here on every run: 21 s
# on `apt-get update`, 35 s downloading 335 MB, the rest unpacking.
#
#   bash scripts/apt-install.sh tauri            # Tauri's build on Linux
#   bash scripts/apt-install.sh tauri-windows    # its Windows cross build
#
# apt's package lists and downloaded .debs are kept in ~/.cache/apt/<set>,
# which the workflow restores and saves with actions/cache under
# apt-<os>-<set>-<hash of this file>, so changing a set here starts a new
# entry. With them restored, the install runs offline (--no-download); when
# that fails (a list out of date for a package the image already has newer,
# say) or nothing was restored, it updates the lists and downloads as
# before, tried three times, since the mirror has answered with a
# mismatched package before. An entry lives at most 28 days, so the lists
# are never older than that.
set -euo pipefail

set_name="${1:-}"
case "$set_name" in
  tauri)
    packages=(libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev)
    ;;
  tauri-windows)
    packages=(build-essential curl wget file libssl-dev libayatana-appindicator3-dev nsis clang lld llvm)
    ;;
  *)
    echo "usage: bash scripts/apt-install.sh tauri|tauri-windows" >&2
    exit 2
    ;;
esac

dir="$HOME/.cache/apt/$set_name"
mkdir -p "$dir/archives/partial" "$dir/lists/partial"
apt=(sudo apt-get -o "Dir::Cache::Archives=$dir/archives" -o "Dir::State::Lists=$dir/lists" -y)

# The cache's files go back into it as this user, and apt leaves its
# partial folders readable by root alone.
mine() { sudo chown -R "$(id -u):$(id -g)" "$dir"; }
trap mine EXIT

if compgen -G "$dir/lists/*_Packages*" >/dev/null && "${apt[@]}" install --no-download "${packages[@]}"; then
  echo "Installed ${#packages[@]} packages from the cache."
  exit 0
fi

for try in 1 2 3; do
  if "${apt[@]}" update && "${apt[@]}" install "${packages[@]}"; then
    # Only what this install used is kept.
    "${apt[@]}" autoclean >/dev/null 2>&1 || true
    exit 0
  fi
  sudo rm -rf "$dir/archives/partial/"*
  sleep 15
done
exit 1
