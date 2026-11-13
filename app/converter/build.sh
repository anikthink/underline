#!/bin/sh
# Builds the EPUB-to-AZW3 converter (spikes/azw3) as Tauri's bundled helper.
# Tauri looks for binaries/epub2azw3-<target triple>; see externalBin in tauri.conf.json.
set -e
cd "$(dirname "$0")"
triple=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p ../src-tauri/binaries
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "../src-tauri/binaries/epub2azw3-$triple" .
echo "built src-tauri/binaries/epub2azw3-$triple"
