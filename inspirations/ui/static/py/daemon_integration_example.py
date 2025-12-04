#!/usr/bin/env python3
"""
DAEMON INTEGRATION EXAMPLE

This shows how to integrate the Activity Feed and Backup Progress with your real daemon.
Copy and adapt these patterns into your daemon.py or backup code.
"""

import json
import socket
import time
from server import *

# Get the socket path from server config
server = SERVER()
SOCKET_PATH = server.SOCKET_PATH


def send_ui_update(msg: dict):
    """Send a structured JSON update to the UI via UNIX socket."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(SOCKET_PATH)
            s.sendall((json.dumps(msg) + "\n").encode("utf-8"))
            print(f"[Daemon] Sent UI update: {msg.get('type')}")
    except Exception as e:
        print(f"[Daemon] Could not send UI update: {e}")


# ============================================================================
# EXAMPLE 1: Send File Activity Updates
# ============================================================================
def backup_file(file_path, backup_size):
    """Example function that sends file activity updates."""
    try:
        # Do the backup...
        print(f"[Daemon] Backing up {file_path}...")
        
        # Send success notification
        send_ui_update({
            "type": "file_activity",
            "title": "Backed Up",
            "description": file_path,
            "size": backup_size,
            "timestamp": int(time.time()),
            "status": "success"
        })
    except Exception as e:
        # Send error notification
        send_ui_update({
            "type": "file_activity",
            "title": "Error",
            "description": file_path,
            "size": 0,
            "timestamp": int(time.time()),
            "status": "error"
        })


# ============================================================================
# EXAMPLE 2: Send Backup Progress Updates
# ============================================================================
class BackupProgressTracker:
    """Track and send backup progress to UI."""
    
    def __init__(self, total_files, total_bytes):
        self.total_files = total_files
        self.total_bytes = total_bytes
        self.files_completed = 0
        self.bytes_processed = 0
        self.current_file = None
        self.start_time = time.time()
    
    def update(self, file_path, file_size):
        """Update progress when a file is backed up."""
        self.current_file = file_path
        self.files_completed += 1
        self.bytes_processed += file_size
        
        # Calculate progress
        progress = self.bytes_processed / self.total_bytes if self.total_bytes > 0 else 0
        progress = min(progress, 1.0)  # Cap at 100%
        
        # Calculate ETA
        elapsed = time.time() - self.start_time
        if progress > 0:
            total_time = elapsed / progress
            remaining = total_time - elapsed
            eta_minutes = int(remaining / 60)
            eta_str = f"{eta_minutes} min" if eta_minutes > 0 else "< 1 min"
        else:
            eta_str = "Calculating..."
        
        # Send progress update
        send_ui_update({
            "type": "backup_progress",
            "progress": progress,
            "status": "running",
            "current_file": file_path,
            "files_completed": self.files_completed,
            "total_files": self.total_files,
            "bytes_processed": self.bytes_processed,
            "total_bytes": self.total_bytes,
            "eta": eta_str,
            "timestamp": int(time.time())
        })
    
    def complete(self):
        """Mark backup as complete."""
        send_ui_update({
            "type": "backup_progress",
            "progress": 1.0,
            "status": "completed",
            "current_file": None,
            "files_completed": self.total_files,
            "total_files": self.total_files,
            "bytes_processed": self.total_bytes,
            "total_bytes": self.total_bytes,
            "eta": "Done!",
            "timestamp": int(time.time())
        })


# ============================================================================
# EXAMPLE 3: Integration in Your Backup Function
# ============================================================================
def run_full_backup(files_to_backup):
    """
    Example full backup function.
    
    Args:
        files_to_backup: List of (file_path, size) tuples
    """
    total_files = len(files_to_backup)
    total_bytes = sum(size for _, size in files_to_backup)
    
    # Initialize progress tracker
    tracker = BackupProgressTracker(total_files, total_bytes)
    
    print(f"[Daemon] Starting backup of {total_files} files ({total_bytes / (1024**3):.2f} GB)")
    
    try:
        for file_path, file_size in files_to_backup:
            try:
                # Do the actual backup
                print(f"[Daemon] Backing up {file_path}...")
                # ... backup logic here ...
                time.sleep(0.5)  # Simulate backup time
                
                # Update progress
                tracker.update(file_path, file_size)
                
            except Exception as e:
                print(f"[Daemon] Error backing up {file_path}: {e}")
                # Optionally send error activity
                send_ui_update({
                    "type": "file_activity",
                    "title": "Error",
                    "description": file_path,
                    "size": 0,
                    "timestamp": int(time.time()),
                    "status": "error"
                })
        
        # Mark as complete
        tracker.complete()
        print("[Daemon] Backup completed successfully!")
        
    except Exception as e:
        print(f"[Daemon] Backup failed: {e}")
        send_ui_update({
            "type": "backup_progress",
            "progress": tracker.bytes_processed / tracker.total_bytes,
            "status": "failed",
            "current_file": None,
            "files_completed": tracker.files_completed,
            "total_files": tracker.total_files,
            "bytes_processed": tracker.bytes_processed,
            "total_bytes": tracker.total_bytes,
            "eta": "Error occurred",
            "timestamp": int(time.time())
        })


# ============================================================================
# TESTING
# ============================================================================
if __name__ == "__main__":
    print("\n" + "="*70)
    print("DAEMON INTEGRATION EXAMPLES")
    print("="*70 + "\n")
    
    # Example 1: Send individual file activities
    print("Example 1: Sending file activities...")
    print("-" * 70)
    backup_file("/home/user/Documents/report.pdf", 2048576)
    backup_file("/home/user/Pictures/photo.jpg", 5242880)
    time.sleep(1)
    
    # Example 2: Simulate a full backup with progress
    print("\nExample 2: Backup with progress tracking...")
    print("-" * 70)
    
    # Simulate 20 files
    test_files = [
        (f"/home/user/file_{i:03d}.dat", 1024 * 1024 * (i % 10 + 1))
        for i in range(20)
    ]
    
    run_full_backup(test_files)
    
    print("\n" + "="*70)
    print("Integration examples complete!")
    print("="*70 + "\n")
