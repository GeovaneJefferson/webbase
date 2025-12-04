cat > uninstall.sh << 'EOF'
#!/bin/bash

echo "🗑️  Uninstalling Time Machine..."

rm -f ~/.local/bin/TimeMachine-1.0.0-x86_64.AppImage
rm -f ~/.local/share/applications/timemachine.desktop
rm -f ~/.local/share/icons/hicolor/256x256/apps/timemachine.png

update-desktop-database ~/.local/share/applications 2>/dev/null || true

echo "✅ Uninstalled successfully"
EOF

chmod +x uninstall.sh