#!/usr/bin/env python3
"""
AppImage Builder for Flask/Electron Backup Application
Usage: python3 build_appimage.py
"""

import os
import sys
import shutil
import subprocess
import urllib.request
from pathlib import Path

class AppImageBuilder:
    def __init__(self):
        self.app_name = "TimeMachine"
        self.app_version = "1.0.0"
        self.build_dir = Path("build")
        self.appdir = self.build_dir / f"{self.app_name}.AppDir"
        
    def clean_build(self):
        """Remove previous build artifacts"""
        print("🧹 Cleaning previous build...")
        if self.build_dir.exists():
            shutil.rmtree(self.build_dir)
        self.build_dir.mkdir(exist_ok=True)
        
    def create_appdir_structure(self):
        """Create AppDir structure"""
        print("📁 Creating AppDir structure...")
        
        # Create directory structure
        dirs = [
            self.appdir,
            self.appdir / "usr" / "bin",
            self.appdir / "usr" / "lib",
            self.appdir / "usr" / "share" / "applications",
            self.appdir / "usr" / "share" / "icons" / "hicolor" / "256x256" / "apps",
            self.appdir / "opt" / self.app_name
        ]
        
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)
            
    def copy_application_files(self):
        """Copy application files to AppDir"""
        print("📦 Copying application files...")
        
        app_dest = self.appdir / "opt" / self.app_name
        
        # Files and directories to copy
        items_to_copy = [
            "app.py",
            "main.js",
            "config",
            "static",
            "templates",
            "node_modules",
            "package.json",
            "Requirements.txt"
        ]
        
        for item in items_to_copy:
            src = Path(item)
            if src.exists():
                if src.is_file():
                    shutil.copy2(src, app_dest / item)
                    print(f"  ✓ Copied {item}")
                else:
                    shutil.copytree(src, app_dest / item, dirs_exist_ok=True)
                    print(f"  ✓ Copied {item}/")
            else:
                print(f"  ⚠ Skipping {item} (not found)")
                
    def install_python_dependencies(self):
        """Install Python dependencies into AppDir"""
        print("🐍 Installing Python dependencies...")
        
        app_dest = self.appdir / "opt" / self.app_name
        requirements = Path("Requirements.txt")
        
        if not requirements.exists():
            print("  ⚠ Requirements.txt not found, skipping dependency installation")
            return
        
        # Method 1: Try direct pip install to target directory (most reliable)
        lib_path = app_dest / "lib" / "python-packages"
        lib_path.mkdir(parents=True, exist_ok=True)
        
        print("  Installing packages directly to lib directory...")
        try:
            result = subprocess.run([
                sys.executable, "-m", "pip", "install",
                "-r", str(requirements),
                "--target", str(lib_path),
                "--no-warn-script-location",
                "--no-cache-dir"
            ], capture_output=True, text=True, check=True)
            
            print("  ✓ Python dependencies installed successfully")
            return
            
        except subprocess.CalledProcessError as e:
            print(f"  ❌ Failed to install dependencies: {e.stderr}")
            raise
            
    def create_desktop_file(self):
        """Create .desktop file"""
        print("🖥️  Creating desktop file...")
        
        desktop_content = f"""[Desktop Entry]
Type=Application
Name={self.app_name}
Comment=Linux Backup Application
Exec=AppRun
Icon={self.app_name.lower()}
Categories=Utility;System;Archiving;
Terminal=false
"""
        
        desktop_file = self.appdir / f"{self.app_name}.desktop"
        desktop_file.write_text(desktop_content)
        
        # Also copy to share/applications
        shutil.copy2(
            desktop_file,
            self.appdir / "usr" / "share" / "applications" / f"{self.app_name}.desktop"
        )
        print("  ✓ Desktop file created")
        
    def create_icon(self):
        """Create or copy application icon"""
        print("🎨 Setting up icon...")
        
        icon_dest = (self.appdir / "usr" / "share" / "icons" / "hicolor" / 
                     "256x256" / "apps" / f"{self.app_name.lower()}.png")
        
        # Look for existing icon in static directory
        possible_icons = [
            Path("static/vendor/favicon.png"),
            Path("static/vendor/favicon.ico"),
            Path("static/icon.png"),
            Path("static/images/icon.png"),
            Path("static/logo.png"),
            Path("icon.png")
        ]
        
        icon_found = False
        for icon_path in possible_icons:
            if icon_path.exists():
                shutil.copy2(icon_path, icon_dest)
                shutil.copy2(icon_path, self.appdir / f"{self.app_name.lower()}.png")
                print(f"  ✓ Icon copied from {icon_path}")
                icon_found = True
                break
                
        if not icon_found:
            print("  ⚠ No icon found. Consider adding one at static/icon.png")
            # Create a placeholder
            (self.appdir / f"{self.app_name.lower()}.png").touch()
            
    def create_apprun(self):
        """Create AppRun script"""
        print("⚙️  Creating AppRun script...")
        
        app_dest = self.appdir / "opt" / self.app_name
        lib_path = app_dest / "lib" / "python-packages"
        
        # Check if packages were installed
        if lib_path.exists():
            python_setup = f"""# Add Python packages to path
export PYTHONPATH="${{APPDIR}}/opt/{self.app_name}/lib/python-packages:${{PYTHONPATH}}"
"""
        else:
            python_setup = "# No additional Python packages\n"
        
        # Check if node_modules and main.js exists (Electron app)
        has_electron = Path("main.js").exists() and Path("node_modules").exists()
        
        if has_electron:
            # Launch both Flask and Electron
            apprun_content = f"""#!/bin/bash
APPDIR="$(dirname "$(readlink -f "${{0}}")")"
export PATH="${{APPDIR}}/usr/bin:${{PATH}}"
export LD_LIBRARY_PATH="${{APPDIR}}/usr/lib:${{LD_LIBRARY_PATH}}"

{python_setup}
# Change to app directory
cd "${{APPDIR}}/opt/{self.app_name}"

# Check if Flask is already running
if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "Flask already running on port 5000, skipping backend start..."
else
    # Start Flask backend in background
    python3 app.py > /tmp/timemachine_flask.log 2>&1 &
    FLASK_PID=$!
    echo "Started Flask backend (PID: $FLASK_PID)"
    
    # Wait for Flask to start
    sleep 2
fi

# Start Electron frontend with no-sandbox flag
"${{APPDIR}}/opt/{self.app_name}/node_modules/electron/dist/electron" "${{APPDIR}}/opt/{self.app_name}/main.js" --no-sandbox

# Clean up Flask process when Electron closes (only if we started it)
if [ ! -z "$FLASK_PID" ]; then
    kill $FLASK_PID 2>/dev/null
fi
"""
        else:
            # Flask only
            apprun_content = f"""#!/bin/bash
APPDIR="$(dirname "$(readlink -f "${{0}}")")"
export PATH="${{APPDIR}}/usr/bin:${{PATH}}"
export LD_LIBRARY_PATH="${{APPDIR}}/usr/lib:${{LD_LIBRARY_PATH}}"

{python_setup}
# Change to app directory
cd "${{APPDIR}}/opt/{self.app_name}"

# Start the application
python3 app.py "$@"
"""
        
        apprun_file = self.appdir / "AppRun"
        apprun_file.write_text(apprun_content)
        apprun_file.chmod(0o755)
        print("  ✓ AppRun script created")
        if has_electron:
            print("  ℹ️  Will launch both Flask backend and Electron frontend")
        
    def download_appimagetool(self):
        """Download appimagetool if not present"""
        print("🔧 Checking for appimagetool...")
        
        tool_path = self.build_dir / "appimagetool-x86_64.AppImage"
        
        if not tool_path.exists():
            print("  Downloading appimagetool...")
            url = "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
            try:
                urllib.request.urlretrieve(url, tool_path)
                tool_path.chmod(0o755)
                print("  ✓ appimagetool downloaded")
            except Exception as e:
                print(f"  ❌ Failed to download appimagetool: {e}")
                print("  Please download manually from:")
                print(f"  {url}")
                raise
        else:
            print("  ✓ appimagetool already present")
            
        return tool_path
        
    def build_appimage(self, appimagetool):
        """Build the final AppImage"""
        print("🏗️  Building AppImage...")
        
        output_name = f"{self.app_name}-{self.app_version}-x86_64.AppImage"
        
        env = os.environ.copy()
        env['ARCH'] = 'x86_64'
        
        try:
            result = subprocess.run([
                str(appimagetool),
                str(self.appdir),
                output_name
            ], check=True, env=env, capture_output=True, text=True)
            
            print(f"✅ AppImage built successfully: {output_name}")
            print(f"   Size: {Path(output_name).stat().st_size / 1024 / 1024:.2f} MB")
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Error building AppImage:")
            print(e.stderr)
            return False
            
    def build(self):
        """Main build process"""
        print(f"🚀 Building {self.app_name} AppImage...")
        print("=" * 50)
        
        try:
            self.clean_build()
            self.create_appdir_structure()
            self.copy_application_files()
            self.install_python_dependencies()
            self.create_desktop_file()
            self.create_icon()
            self.create_apprun()
            appimagetool = self.download_appimagetool()
            
            if self.build_appimage(appimagetool):
                print("=" * 50)
                print("🎉 Build completed successfully!")
                print(f"")
                print(f"To run your AppImage:")
                print(f"  ./{self.app_name}-{self.app_version}-x86_64.AppImage")
                print(f"")
                print(f"To make it executable:")
                print(f"  chmod +x {self.app_name}-{self.app_version}-x86_64.AppImage")
            else:
                print("=" * 50)
                print("❌ Build failed. Please check the errors above.")
                sys.exit(1)
                
        except Exception as e:
            print(f"❌ Build failed with error: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)

if __name__ == "__main__":
    builder = AppImageBuilder()
    builder.build()