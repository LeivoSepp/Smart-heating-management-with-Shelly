#!/usr/bin/env bash
set -euo pipefail

ESPRUINO_REPO=https://github.com/espruino/Espruino.git
ESPRUINO_COMMIT=e73051ad4b9380a562da40796626254af1a19d57 # 2v29, 2026-10-06 "fix classic ESP32 build"
DOCKER_IMAGE=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
CONTAINER=shelly-espruino-build-$$

here=$(cd "$(dirname "$0")" && pwd)
workdir=${ESPRUINO_WORKDIR:-$(mktemp -d)}
src=$workdir/espruino

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ -z "${ESPRUINO_WORKDIR:-}" ]; then
        rm -rf "$workdir"
    fi
}
trap cleanup EXIT

checkout() {
    if [ ! -d "$src/.git" ]; then
        git init -q "$src"
        git -C "$src" remote add origin "$ESPRUINO_REPO"
    fi
    git -C "$src" fetch -q --depth 1 origin "$ESPRUINO_COMMIT"
    git -C "$src" checkout -q -f FETCH_HEAD
    git -C "$src" clean -fdxq
    git -C "$src" apply "$here/espruino-shelly.patch"
}

# docker cp instead of a bind mount: Docker Desktop shares only some host paths
build() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CONTAINER" "$DOCKER_IMAGE" sleep infinity >/dev/null
    docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER" bash -c \
        "apt-get update -qq && apt-get install -y -qq gcc-multilib g++-multilib make python3 python-is-python3 git >/dev/null"
    docker exec "$CONTAINER" bash -c "mkdir -p /src && git config --global --add safe.directory /src"
    tar -C "$src" -cf - . | docker cp - "$CONTAINER:/src"
    docker exec "$CONTAINER" bash -c \
        'cd /src && mkdir -p bin && LDFLAGS="-Winline -g -static" make BOARD=LINUX_SHELLY ARCHFLAGS=-m32 -j"$(nproc)" >/build.log 2>&1 || { tail -20 /build.log; exit 1; }'
    docker cp "$CONTAINER:/src/bin/espruino" "$here/bin/espruino"
}

mkdir -p "$here/bin"
checkout
build
echo "Built $here/bin/espruino from Espruino $ESPRUINO_COMMIT"
