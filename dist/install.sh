#!/usr/bin/env sh
# dif.sh installer.
#
# Usage:
#   curl -fsSL https://dif.sh/install.sh | sh
#   curl -fsSL https://dif.sh/install.sh | sh -s -- --version v0.1.0
#
# Detects the current platform, downloads the matching dif binary from the
# corresponding GitHub release, and drops it at $DIF_INSTALL_DIR (default
# $HOME/.local/bin). No system writes; no sudo.

set -eu

REPO="dif-sh/dif"
INSTALL_DIR="${DIF_INSTALL_DIR:-$HOME/.local/bin}"
VERSION=""

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2;;
        --version=*) VERSION="${1#*=}"; shift;;
        --dir) INSTALL_DIR="$2"; shift 2;;
        --dir=*) INSTALL_DIR="${1#*=}"; shift;;
        *)
            echo "dif installer: unknown flag '$1'" >&2
            exit 64
            ;;
    esac
done

err() { echo "dif: $*" >&2; exit 1; }

detect_target() {
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os" in
        Darwin)
            case "$arch" in
                arm64) echo "aarch64-apple-darwin";;
                x86_64) echo "x86_64-apple-darwin";;
                *) err "unsupported macOS arch: $arch";;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64) echo "x86_64-unknown-linux-gnu";;
                aarch64|arm64) echo "aarch64-unknown-linux-gnu";;
                *) err "unsupported Linux arch: $arch";;
            esac
            ;;
        *) err "unsupported OS: $os (use the npm or Homebrew install path on Windows)";;
    esac
}

resolve_latest() {
    # If --version wasn't given, ask the GitHub API for the latest tag.
    if [ -n "$VERSION" ]; then
        echo "$VERSION"
        return
    fi
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep -m1 '"tag_name"' \
            | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" \
            | grep -m1 '"tag_name"' \
            | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
    else
        err "neither curl nor wget found in PATH"
    fi
}

download() {
    url="$1"
    out="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$out" "$url"
    else
        err "neither curl nor wget found in PATH"
    fi
}

main() {
    target="$(detect_target)"
    version="$(resolve_latest)"
    [ -n "$version" ] || err "couldn't resolve a version to install"

    archive="dif-${target}.tar.gz"
    url="https://github.com/${REPO}/releases/download/${version}/${archive}"

    tmp="$(mktemp -d 2>/dev/null || mktemp -d -t dif)"
    trap 'rm -rf "$tmp"' EXIT INT TERM

    echo "→ downloading dif ${version} for ${target}"
    download "$url" "${tmp}/${archive}"

    echo "→ extracting"
    tar -xzf "${tmp}/${archive}" -C "$tmp"

    mkdir -p "$INSTALL_DIR"
    install_path="${INSTALL_DIR}/dif"
    mv "${tmp}/dif-${target}/dif" "$install_path"
    chmod +x "$install_path"

    echo "✓ installed ${install_path}"

    case ":$PATH:" in
        *":${INSTALL_DIR}:"*) ;;
        *)
            echo
            echo "note: ${INSTALL_DIR} is not on your PATH."
            echo "      add this line to your shell config:"
            echo "          export PATH=\"${INSTALL_DIR}:\$PATH\""
            ;;
    esac
}

main
