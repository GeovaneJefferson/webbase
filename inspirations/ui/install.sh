#!/bin/bash

APP_NAME="TimeMachine"
APPIMAGE_FILE="TimeMachine-1.0.0-x86_64.AppImage"

echo "🚀 Installing $APP_NAME..."

# 1. Copy AppImage to user's applications folder
mkdir -p ~/.local/bin
cp "$APPIMAGE_FILE" ~/.local/bin/
chmod +x ~/.local/bin/"$APPIMAGE_FILE"

# 2. Create desktop entry
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/timemachine.desktop << 'DESKTOP'
[Desktop Entry]
Type=Application
Name=Time Machine
Comment=Linux Backup Application
Exec=$HOME/.local/bin/TimeMachine-1.0.0-x86_64.AppImage
Icon=timemachine
Categories=Utility;System;Archiving;
Terminal=false
DESKTOP

# 3. Copy icon (if exists)
if [ -f "static/icon.png" ]; then
    mkdir -p ~/.local/share/icons/hicolor/256x256/apps
    cp static/icon.png ~/.local/share/icons/hicolor/256x256/apps/timemachine.png
    echo "✓ Icon installed"
fi

# 4. Update desktop database
update-desktop-database ~/.local/share/applications 2>/dev/null || true

echo "✅ Installation complete!"
echo "You can now launch Time Machine from your application menu"
echo ""
echo "To uninstall, run: ./uninstall.sh"
