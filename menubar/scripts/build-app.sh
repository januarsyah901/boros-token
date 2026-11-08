#!/usr/bin/env bash
# Build BorosBar.app with swiftc + ad-hoc codesign (no SwiftPM, no paid certificate).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
swiftc -O -parse-as-library -target "$(uname -m)-apple-macos14.0" $(find Sources -name '*.swift') -o build/BorosBar
APP="build/BorosBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp build/BorosBar "$APP/Contents/MacOS/BorosBar"
cp Resources/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "OK -> $APP"
echo "Run:  open $APP"
