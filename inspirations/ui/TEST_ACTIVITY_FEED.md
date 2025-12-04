# Activity Feed Testing Guide

## Overview
This guide explains how to test the live activity feed websocket functionality.

## Prerequisites
- Flask server running (`python3 app.py`)
- Browser open to `http://127.0.0.1:5000`

## Running the Test

### Step 1: Start the Flask Server
```bash
cd /home/geovane/MEGA/python/html/webbase/inspirations/ui
python3 app.py
```

Output should include:
```
[IPC] Listening for daemon on UNIX socket: /tmp/timemachine_socket.sock
 * Running on http://127.0.0.1:5000
```

### Step 2: Open Browser and Check Console
1. Navigate to `http://127.0.0.1:5000`
2. Open DevTools: Press `F12` or `Ctrl+Shift+I`
3. Go to the **Console** tab
4. You should see:
   ```
   [WebSocket] Attempting to connect to ws://127.0.0.1:5000/ws/transfers-feed
   [WebSocket] ✓ Connected to activity feed
   ```

### Step 3: Run the Test Script
In a **new terminal window**, run:
```bash
cd /home/geovane/MEGA/python/html/webbase/inspirations/ui/static/py
python3 test_activity_feed.py
```

Expected output:
```
======================================================================
ACTIVITY FEED TEST SCRIPT
======================================================================
Socket path: /tmp/timemachine_socket.sock

Starting to send test messages...

[1/5] ✓ Sent: Backed Up - project_report.pdf
[2/5] ✓ Sent: Modified - .bashrc
[3/5] ✓ Sent: Hardlinked - vacation_2025.jpg
[4/5] ✓ Sent: Deleted - temp_file.tmp
[5/5] ✓ Sent: Backed Up - spreadsheet_2025.xlsx

======================================================================
Test complete! Check the browser for the activity feed updates.
======================================================================
```

### Step 4: Check Results
In the browser:
1. Look at the **Live Activity Feed** table on the Overview tab
2. You should see the 5 test entries appear in the table
3. Check the browser **Console** for:
   ```
   [WebSocket] Received message: {type: 'file_activity', ...}
   ```

## Troubleshooting

### "Firefox can't establish a connection to ws://..."
**Problem**: The websocket connection is refused.

**Solutions**:
1. Make sure Flask server is running: `python3 app.py`
2. Check that the socket port 5000 is accessible
3. Try restarting Flask: Kill the process and run again
4. Check firewall settings

### Socket path error in test script
**Problem**: `[Error]: Connection refused` when running test script

**Solutions**:
1. Verify Flask server is running (`ps aux | grep app.py`)
2. Check socket path matches: Both should use `/tmp/timemachine_socket.sock`
3. Ensure the config file exists: `config/config.conf`

### Activity feed shows no entries
**Problem**: Test runs but feed stays empty

**Solutions**:
1. Check browser console for JavaScript errors
2. Verify `ActivityFeedManager.init()` was called (should see no errors)
3. Check server console for broadcast errors
4. Make sure you're on the "Overview" tab where the feed is visible

## Expected Behavior

### Server Console Output
```
[IPC] Listening for daemon on UNIX socket: /tmp/timemachine_socket.sock
[WebSocket] New client connected. Total clients: 1
[WebSocket] Received from client: {"type":"client_connected","timestamp":1234567890}
[WebSocket] Received from client: {"type":"file_activity",...}
```

### Browser Console Output
```
[WebSocket] ✓ Connected to activity feed
[WebSocket] Received message: {type: 'file_activity', title: 'Backed Up', ...}
```

### Live Activity Feed Table
| File Name | Status | Size | Snapshot | Time |
|-----------|--------|------|----------|------|
| spreadsheet_2025.xlsx | Backed Up | 1.0 MB | View Snapshots | just now |
| temp_file.tmp | Deleted | 1 KB | View Snapshots | 1 sec ago |
| vacation_2025.jpg | Hardlinked | 5.0 MB | View Snapshots | 2 sec ago |
| .bashrc | Modified | 4 KB | View Snapshots | 3 sec ago |
| project_report.pdf | Backed Up | 2.0 MB | View Snapshots | 4 sec ago |

## Message Format Reference

The test script sends messages in this format:
```json
{
  "type": "file_activity",
  "title": "Backed Up",
  "description": "/full/path/to/file.ext",
  "size": 2048576,
  "timestamp": 1700000000,
  "status": "success"
}
```

Supported titles:
- `"Backed Up"` → Green badge
- `"Modified"` → Blue badge
- `"Hardlinked"` → Green badge
- `"Deleted"` → Red badge
- `"Moved"` → Yellow badge
- `"Renamed"` → Yellow badge

## Integration with Daemon

When the real daemon runs, it will send messages via:
```python
send_ui_update({
    "type": "file_activity",
    "title": "Backed Up",
    "description": "/path/to/file",
    "size": file_size,
    "timestamp": int(time.time()),
    "status": "success"
})
```

The Flask app receives these messages and broadcasts them to all connected websocket clients.
