#!/bin/bash
set -e

# ==============================================================================
# KumaDrive macOS DMG Generator
# Produces a clean, production-ready, Universal (Apple Silicon + Intel) DMG
# ==============================================================================

# Deriva o diretório do projeto a partir da localização deste script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_APP="$PROJECT_DIR/src-tauri/target/release/bundle/macos/KumaDrive.app"
DIST_DIR="$PROJECT_DIR/release-dist"
OUTPUT_DMG="$DIST_DIR/kumadrive.dmg"
BUNDLE_DMG="$PROJECT_DIR/src-tauri/target/release/bundle/dmg/kumadrive.dmg"
ICON_ICNS="$PROJECT_DIR/src-tauri/icons/icon.icns"
STAGE_DIR="/tmp/kumadrive_dmg_staging_$$"

echo "=== [1/6] Cleaning up previous artifacts ==="
rm -rf "$STAGE_DIR"
rm -f "$OUTPUT_DMG" "$BUNDLE_DMG"
mkdir -p "$STAGE_DIR"
mkdir -p "$DIST_DIR"
mkdir -p "$(dirname "$BUNDLE_DMG")"

# Prefer freshly compiled app from target/release/bundle/macos
if [ -d "$SRC_APP" ]; then
    echo "=== [2/6] Copying freshly built KumaDrive.app from $SRC_APP ==="
    cp -R "$SRC_APP" "$STAGE_DIR/KumaDrive.app"
elif [ -f "$DIST_DIR/KumaDrive_universal.app.tar.gz" ]; then
    echo "=== [2/6] Extracting KumaDrive.app from universal tarball ==="
    tar -xzf "$DIST_DIR/KumaDrive_universal.app.tar.gz" -C "$STAGE_DIR/"
else
    echo "ERROR: Neither $SRC_APP nor tarball found."
    exit 1
fi

echo "=== [3/6] Setting permissions & stripping quarantine ==="
chmod -R u+w "$STAGE_DIR/KumaDrive.app"
chmod 755 "$STAGE_DIR/KumaDrive.app/Contents/MacOS/KumaDrive"
xattr -cr "$STAGE_DIR/KumaDrive.app" 2>/dev/null || true

echo "=== [4/6] Re-signing KumaDrive.app with clean ad-hoc signature ==="
codesign --force --deep --sign - "$STAGE_DIR/KumaDrive.app"
codesign --verify --deep --verbose "$STAGE_DIR/KumaDrive.app"

echo "=== [5/6] Adding installer helper files & Applications symlink ==="
ln -s /Applications "$STAGE_DIR/Applications"
cp "$DIST_DIR/Install KumaDrive.command" "$STAGE_DIR/Install KumaDrive.command"
chmod +x "$STAGE_DIR/Install KumaDrive.command"
cp "$DIST_DIR/How to Install.html" "$STAGE_DIR/How to Install.html"
cp "$DIST_DIR/README.txt" "$STAGE_DIR/README.txt"

if [ -f "$ICON_ICNS" ]; then
    cp "$ICON_ICNS" "$STAGE_DIR/.VolumeIcon.icns"
    if command -v SetFile >/dev/null 2>&1; then
        SetFile -a C "$STAGE_DIR" 2>/dev/null || true
    fi
fi

# Clean up unwanted DS_Store or dotfiles
find "$STAGE_DIR" -name ".DS_Store" -delete 2>/dev/null || true

echo "=== [6/6] Creating compressed UDZO disk image (kumadrive.dmg) ==="
hdiutil create -volname "KumaDrive" \
               -srcfolder "$STAGE_DIR" \
               -ov \
               -format UDZO \
               "$OUTPUT_DMG"

cp "$OUTPUT_DMG" "$BUNDLE_DMG" 2>/dev/null || true
mkdir -p "$PROJECT_DIR/distribution"
cp "$OUTPUT_DMG" "$PROJECT_DIR/distribution/kumadrive.dmg"

# If /Applications/KumaDrive.app exists, update it with the freshly signed app
if [ -d "/Applications/KumaDrive.app" ]; then
    echo "=== Updating /Applications/KumaDrive.app with latest build ==="
    rm -rf "/Applications/KumaDrive.app"
    cp -R "$STAGE_DIR/KumaDrive.app" "/Applications/KumaDrive.app"
    xattr -cr "/Applications/KumaDrive.app" 2>/dev/null || true
fi

# Clean up staging
rm -rf "$STAGE_DIR"

echo "=============================================================================="
echo "Build complete!"
echo "Output DMG: $OUTPUT_DMG"
echo "Size: $(ls -lh "$OUTPUT_DMG" | awk '{print $5}')"
echo "=============================================================================="
