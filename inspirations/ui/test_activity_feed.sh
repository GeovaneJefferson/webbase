#!/bin/bash
# Quick start script for testing the Activity Feed

echo "=================================="
echo "Activity Feed Quick Test"
echo "=================================="
echo ""

# Check if we're in the right directory
if [ ! -f "app.py" ]; then
    echo "❌ Error: app.py not found in current directory"
    echo "Please run this from: /home/geovane/MEGA/python/html/webbase/inspirations/ui"
    exit 1
fi

echo "📋 Setting up..."
echo ""

# Start Flask server in background
echo "🚀 Starting Flask server..."
python3 app.py &
FLASK_PID=$!
echo "   Flask PID: $FLASK_PID"
echo ""

# Wait for server to start
echo "⏳ Waiting 3 seconds for server to start..."
sleep 3

# Check if server is running
if ! ps -p $FLASK_PID > /dev/null; then
    echo "❌ Flask server failed to start"
    exit 1
fi
echo "✓ Flask server running"
echo ""

# Open browser
echo "🌐 Opening browser..."
sleep 1
if command -v firefox &> /dev/null; then
    firefox http://127.0.0.1:5000 &
elif command -v google-chrome &> /dev/null; then
    google-chrome http://127.0.0.1:5000 &
elif command -v chromium &> /dev/null; then
    chromium http://127.0.0.1:5000 &
else
    echo "⚠️  Please open your browser to: http://127.0.0.1:5000"
fi
echo ""

echo "📝 Instructions:"
echo "  1. Open browser DevTools (F12)"
echo "  2. Go to Console tab"
echo "  3. You should see: [WebSocket] ✓ Connected to activity feed"
echo "  4. In a NEW terminal, run: python3 static/py/test_activity_feed.py"
echo "  5. Watch the Live Activity Feed table update in real-time"
echo ""

echo "⏹️  To stop: Press Ctrl+C in this terminal"
echo ""

# Keep script running
wait $FLASK_PID
