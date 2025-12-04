#!/usr/bin/env python3
"""
Test script to simulate daemon sending activity feed messages and backup progress.
Sends both individual file activities and real-time backup progress updates.

Usage:
    python3 test_activity_feed.py          # Send activities only
    python3 test_activity_feed.py --progress  # Send with progress simulation
"""

import json
import socket
import time
import os
import sys
from pathlib import Path

# Add parent directories to path to import server module
script_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(script_dir))

from static.py.server import SERVER

# Initialize server to get socket path
server = SERVER()
SOCKET_PATH = server.SOCKET_PATH

# Sample activity messages to send
SAMPLE_ACTIVITIES = [
    {
        "type": "file_activity",
        "title": "Backed Up",
        "description": "/home/user/Documents/project_report.pdf",
        "size": 2048576,
        "timestamp": int(time.time()) - 30,
        "status": "success"
    },
    {
        "type": "file_activity",
        "title": "Modified",
        "description": "/home/user/config/.bashrc",
        "size": 4096,
        "timestamp": int(time.time()) - 25,
        "status": "updated"
    },
    {
        "type": "file_activity",
        "title": "Hardlinked",
        "description": "/home/user/Pictures/vacation_2025.jpg",
        "size": 5242880,
        "timestamp": int(time.time()) - 20,
        "status": "success"
    },
    {
        "type": "file_activity",
        "title": "Deleted",
        "description": "/home/user/Downloads/temp_file.tmp",
        "size": 1024,
        "timestamp": int(time.time()) - 15,
        "status": "removed"
    },
    {
        "type": "file_activity",
        "title": "Backed Up",
        "description": "/home/user/Documents/spreadsheet_2025.xlsx",
        "size": 1048576,
        "timestamp": int(time.time()) - 10,
        "status": "success"
    },
]


def generate_progress_messages():
    """Generate simulated backup progress messages."""
    progress_messages = []
    total_files = 150
    total_bytes = 5 * 1024 * 1024 * 1024  # 5 GB
    
    # Generate progress updates from 0% to 100%
    for i in range(0, 101, 5):
        progress = i / 100.0
        files_completed = int(total_files * progress)
        bytes_processed = int(total_bytes * progress)
        
        message = {
            "type": "backup_progress",
            "progress": progress,
            "status": "running" if i < 100 else "completed",
            "current_file": f"/home/user/file_{files_completed:03d}.dat" if i < 100 else None,
            "files_completed": files_completed,
            "total_files": total_files,
            "bytes_processed": bytes_processed,
            "total_bytes": total_bytes,
            "eta": f"{int((100 - i) / 5) * 1} min" if i < 100 else "Done!",
            "timestamp": int(time.time())
        }
        progress_messages.append(message)
    
    return progress_messages


def send_message(message):
    """Send a JSON message to the UI via UNIX socket."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(SOCKET_PATH)
            message_str = json.dumps(message) + "\n"
            s.sendall(message_str.encode("utf-8"))
            
            # Format output based on message type
            if message['type'] == 'file_activity':
                filename = message['description'].split('/')[-1]
                print(f"✓ Activity: {message['title']:<12} - {filename}")
            elif message['type'] == 'backup_progress':
                progress = int(message['progress'] * 100)
                print(f"✓ Progress: {progress:3d}% | {message['files_completed']}/{message['total_files']} files | ETA: {message['eta']}")
            
            return True
    except Exception as e:
        print(f"✗ Error sending message: {e}")
        return False


def main():
    """Main test function."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Test Activity Feed with optional progress simulation')
    parser.add_argument('--progress', action='store_true', help='Also send backup progress updates')
    args = parser.parse_args()
    
    print("\n" + "="*80)
    print("  ACTIVITY FEED TEST SCRIPT - File Activities & Backup Progress".center(80))
    print("="*80)
    print(f"Socket path: {SOCKET_PATH}\n")
    
    if not os.path.exists(SOCKET_PATH):
        print("⚠ WARNING: Socket not found. Make sure the Flask app is running!")
        print(f"   Expected socket at: {SOCKET_PATH}\n")
        response = input("Continue anyway? (y/n): ").strip().lower()
        if response != 'y':
            return
    
    print("Test Mode: ", end="")
    if args.progress:
        print("Activities + Backup Progress Simulation\n")
    else:
        print("Activities Only\n")
    
    print("-" * 80)
    print("SENDING FILE ACTIVITIES...")
    print("-" * 80)
    
    for i, message in enumerate(SAMPLE_ACTIVITIES, 1):
        send_message(message)
        time.sleep(1.0)  # Wait 1 second between messages
    
    if args.progress:
        print("\n" + "-" * 80)
        print("SIMULATING BACKUP PROGRESS...")
        print("-" * 80 + "\n")
        
        progress_messages = generate_progress_messages()
        for message in progress_messages:
            send_message(message)
            time.sleep(0.5)  # Send progress updates every 0.5 seconds
    
    print("\n" + "="*80)
    print("✓ Test complete! Check the browser for updates.".center(80))
    print("="*80 + "\n")


if __name__ == "__main__":
    main()
