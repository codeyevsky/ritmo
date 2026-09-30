#!/usr/bin/env bash
# Geliştirme kabuğu: rustup PATH'i ve RUST_LOG'u ayarlayıp tauri dev'i başlatır.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export RUST_LOG="${RUST_LOG:-ritmo=debug,warn}"
# WebKitGTK'nın DMA-BUF yolu bazı Mesa sürümlerinde boş pencere veriyor; devre
# dışı bırakmak geliştirmede güvenli ve görünür bir maliyeti yok.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
cd "$(dirname "$0")/.."
exec pnpm dev:desktop "$@"
