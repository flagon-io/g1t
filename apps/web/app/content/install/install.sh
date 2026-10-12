#!/bin/sh
# Installs the g1t CLI on Linux or macOS:
#
#   curl -fsSL https://g1t.sh/install | sh
#
# It downloads the build for this system from g1t.sh/downloads/cli, checks it
# against the release's SHA256SUMS, and puts it in ~/.local/bin.
#
#   G1T_INSTALL_DIR  where to put g1t (default: ~/.local/bin)
#   G1T_VERSION      a version to install, such as 0.2.0 (default: the latest)
#
# Docs: https://docs.g1t.sh/guides/cli/
set -eu

base="${G1T_DOWNLOAD_URL:-https://g1t.sh/downloads/cli}"
version="${G1T_VERSION:-latest}"
version="${version#v}"
dir="${G1T_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() {
	say "g1t install: $*"
	exit 1
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=macos ;;
MINGW* | MSYS* | CYGWIN*) fail "on Windows, run this in PowerShell instead: irm https://g1t.sh/install.ps1 | iex" ;;
*) fail "there is no build for $(uname -s)." ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "there is no build for $(uname -m)." ;;
esac
# An Intel shell on Apple silicon (Rosetta) gets the native build.
if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi
file="g1t-$os-$arch"

if command -v curl >/dev/null 2>&1; then
	get() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
	get() { wget -q -O "$2" "$1"; }
else
	fail "this needs curl or wget."
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading g1t ($version, $os $arch)..."
get "$base/$version/$file" "$tmp/g1t" || fail "could not download $base/$version/$file."
get "$base/$version/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/$version/SHA256SUMS."

# A name may carry sha256sum's binary-mode `*`.
want="$(awk -v f="$file" '{ sub(/^[*]/, "", $2) } $2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || fail "SHA256SUMS names no $file."
if command -v sha256sum >/dev/null 2>&1; then
	have="$(sha256sum "$tmp/g1t" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
	have="$(shasum -a 256 "$tmp/g1t" | awk '{ print $1 }')"
else
	fail "this needs sha256sum or shasum to check the download."
fi
[ "$want" = "$have" ] || fail "the download's SHA-256 is $have, not $want. Nothing was installed."

chmod +x "$tmp/g1t"
mkdir -p "$dir" || fail "could not make $dir. Set G1T_INSTALL_DIR to a directory you can write to."
mv "$tmp/g1t" "$dir/g1t" || fail "could not write $dir/g1t. Set G1T_INSTALL_DIR to a directory you can write to."

say "Installed $("$dir/g1t" --version) to $dir/g1t"
case ":$PATH:" in
*":$dir:"*) ;;
*) say "$dir is not on your PATH. Add it to your shell's profile: export PATH=\"$dir:\$PATH\"" ;;
esac
say "Next: g1t auth login"
