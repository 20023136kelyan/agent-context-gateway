#!/bin/sh
# Build ContextGatewayMenu.app from the Swift package (ad-hoc signed, local use).
set -e
cd "$(dirname "$0")/.."
xcrun --sdk macosx swift build -c release --package-path ui
BIN="ui/.build/release/GatewayMenuApp"
APP="ContextGatewayMenu.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ContextGatewayMenu"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ContextGatewayMenu</string>
  <key>CFBundleIdentifier</key><string>dev.gateway.context-menu</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>ContextGatewayMenu</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --deep -s - "$APP" 2>/dev/null || true
echo "Built $APP"
