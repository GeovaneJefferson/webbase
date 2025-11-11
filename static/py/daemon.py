"""
# compile and run tests (verbose)
python3 -m py_compile static/py/daemon_new.py && python3 -m unittest discover -v tests
"""

"""
Hybrid Daemon: Incremental, Atomic, and Concurrent File Backup Service

This module implements a background daemon that incrementally backs up a
source tree into a backup location with emphasis on speed, integrity, and
recoverability.

High-level backup steps for each file
------------------------------------
1. Pre-flight checks
   - _check_backup_errors() verifies the backup target is accessible and writable.
   - On failure the daemon will retry (with a sleep) and allow cooperative
     cancellation (graceful or immediate) while waiting.

2. Scan / Decide (fast path)
   - _pre_flight_scan() walks the source tree and compares file mtimes with
     persisted metadata.
   - If a file's mtime is unchanged, the file is skipped (fast path).
   - If mtime changed or file is new, the file is hashed (SHA-256) to confirm
     content changes and to detect moved/renamed files.

3. Deduplication via hardlinks
   - If a file's hash matches an already-backed-up file, the daemon will try to
     create a hardlink to the existing content instead of copying data.
   - Hardlink creation is journaled so interrupted link operations can be
     retried during journal replay.

4. Atomic copy for new/modified content
   - Files that need real data transfer are copied to a unique temporary file
     next to the final destination.
   - After the full copy completes, the temp file is atomically renamed to the
     final destination (os.replace/os.rename).
   - File data and directory metadata are fsynced where practical to ensure
     durability.

5. Journaling and recovery
   - All link and copy starts are recorded in an append-only journal (JSONL).
   - Each journal entry marks start and completion; incomplete entries are
     discovered and acted upon during startup via Journal.replay().
   - Replay attempts to validate temp files (via hash/size), move tmp->dst, or
     remove corrupt tmp files, and will recreate links if possible.

6. Metadata persistence
   - The daemon updates an in-memory metadata map and periodically persists it
     to disk using atomic replace (write temp -> fsync -> os.replace).
   - Metadata contains per-file path, mtime, size, and hash used for future runs.

7. Concurrency and cooperative cancellation
   - File operations are submitted to a ThreadPoolExecutor; concurrency adapts
     to system load (CPU-based throttle).
   - Cancellation is cooperative:
     - Graceful cancel (cancel_event set): new files are not started; currently
       running file operations finish normally.
     - Immediate cancel (immediate_cancel True): in-progress copy operations
       abort quickly; temporary files are left for journal replay to handle.
   - A small control UNIX socket accepts cancel commands for external control.

Error handling and robustness
-----------------------------
- Explicit logging: all recoverable and critical errors are logged at the
  appropriate level (debug/info/warning/error/critical).
- UI notifications: important errors and status changes are sent to the UI
  via send_to_ui() (JSON messages) when possible.
- Permission / connectivity failures: _check_backup_errors() retries with a
  delay and allows cancellation while waiting; read-only or permission errors
  are reported to the UI.
- Disk space: _check_disk_space() checks free space and aborts the run if
  insufficient space is detected; non-fatal check failures are logged and the
  run continues with caution.
- Journal-backed recovery: interrupted copy/link operations leave either a
  temp file or a partially recorded journal entry; on startup the journal is
  replayed to either complete valid tmp files (move -> dst) or clean corrupted
  tmp files. Link retries are attempted for interrupted link operations.
- Atomic metadata writes: metadata is written to a temp file and atomically
  replaced to avoid corrupt metadata files on crash.
- Best-effort fsyncs: fsync of files and directories is attempted where
  supported, but failures are non-fatal and logged.
- Broad exception containment: high-level operations catch exceptions to avoid
  crashing the daemon; critical failures are reported to the UI and logged
  with stack traces where relevant.

Operational notes
-----------------
- The daemon favors availability and recoverability: when immediate cancel is
  requested it leaves artifacts for the journal to reconcile rather than trying
  risky removals.
- The design minimizes unnecessary I/O by skipping files whose mtime did not
  change and by using hardlinks whenever the same content already exists in
  the backup.
- Journal replay is intentionally conservative: it never removes a live dst
  file and avoids making destructive assumptions; manual inspection is possible
  when replay cannot reconcile an entry.
"""
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from server import *
# from static.py.server import *
import os
import time
import logging
import json
import asyncio
import shutil
import hashlib
import socket
import errno
import sys
import psutil
import functools 
import random
import uuid
import threading
import fnmatch
import tempfile

try:
    import setproctitle
except ImportError:
    setproctitle = None # type: ignore

# --- GLOBAL SHARED STATE ---
server = SERVER()

daemon_state_lock = threading.Lock()


# =============================================================================
# CONSTANTS & STUBS (For self-contained execution)
# =============================================================================
HIGH_CPU_THRESHOLD = 75.0  # CPU% threshold to reduce concurrency
MINIMUM_FREE_SPACE_BYTES = 5  # 5 GB


# =============================================================================
# IPC / UI COMMUNICATION
# =============================================================================
def send_ui_update(msg: dict):
    """Send a structured JSON update to the local UI."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.connect(server.SOCKET_PATH)
            s.sendall((json.dumps(msg) + "\n").encode("utf-8"))
    except Exception as e:
        # Don't crash the daemon if UI isn't open
        print(f"[Daemon] Could not send UI update: {e}")

# Helper function to run the blocking socket operation
# This runs in a separate thread managed by asyncio.to_thread
def _send_message_blocking(socket_path: str, timeout: int, message_data: dict) -> bool:
    """Synchronous, blocking function to send message via UNIX socket."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)  # Ensure timeout is set
            sock.connect(socket_path)
            message_str = json.dumps(message_data) + "\n"
            sock.sendall(message_str.encode("utf-8"))
            return True
    except socket.timeout:
        logging.debug(f"[MessageSender] Socket timeout after {timeout}s")
        return False
    except Exception as e:
        logging.debug(f"[MessageSender] Failed to send message: {e}")
        return False
    
# =============================================================================
# FILE UTILITIES
# =============================================================================
def calculate_sha256(file_path: str, chunk_size: int = 65536) -> str:
    """Calculates the SHA256 hash of a file in chunks."""
    try:
        hasher = hashlib.sha256()
        with open(file_path, 'rb') as file:
            while chunk := file.read(chunk_size):
                hasher.update(chunk)
        return hasher.hexdigest()
    except Exception as e:
        logging.error(f"Failed to hash file {file_path}: {e}")
        return ""

# =============================================================================
# DAEMON LOGIC
# =============================================================================
class Daemon:
    def __init__(self):
        # Normalize source_root to a canonical absolute path to avoid relpath inconsistencies
        # self.users_home_dir = os.path.normpath(os.path.expanduser("~"))
        self.users_home_dir = os.path.expanduser("~") + "/Downloads"  # Main backup root path
        self.app_main_backup_dir = server.app_main_backup_dir()  # Main backup root path
        self.app_incremental_backup_dir = server.app_incremental_backup_dir()  # Current incremental backup path
        self.max_threads =  4  # Max threads for I/O
        self.wait_time_minutes = 5  # Minutes between backup checks
        self.executor = ThreadPoolExecutor(max_workers=self.max_threads)
        self.metadata = {}
        self.hash_to_path_map = {} # Maps content hash to the latest backup path
        # metadata flush batching
        self.metadata_flush_every = 100  # Number of metadata entries between flushes
        self._metadata_dirty_count = 0

        # Excludes
        self.excludes_extras = [".git", "node_modules", ".temp", "*.tmp"]

        # Configure journal with fsync batching
        self.journal = Journal()
        self.journal.fsync_every = 100  # Number of journal entries between fsyncs

        # State tracking for the current run
        self.files_to_backup = []
        self.total_transfer_size = 0
        self.files_backed_up_count = 0
        self.total_files_to_transfer = 0
        self.total_size_transferred = 0
        self.run_start_time = 0

        # Set up a lock for state updates
        self.state_lock = threading.Lock()

        # Initialize MessageSender
        self.message_sender = MessageSender()
        self.backup_start_time = None  # Timestamp when backup started
        self.current_analyzing_folder = None  # Current folder being analyzed

        # Cached exclusion settings for the current run
        self._exclude_hidden = False
        self._exclusion_patterns = set()
        
        # Initialize Journal for recovery
        # self.journal = Journal(self.app_main_backup_dir)

        # Cancellation support (cooperative)
        self.cancel_event = threading.Event()
        self.immediate_cancel = False
        # Control socket path for cancel requests (separate from UI socket)
        self.control_socket_path = server.SOCKET_PATH + ".ctrl"
        # Start control server thread
        try:
            self._control_thread = threading.Thread(target=self._control_server, daemon=True)
            self._control_thread.start()
        except Exception:
            logging.debug("Failed to start control server thread; continuing without it.")

        # Start optional system suspend/resume handler (uses dbus-next if available)
        try:
            self._sleep_thread = threading.Thread(target=self._setup_sleep_handler, daemon=True)
            self._sleep_thread.start()
        except Exception:
            logging.debug("Sleep handler not started (dbus integration unavailable).")

    def _control_server(self):
        """
        Small UNIX socket server to accept commands like {"command":"cancel","mode":"graceful"}.
        Runs in a daemon thread started by the Daemon instance.
        """
        sock_path = server.SOCKET_PATH + ".ctrl"
        try:
            if os.path.exists(sock_path):
                os.remove(sock_path)  # Remove stale socket
        except Exception as e:
            logging.warning(f"Failed to remove stale socket: {e}")

        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            srv.bind(sock_path)
            srv.listen(1)
            try:
                os.chmod(sock_path, 0o660)
            except Exception:
                pass

            while True:
                try:
                    conn, _ = srv.accept()
                    with conn:
                        data = b''
                        while True:
                            chunk = conn.recv(4096)
                            if not chunk:
                                break
                            data += chunk
                        if not data:
                            continue
                        try:
                            obj = json.loads(data.decode('utf-8'))
                        except Exception:
                            continue
                        cmd = obj.get('command')
                        if cmd == 'cancel':
                            mode = obj.get('mode', 'graceful')
                            # set cancellation flags
                            self.cancel_event.set()
                            self.immediate_cancel = (mode == 'immediate')
                            try:
                                conn.sendall(b'{"result":"ok"}')
                            except Exception:
                                pass
                        else:
                            try:
                                conn.sendall(b'{"result":"unknown_command"}')
                            except Exception:
                                pass
                except Exception as e:
                    logging.debug(f"control server accept error: {e}")
                    time.sleep(0.1)
        except Exception as e:
            logging.warning(f"Control server failed to start on {sock_path}: {e}")
        finally:
            try:
                srv.close()
            except Exception:
                pass


    # -------------------------
    # Permissions check (pre-backup)
    # -------------------------
    async def _check_backup_errors(self) -> bool:
        """
        Asynchronously verify connection and write permissions for the backup target.
        If the target is not ready, it will wait and retry.
        Returns True if ready, False if the check was cancelled.
        """
        logging.info("Performing initial check for backup location...")

        while True:
            try:
                # Ensure backup target is connected
                if not server.has_driver_connection(self.app_main_backup_dir):
                    logging.critical(f"Backup target not connected or inaccessible: {self.app_main_backup_dir}")
                    raise OSError("Backup target not connected")

                # Ensure backup root exists (mkdirs may fail on read-only)
                os.makedirs(self.app_main_backup_dir, exist_ok=True)

                # Test if the filesystem is read-only
                test_dir = os.path.join(self.app_main_backup_dir, '.perm_test')
                test_file = os.path.join(test_dir, f'.perm_{os.getpid()}')
                
                try:
                    os.makedirs(test_dir, exist_ok=True)
                    
                    # Try to create and write to a test file
                    with open(test_file, 'w', encoding='utf-8') as fh:
                        fh.write('perm-check')
                    
                    # Try to read back
                    with open(test_file, 'r', encoding='utf-8') as fh:
                        content = fh.read()
                    
                    # Try to delete the test file
                    os.remove(test_file)
                    
                    # Try to remove the test directory
                    try:
                        os.rmdir(test_dir)
                    except OSError:
                        # Directory might not be empty, that's OK
                        pass
                        
                    logging.debug(f"Backup permissions OK for {self.app_main_backup_dir}")
                    return True # Success, exit the loop
                    
                except OSError as e:
                    if e.errno == errno.EROFS:
                        # Read-only file system detected
                        logging.critical(f"Backup target is READ-ONLY: {self.app_main_backup_dir}")
                        await self.message_sender.send_warning("Backup device is read-only. Please check the device.")
                        # Wait longer and retry since this is a critical issue
                        logging.info("Waiting 60 seconds before retrying read-only filesystem...")
                        await asyncio.sleep(60)
                        continue
                    else:
                        raise

            except OSError as e:
                if e.errno in (errno.EROFS, errno.EACCES, errno.EPERM):
                    logging.critical(f"Backup target not writable (read-only or permission denied): {self.app_main_backup_dir} ({e})")
                    await self.message_sender.send_warning("Backup device is read-only or not writable.")
                else:
                    logging.error(f"Error testing backup permissions at {self.app_main_backup_dir}: {e}")
                
                # Wait before retrying
                logging.info("Backup location not ready. Waiting for 30 seconds before retrying...")
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    return False
                    
            except Exception as e:
                logging.error(f"Unexpected error during backup check: {e}")
                # Wait before retrying
                logging.info("Backup location not ready. Waiting for 30 seconds before retrying...")
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    return False
        
    def _load_metadata(self):
        """Loads metadata from the backup path."""
        raw_meta = server.get_metadata() or {}
        # Normalize keys to a stable form so relpath comparisons match across runs
        normalized = {}
        for key, val in raw_meta.items():
            try:
                nkey = os.path.normpath(key)
            except Exception:
                nkey = key
            normalized[nkey] = val
        self.metadata = normalized
        self.hash_to_path_map = {
            file_data.get('hash'): file_data.get('path')
            for file_path, file_data in self.metadata.items()
            if file_data.get('hash')
        }
        logging.info(f"Loaded {len(self.metadata)} metadata entries and {len(self.hash_to_path_map)} unique hashes.")

    def _load_exclusion_rules(self):
        """
        Loads and caches exclusion rules from the config for the current backup cycle.
        This prevents re-reading the config file for every single file and folder.
        """
        # 1. Load and cache the "exclude hidden items" setting.
        exclude_hidden_str = server.get_database_value('EXCLUDE', 'exclude_hidden_itens')
        self._exclude_hidden = str(exclude_hidden_str).lower() in ('true', '1', 'yes')

        # 2. Load the comma-separated list of folder paths to exclude.
        excludes_str = server.get_database_value('EXCLUDE_FOLDER', 'folders')
        if not excludes_str:
            self._exclusion_patterns = set()
            return

        # 3. Convert the paths to a set of normalized, absolute paths for efficient checking.
        #    We work with absolute paths to avoid ambiguity.
        abs_paths = {os.path.abspath(p.strip()) for p in excludes_str.split(',') if p.strip()}
        self._exclusion_patterns = abs_paths
        logging.info(f"Loaded {len(self._exclusion_patterns)} exclusion patterns.")

    def _should_exclude(self, source_path: str) -> bool:
        """
        Checks if a given absolute path should be excluded based on cached rules.

        Args:
            source_path: The absolute path of the file or directory to check.

        Returns:
            True if the path should be excluded, False otherwise.
        """
        # --- 1. Check for Hidden Files/Folders ---
        # This check is based on the path components starting with a '.'
        if self._exclude_hidden:
            # Split the path relative to the user's home to check each part.
            relative_to_home = os.path.relpath(source_path, self.users_home_dir)
            if any(part.startswith('.') for part in relative_to_home.split(os.sep)):
                logging.debug(f"Excluding hidden path: {source_path}")
                return True

        # --- 2. Check against the list of excluded absolute paths ---
        # We iterate through the cached set of exclusion patterns.
        for excluded_path in self._exclusion_patterns:
            # A. Check for an exact match.
            if source_path == excluded_path:
                logging.debug(f"Excluding exact path match: {source_path}")
                return True
            # B. Check if the source_path is a sub-path of an excluded folder.
            #    The `os.sep` ensures we don't accidentally match "/path/to/folder"
            #    with "/path/to/folder-other".
            if source_path.startswith(excluded_path + os.sep):
                logging.debug(f"Excluding path inside excluded folder '{excluded_path}': {source_path}")
                return True

        return False

    def _get_concurrent_worker_count(self) -> int:
        """Adjusts worker count based on CPU usage to prevent system slowdown."""
        try:
            # Read disk type from config file. Default to 'hdd' for safety.
            disk_type = server.get_database_value('DEVICE_INFO', 'disk_type') or 'hdd'
            is_ssd = (disk_type == 'ssd')

            # For HDDs, limit workers to avoid I/O contention, regardless of CPU.
            if not is_ssd:
                logging.info("Using conservative worker count for HDD: 2")
                return 2

            # For SSDs, dynamically adjust based on CPU load.
            cpu_percent = psutil.cpu_percent(interval=1)
            if cpu_percent > HIGH_CPU_THRESHOLD:
                new_workers = max(2, self.max_threads // 2)  # Keep at least 2 for SSD
                logging.warning(f"High CPU load ({cpu_percent}%), reducing workers to {new_workers}.")
                return new_workers
            if cpu_percent < 20:
                new_workers = min(16, self.max_threads * 2) # Increase for idle system
                logging.info(f"Low CPU load, increasing workers to {new_workers} for SSD.")
                return new_workers
            return self.max_threads
        except Exception as e:
            logging.error(f"Error determining worker count: {e}. Defaulting to max workers.")
            return self.max_threads

    async def _pre_flight_scan(self):
        """
        Scans source path to determine which files need updating/copying and 
        calculates the total required transfer size.
        """
        self._load_exclusion_rules()  # Load exclusion settings for this run
        self._load_metadata()     # Load existing metadata
        self.files_to_backup = []  # Reset files to backup list
        self.total_transfer_size = 0  # Reset total transfer size
        
        files_scanned = 0
        
        logging.info(f"Starting pre-flight scan of folders: {self.users_home_dir}")
        
        # Send analyzing messages
        await self.message_sender.send_analyzing(
            "Starting file scan...", 
            processed=0,
            progress=0
        )

        # Track files found in current scan to detect deletions/moves
        current_files_found = set()

        for root, dirs, files in os.walk(self.users_home_dir):
            rel_root = os.path.relpath(root, self.users_home_dir)

            logging.debug(f"Scanning: root='{root}', rel_root='{rel_root}'")

            # CRITICAL: Filter directories BEFORE os.walk descends
            dirs[:] = [
                d for d in dirs
                if not self._should_exclude(os.path.join(root, d))
            ]

            folder_files_count = 0
            for file_name in files:
                source_path = os.path.join(root, file_name)

                # Calculate relative path from HOME directory to preserve folder structure
                folder_name_base = os.path.basename(self.users_home_dir)  # "Pictures"
                file_rel_path = os.path.relpath(source_path, self.users_home_dir)
                rel_path = os.path.join(folder_name_base, file_rel_path)  # "Pictures/Screenshots/file.png"

                # DEBUG: Log the path construction
                logging.debug(f"File: {file_name}")
                logging.debug(f"  Source: {source_path}")
                logging.debug(f"  Relative from home: {rel_path}")
                logging.debug(f"  Expected dest: {os.path.join(self.app_main_backup_dir, rel_path)}")

                # Exclusion check
                if self._should_exclude(source_path):
                    continue

                # Count the file as part of the folder
                folder_files_count += 1
                files_scanned += 1
                current_files_found.add(rel_path)  # Track this file

                # Update analyzing progress for this folder
                if folder_files_count > 0:
                    current_folder = os.path.basename(root)
                    await self.message_sender.send_analyzing(
                        f"Scanning {current_folder} folder...",
                        processed=files_scanned,
                        progress=0
                    )

                try:
                    stat_result = os.stat(source_path)
                    current_mtime = stat_result.st_mtime
                    file_size = stat_result.st_size

                    metadata_entry = self.metadata.get(rel_path, {})
                    last_mtime = metadata_entry.get('mtime', 0)

                    # Determine whether this is a new file (not present in metadata)
                    is_new_file = rel_path not in self.metadata or not metadata_entry.get('path')

                    # --- Mtime Check (Speed Optimization) ---
                    if current_mtime > last_mtime or is_new_file:
                        logging.debug(f"File modified or new (mtime): {rel_path}")

                        # --- Hash Calculation (Integrity/Move Detection) ---
                        file_hash = calculate_sha256(source_path)

                        if not file_hash:
                            logging.warning(f"Skipping file due to hash failure: {rel_path}")
                            continue

                        # Check if we have this file content already backed up (Hardlink check)
                        existing_path = self.hash_to_path_map.get(file_hash)
                        is_hardlink_candidate = existing_path is not None

                        # If hardlink candidate, check if it's actually a move/rename
                        if is_hardlink_candidate and existing_path != rel_path:
                            # This might be a moved/renamed file!
                            logging.info(f"Possible file move detected: {existing_path} -> {rel_path}")
                            # We'll handle this in the backup process

                        self.files_to_backup.append({
                            'source_path': source_path,
                            'rel_path': rel_path,
                            'file_hash': file_hash,
                            'size': file_size,
                            'mtime': current_mtime,
                            'is_hardlink_candidate': is_hardlink_candidate,
                            'existing_path': existing_path,  # Add this for move detection
                            'new_file': is_new_file
                        })

                        # Only count size for files that need a true copy (not hardlinks)
                        if not is_hardlink_candidate:
                            self.total_transfer_size += file_size
                    else:
                        logging.debug(f"File skipped (mtime unchanged): {rel_path}")

                except FileNotFoundError:
                    logging.warning(f"File disappeared during scan: {source_path}")
                except Exception as e:
                    logging.error(f"Error processing file {source_path} during scan: {e}")

        # --- DETECT MOVED/RENAMED FILES ---
        # Compare current files with metadata to find files that no longer exist in source
        metadata_files = set(self.metadata.keys())
        deleted_or_moved_files = metadata_files - current_files_found
        
        if deleted_or_moved_files:
            logging.info(f"Found {len(deleted_or_moved_files)} files that may have been moved or deleted")
            
            # For each "missing" file, check if its content exists elsewhere (moved)
            for missing_rel_path in deleted_or_moved_files:
                missing_metadata = self.metadata.get(missing_rel_path, {})
                missing_hash = missing_metadata.get('hash')
                
                if missing_hash and missing_hash in self.hash_to_path_map:
                    # The content still exists somewhere, this was likely a move
                    current_location = self.hash_to_path_map[missing_hash]
                    if current_location != missing_rel_path:
                        logging.info(f"File moved: {missing_rel_path} -> {current_location}")
                        # We don't need to backup again since content is already there
                    else:
                        # File was actually deleted
                        logging.info(f"File deleted from source: {missing_rel_path}")
                        # You might want to handle deletions here

        logging.info(f"Scan complete. Total files to process: {len(self.files_to_backup)}, Total copy size: {self.total_transfer_size / (1024**3):.2f} GB")
        
        self.total_files_to_transfer = len(self.files_to_backup)
        
        await self.message_sender.send_analyzing(  # Final update
            "File scan completed", 
            processed=files_scanned,
            progress=100
        )

    def _check_disk_space(self) -> bool:
        """Checks if the backup destination has enough space."""
        try:
            statvfs = os.statvfs(self.app_main_backup_dir)
            free_space = statvfs.f_bavail * statvfs.f_frsize

            required_space = self.total_transfer_size + (MINIMUM_FREE_SPACE_BYTES * 1024 * 1024 * 1024)

            if free_space < required_space:
                logging.critical(f"Backup failed: Insufficient disk space on {self.app_main_backup_dir}.")
                logging.critical(f"Required: {required_space / (1024**3):.2f} GB, Free: {free_space / (1024**3):.2f} GB")
                return False

            logging.info(f"Disk space check passed. Free: {free_space / (1024**3):.2f} GB, Needed: {self.total_transfer_size / (1024**3):.2f} GB")
            return True

        except PermissionError as e:
            logging.error(f"Permission denied when checking disk space: {e}")
            return True
        except OSError as e:
            logging.error(f"Failed to check disk space: {e}")
            return True
        
    def _count_total_files(self) -> int:
        """
        Fast file count for progress estimation.
        Uses basic pattern matching instead of full exclusion logic.
        """
        total_count = 0
        logging.info("Counting total files for progress tracking...")
        
        # Get basic exclude patterns for faster counting
        exclude_hidden_items_str = server.get_database_value(
            section='EXCLUDE', 
            option='exclude_hidden_itens'
        )
        exclude_hidden_items = str(exclude_hidden_items_str).lower() in ('true', '1', 'yes')
        
        # Count files in each backup folder
        for folder_name in os.listdir(self.users_home_dir):
            source_folder = os.path.join(self.users_home_dir, folder_name)
            
            if not os.path.exists(source_folder):
                continue
                
            for root, dirs, files in os.walk(source_folder):
                # Quick hidden directory filter
                if exclude_hidden_items:
                    dirs[:] = [d for d in dirs if not d.startswith('.')]
                
                # Quick hidden file filter  
                if exclude_hidden_items:
                    files = [f for f in files if not f.startswith('.')]
                
                total_count += len(files)
        
        logging.info(f"Total files to consider: {total_count}")
        return total_count

    def _try_hardlink(self, source_path: str, dest_path: str) -> bool:
        """
        Attempt to create a hardlink from source to destination.
        Returns True if successful, False otherwise.
        """
        try:
            # Ensure destination directory exists
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            
            # Create hardlink
            os.link(source_path, dest_path)
            
            # Preserve metadata
            try:
                shutil.copystat(source_path, dest_path)
            except Exception:
                pass
                
            logging.debug(f"Created hardlink: {dest_path} -> {source_path}")
            return True
            
        except FileExistsError:
            # Destination already exists - this is fine
            logging.debug(f"Hardlink destination already exists: {dest_path}")
            return True
        except OSError as e:
            # Hardlink failed (cross-device, permission issues, etc.)
            logging.debug(f"Hardlink failed for {dest_path}: {e}")
            return False
        except Exception as e:
            logging.warning(f"Unexpected error creating hardlink {dest_path}: {e}")
            return False
        
    async def process_large_file(self, file_path: str, file_size: int):
        """Send warning for large files."""
        size_gb = file_size / (1024**3)  # GB

        if size_gb < 1024**3: # 1GB
            return

        file_name = os.path.basename(file_path)
        await self.message_sender.send_warning(f"Large file detected: {file_name} ({size_gb:.1f}GB)")

    def _perform_atomic_copy(self, src_path: str, final_dst_path: str, file_hash: str | None = None, file_size: int | None = None):
        """
        Performs a file copy to a temporary path and then atomically renames it.
        This ensures the final destination file is never incomplete.
        """
        # FIX: Validate source before starting
        if not os.path.exists(src_path):
            logging.error(f"Source file does not exist: {src_path}")
            return False

        cancelled_and_left_tmp: bool = False
        temp_dst_path = f"{final_dst_path}.tmp_{os.getpid()}_{uuid.uuid4().hex}"
        
        logging.debug(f"Copying FILE {src_path} to temporary path {temp_dst_path}")
        
        try:
            # 1. Ensure destination directory exists
            try:
                os.makedirs(os.path.dirname(final_dst_path), exist_ok=True)
            except OSError as e:
                if e.errno == errno.EROFS:
                    logging.error(f"Cannot create directory - read-only filesystem: {os.path.dirname(final_dst_path)}")
                    self.message_sender.send_warning("Cannot create backup directories - device is read-only")
                    return False
                else:
                    raise
            
            # 2. Check if destination path exists and is a directory
            if os.path.exists(final_dst_path) and os.path.isdir(final_dst_path):
                logging.warning(f"Destination path is a directory, removing: {final_dst_path}")
                try:
                    shutil.rmtree(final_dst_path)
                except OSError as e:
                    if e.errno == errno.EROFS:
                        logging.error(f"Cannot remove directory - read-only filesystem: {final_dst_path}")
                        return False
                    else:
                        raise

            # 3. Also check if a file with .tmp extension exists and clean it up
            temp_pattern = f"{final_dst_path}.tmp_*"
            import glob
            for old_temp in glob.glob(temp_pattern):
                try:
                    if os.path.isfile(old_temp):
                        os.remove(old_temp)
                        logging.debug(f"Cleaned up old temp file: {old_temp}")
                except OSError as e:
                    if e.errno == errno.EROFS:
                        logging.warning(f"Cannot clean up old temp file - read-only: {old_temp}")
                    else:
                        logging.warning(f"Could not clean up old temp file {old_temp}: {e}")

            # Include hash/size in the journal entry
            entry_payload = {'src': src_path, 'dst': final_dst_path, 'tmp': temp_dst_path}
            if file_hash:
                entry_payload['hash'] = file_hash
            if file_size is not None:
                entry_payload['size'] = file_size
            entry_id = self.journal.append_entry('copy', entry_payload)
            
            # 4. Copy the file in chunks
            chunk_size = 64 * 1024
            try:
                with open(src_path, 'rb') as fr, open(temp_dst_path, 'wb') as fw:
                    while True:
                        # Check for cancellation
                        if getattr(self, 'cancel_event', None) and self.cancel_event.is_set() and self.immediate_cancel:
                            logging.info(f"Immediate cancel detected; aborting copy for {src_path}")
                            raise InterruptedError("cancelled")
                        chunk = fr.read(chunk_size)
                        if not chunk:
                            break
                        fw.write(chunk)
            except OSError as e:
                if e.errno == errno.EROFS:
                    logging.error(f"Cannot write temp file - read-only filesystem: {temp_dst_path}")
                    self.message_sender.send_warning("Cannot write backup files - device is read-only")
                    return False
                else:
                    raise
            except InterruptedError:
                # Immediate cancellation - leave tmp file for journal replay
                logging.info(f"Copy interrupted for {src_path}, tmp file left for replay: {temp_dst_path}")
                return False

            # Preserve metadata
            try:
                shutil.copystat(src_path, temp_dst_path)
            except Exception as e:
                logging.warning(f"Could not copy file metadata for {src_path}: {e}")

            # 5. Ensure file data and metadata flushed
            try:
                with open(temp_dst_path, 'rb') as ftmp:
                    os.fsync(ftmp.fileno())
            except Exception as e:
                logging.warning(f"fsync(temp) failed for {temp_dst_path}: {e}")

            # 6. Atomic commit: rename temporary file to final destination
            try:
                # If destination exists and is a directory, remove it to avoid rename failure
                if os.path.exists(final_dst_path) and os.path.isdir(final_dst_path):
                    logging.warning(f"Removing directory that conflicts with file: {final_dst_path}")
                    try:
                        shutil.rmtree(final_dst_path)
                    except OSError as e:
                        if e.errno == errno.EROFS:
                            logging.error(f"Cannot remove directory - read-only: {final_dst_path}")
                            return False

                os.rename(temp_dst_path, final_dst_path)
                logging.debug(f"Atomic commit successful for {final_dst_path}")
                
            except OSError as e:
                if e.errno == errno.EROFS:
                    logging.error(f"Cannot rename file - read-only filesystem: {temp_dst_path} -> {final_dst_path}")
                    self.message_sender.send_warning("Cannot complete backup - device is read-only")
                    # Clean up temp file
                    if os.path.exists(temp_dst_path):
                        try:
                            os.remove(temp_dst_path)
                        except Exception:
                            pass
                    return False
                else:
                    raise

            # 7. Fsync the destination directory
            try:
                dirfd = os.open(os.path.dirname(final_dst_path), os.O_DIRECTORY)
                try:
                    os.fsync(dirfd)
                finally:
                    os.close(dirfd)
            except Exception as e:
                logging.warning(f"fsync(dir) failed for {os.path.dirname(final_dst_path)}: {e}")

            self.journal.mark_completed(entry_id)
            return True
            
        except InterruptedError:
            # Immediate cancellation handled above
            return False
        except OSError as e:
            if e.errno == errno.EROFS:
                logging.error(f"Read-only filesystem error during copy: {src_path}")
                return False
            else:
                logging.error(f"Atomic copy failed for {src_path} to {final_dst_path}: {e}")
                return False
        except Exception as e:
            logging.error(f"Atomic copy failed for {src_path} to {final_dst_path}: {e}")
            return False

    def _update_metadata(self, rel_path: str, dst_path: str, file_info: dict) -> None:
        """Thread-safe metadata update after successful operation - SYNCHRONOUS"""
        try:
            with self.state_lock:
                entry = {
                    'path': dst_path,
                    'mtime': file_info.get('mtime', time.time()),
                    'size': file_info.get('size', None),
                    'hash': file_info.get('file_hash', None),
                }
                self.metadata[rel_path] = entry
                file_hash = entry.get('hash')
                if file_hash:
                    self.hash_to_path_map[file_hash] = dst_path

                # counters
                try:
                    if entry.get('size'):
                        self.total_size_transferred += int(entry['size'])
                except Exception:
                    pass
                self.files_backed_up_count += 1

                # batched metadata flush
                self._metadata_dirty_count = 1
                if self._metadata_dirty_count >= self.metadata_flush_every:
                    try:
                        server.save_metadata(self.metadata)
                        self._metadata_dirty_count = 0
                    except OSError as e:
                        if e.errno == errno.EROFS:
                            logging.error("Cannot save metadata - read-only filesystem")
                            # Send warning synchronously
                            try:
                                asyncio.run(self.message_sender.send_warning("Cannot save backup metadata - device is read-only"))
                            except Exception:
                                pass
                        else:
                            logging.warning(f"Failed to flush metadata: {e}")
        except Exception as e:
            logging.error(f"_update_metadata failed for {rel_path}: {e}")

    def _calculate_eta(self) -> str:
        """Calculate estimated time remaining using bytes transfer."""
        if (not self.backup_start_time or 
            self.total_size_transferred == 0 or 
            self.total_transfer_size == 0):
            return "Calculating..."
        
        elapsed_time = time.time() - self.backup_start_time
        
        # If we've transferred all expected data
        if self.total_size_transferred >= self.total_transfer_size:
            return "Finishing up..."
        
        # Calculate bytes per second
        bytes_per_second = self.total_size_transferred / elapsed_time
        
        if bytes_per_second > 0:
            remaining_bytes = self.total_transfer_size - self.total_size_transferred
            seconds_remaining = remaining_bytes / bytes_per_second
            
            # FIX: Prevent negative ETA
            if seconds_remaining <= 0:
                return "Finishing up..."
                
            if seconds_remaining < 60:
                return f"{int(seconds_remaining)} sec"
            elif seconds_remaining < 3600:
                return f"{int(seconds_remaining / 60)} min"
            else:
                hours = int(seconds_remaining // 3600)
                minutes = int((seconds_remaining % 3600) // 60)
                return f"{hours}h {minutes}m"
        
        return "Calculating..."
    
    def _get_folder_name(self, file_path: str) -> str:
        """Extract folder name for completion messages."""
        rel_path = os.path.relpath(file_path, self.users_home_dir)
        parts = rel_path.split(os.sep)
        return parts[0] if parts else "Unknown"
    
    def _is_folder_completed(self, folder_name: str) -> bool:
        """Check if all files in a folder have been processed."""
        # Implementation depends on how you track folder completion
        # This is a simplified version
        return True  # You'll need to implement proper tracking
    
    def process_file(self, file_info: dict) -> bool:
        """Process a single file (copy or hardlink) - SYNCHRONOUS VERSION"""
        if self.cancel_event.is_set():
            return False

        source = file_info['source_path']
        rel_path = file_info['rel_path']
        file_hash = file_info['file_hash']
        size = file_info['size']
        existing_path = file_info.get('existing_path')
        
        # Calculate overall progress
        total_files = len(self.files_to_backup)
        progress_percent = min(100, int((self.files_backed_up_count / total_files) * 100)) if total_files > 0 else 0
        
        # Calculate ETA
        eta = self._calculate_eta()
        
        # Send progress update - use synchronous approach
        try:
            def _truncate_path(path: str, max_len: int = 25) -> str:
                if len(path) <= max_len:
                    return path
                return "..." + path[-(max_len - 3):]
            
            display_path = _truncate_path(rel_path)

            # Use the synchronous helper function directly
            _send_message_blocking(
                self.message_sender.socket_path,
                self.message_sender.timeout,
                {
                    "type": "progress", 
                    "title": "Backup in progress",
                    "description": display_path,
                    "progress": progress_percent,
                    "eta": f"ETA: {eta}",
                    "timestamp": datetime.now().isoformat()
                }
            )
        except Exception as e:
            logging.warning(f"Failed to send progress update: {e}")

        # The destination should be: backup_root + relative_path_from_source
        dest = os.path.join(self.app_main_backup_dir, rel_path)
        
        # Determine destination path: new files go to main, updates go to incremental.
        if file_info.get('new_file'):
            dest = os.path.join(self.app_main_backup_dir, rel_path)
            # logging.debug(f"Processing NEW file: {rel_path} -> {dest}")
        else:
            # This is an update, so it goes into the current incremental folder.
            dest = os.path.join(self.app_incremental_backup_dir, rel_path)
            # logging.debug(f"Processing UPDATED file: {rel_path} -> {dest}")
        
        # Ensure the destination directory exists before any operation.
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
        except OSError as e:
            if e.errno == errno.EROFS:
                logging.error(f"Cannot create directory - read-only filesystem: {os.path.dirname(dest)}")
                # Send warning synchronously
                _send_message_blocking(
                    self.message_sender.socket_path,
                    self.message_sender.timeout,
                    {
                        "type": "warning",
                        "title": "Warning",
                        "description": "Cannot create backup directories - device is read-only",
                        "timestamp": datetime.now().isoformat()
                    }
                )
                return False
            else:
                logging.error(f"Failed to create destination directory for {dest}: {e}")
                return False
        
        try:
            # Try hardlink first if possible - this handles moved files!
            if file_info['is_hardlink_candidate']:
                # Detect large file - use synchronous approach
                size_gb = size / (1024**3)  # GB
                if size_gb >= 1:  # 1GB
                    file_name = os.path.basename(source)
                    _send_message_blocking(
                        self.message_sender.socket_path,
                        self.message_sender.timeout,
                        {
                            "type": "warning",
                            "title": "Warning",
                            "description": f"Large file detected: {file_name} ({size_gb:.1f}GB)",
                            "timestamp": datetime.now().isoformat()
                        }
                    )

                existing = self.hash_to_path_map.get(file_hash)
                if existing and self._try_hardlink(existing, dest):
                    logging.info(f"Hardlinked file (content exists): {rel_path}")
                    
                    # If this was a moved file, update the metadata to point to new location
                    if existing_path and existing_path != rel_path:
                        logging.info(f"Updated moved file location: {existing_path} -> {rel_path}")
                    
                    self._update_metadata(rel_path, dest, file_info)
                    return True

            # Fall back to copy if hardlink fails/impossible
            if self._perform_atomic_copy(source, dest, file_hash, size):
                # Detect large file - use synchronous approach
                size_gb = size / (1024**3)  # GB
                if size_gb >= 1:  # 1GB
                    file_name = os.path.basename(source)
                    _send_message_blocking(
                        self.message_sender.socket_path,
                        self.message_sender.timeout,
                        {
                            "type": "warning",
                            "title": "Warning",
                            "description": f"Large file detected: {file_name} ({size_gb:.1f}GB)",
                            "timestamp": datetime.now().isoformat()
                        }
                    )
                            
                logging.info(f"Backing up file: {rel_path} -> {dest}")
                self._update_metadata(rel_path, dest, file_info)
                return True

            return False

        except Exception as e:
            logging.error(f"Failed to process {rel_path}: {e}")
            return False

    def _cleanup_orphaned_files(self):
        """Remove files from backup that no longer exist in source"""
        logging.info("Checking for orphaned files in backup...")
        
        # Get all files currently in source
        current_source_files = set()
        for root, dirs, files in os.walk(self.users_home_dir):
            # Filter directories
            dirs[:] = [d for d in dirs if not self._should_exclude(os.path.join(root, d))]
            
            for file_name in files:
                source_path = os.path.join(root, file_name)
                if self._should_exclude(source_path):
                    continue
                    
                # Calculate relative path
                folder_name_base = os.path.basename(self.users_home_dir)
                file_rel_path = os.path.relpath(source_path, self.users_home_dir)
                rel_path = os.path.join(folder_name_base, file_rel_path)
                current_source_files.add(rel_path)
        
        # Find files in metadata that don't exist in source anymore
        orphaned_files = set(self.metadata.keys()) - current_source_files
        
        for orphaned_rel_path in orphaned_files:
            backup_path = os.path.join(self.app_main_backup_dir, orphaned_rel_path)
            if os.path.exists(backup_path):
                logging.info(f"Removing orphaned backup file: {orphaned_rel_path}")
                try:
                    os.remove(backup_path)
                    # Remove from metadata
                    with self.state_lock:
                        if orphaned_rel_path in self.metadata:
                            del self.metadata[orphaned_rel_path]
                except Exception as e:
                    logging.warning(f"Failed to remove orphaned file {backup_path}: {e}")
        
        logging.info(f"Cleaned up {len(orphaned_files)} orphaned files")

    async def _generate_summary(self):
        """Generate backup summary of files copied during this run"""

        try:
            # Find generate script path
            summary_script_path = os.path.join(os.path.dirname(__file__), server.SUMMARY_SCRIPT_FILE)
            
            # Run script
            sub.run([
                'python3',
                 summary_script_path], 
                 check=True, capture_output=True, text=True)
            logging.info("Backup summary generated successfully.")
        except sub.CalledProcessError as e:
            logging.warning(f"Failed to generate backup summary. Return code: {e.returncode}")
        except Exception as e:
            logging.critical(f"Unexpected error while generating backup summary: {e}")

        # # Check for new packages in user's Downloads folder
        # if server.DRIVER_PATH and self.is_backup_location_writable():
        #     await self._backup_downloaded_packages()
        #     await self.backup_flatpaks()

    def _setup_sleep_handler(self):
        """Simple sleep detection"""
        def _monitor():
            last_time = time.time()
            while True:
                try:
                    now = time.time()
                    gap = now - last_time
                    
                    if gap > 30:  # System likely suspended
                        logging.info(f"System resumed after {gap:.1f}s")
                        server.save_metadata(self.metadata)  # Persist current metadata
                        self.journal.replay(self)
                    
                    last_time = now
                    time.sleep(5)
                except Exception as e:
                    logging.error(f"Sleep monitor error: {e}")
                    time.sleep(5)

        threading.Thread(target=_monitor, daemon=True).start()

    async def run_backup_cycle(self):
        """Main orchestrator for a single backup cycle."""
        self.run_start_time = time.time()
        self.files_backed_up_count = 0
        self.total_size_transferred = 0

        # Start backup - clear analyzing state
        await self.message_sender.send_backup_progress(
            description="Starting backup...",
            progress=0,
            eta="Calculating..."
        )
        self.backup_start_time = time.time()

        try:
            logging.info("-" * 50)
            logging.info(f"Starting new backup cycle to {self.app_main_backup_dir}.")

            # Asynchronously wait for the backup location to be ready.
            if not await self._check_backup_errors():
                return # Exit cycle if check was cancelled.
            
            # --- STAGE 1: Pre-flight Check & Size Assessment ---
            await self._pre_flight_scan()

            # Check if there are files to back up
            if not self.files_to_backup:
                logging.info("No files require backup. Cycle complete.")
                await self.message_sender.send_backup_completed("No files to backup")
                return

            # Check if drive is connected and has space
            if not self._check_disk_space():
                """Send warnings for disk space issues."""
                logging.warning("Skipping backup due to connection or space issue.")
                await self.message_sender.send_warning("Low disk space on backup device")
                return
            
            # --- STAGE 2: Concurrent Copy & Atomic Commit ---
            # Clear analyzing state and show we're starting backup
            await asyncio.sleep(0.5)  # A small delay and send a clear completion message
            await self.message_sender.send_backup_progress(
                description="Starting file backup...",
                progress=0,
                eta="Calculating..."
            )
            
            num_workers = self._get_concurrent_worker_count()
            self.executor._max_workers = num_workers
            logging.info(f"Starting concurrent copy phase with {num_workers} worker threads.")

            loop = asyncio.get_running_loop()
            tasks = [
                loop.run_in_executor(self.executor, functools.partial(self.process_file, file_info))
                for file_info in self.files_to_backup
            ]

            try:
                results = await asyncio.gather(*tasks, return_exceptions=True)
            except asyncio.CancelledError:
                logging.info("Backup cycle cancelled while awaiting worker tasks.")
                # treat remaining as failures; let shutdown path persist state
                results = []

            # Normalize exceptions -> False
            normalized = []
            for r in results:
                if isinstance(r, Exception):
                    # logging.error(f"Worker task raised: {r}", exc_info=True)
                    normalized.append(False)
                else:
                    normalized.append(bool(r))
            results = normalized

            files_failed = results.count(False)
            if files_failed > 0:
                logging.error(f"Backup run finished with {files_failed} files failed.")
            else:
                logging.info(f"Backup run finished successfully. {self.files_backed_up_count} files backed up.")
                # Final completion
                await self.message_sender.send_backup_completed("All files backed up successfully")
            
            # If a cancellation was requested, note it and persist what we have
            if getattr(self, 'cancel_event', None) and self.cancel_event.is_set():
                logging.info("Cancellation requested during run; finalizing and saving metadata for completed files.")

            # --- STAGE 3: Finalize Metadata ---
            try:
                server.save_metadata(self.metadata)  # Final save
                try:
                    self.journal.flush()
                except Exception:
                    pass
            except Exception as e:
                logging.warning(f"Failed to persist metadata at end of run: {e}")
            logging.info("Metadata updated.")

            # --- STAGE 4: Completion ---

            # After backup completes, clean up orphaned files
            if self.files_backed_up_count > 0:
                self._cleanup_orphaned_files()

            # Generate summary for Videos, Music etc.
            await self._generate_summary()

            # Total cycle time
            time_taken = time.time() - self.run_start_time
            logging.info(f"Total cycle time: {time_taken:.2f} seconds.")

        except Exception as e:
            logging.critical(f"Backup cycle failed with unhandled exception: {e}", exc_info=True)
            # Send warning message 
            await self.message_sender.send_warning(f"Backup failed: {str(e)}")

    async def run(self):
        """Asynchronous loop for the daemon."""
        while not self.cancel_event.is_set():
            # 1. Run the core backup cycle
            await self.run_backup_cycle()

            # 2. CHECK: If the cycle was cancelled (by Ctrl+C), exit the loop
            if self.cancel_event.is_set():
                logging.info("Cycle cancelled and cleanup finished. Exiting main loop.")
                break # Exit the while loop to end the program

            # 3. Sleep, but wrap it in a try/except to handle a second Ctrl+C
            try:
                logging.info(f"Sleeping for {self.wait_time_minutes} minutes...")
                await self.message_sender.send_sleeping(f"Sleeping...")
                await asyncio.sleep(self.wait_time_minutes * 60)
            except asyncio.CancelledError:
                # This catches a second Ctrl+C during the sleep.
                logging.info("Sleep interrupted by cancellation. Exiting main loop.")
                break # Exit the while loop to end the program
            except KeyboardInterrupt:
                # Handles a KeyboardInterrupt directly in the loop
                self.cancel_event.set()
                logging.info("KeyboardInterrupt detected during sleep. Exiting.")
                break # Exit the while loop to end the program


# =============================================================================
# Simple append-only Journal (JSONL) for recovery / replay
# =============================================================================
class Journal:
    """Append-only JSONL journal with minimal API used by the daemon."""
    def __init__(self):
        self.path = server.JOURNAL_LOG_FILE  # Path to journal file
        self.lock = threading.Lock()  # To protect concurrent appends
        self._append_count = 0  # Count of appends since last fsync
        self.fsync_every = 100  # fsync after every 100 appends

    def append_entry(self, op_type: str, payload: dict) -> str:
        """Append a 'started' entry and return entry_id."""
        entry_id = uuid.uuid4().hex
        entry = {
            "id": entry_id,
            "time": time.time(),
            "type": op_type,
            "payload": payload,
            "status": "started"
        }
        data = json.dumps(entry)
        with self.lock:
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(data + "\n")
                f.flush()
                self._append_count += 1
                if self._append_count >= getattr(self, "fsync_every", 1):
                    try:
                        os.fsync(f.fileno())
                    except Exception:
                        pass
                    self._append_count = 0
        return entry_id

    def get_incomplete(self) -> list:
        """Return a list of started (incomplete) journal entries.

        Each entry is the parsed JSON object (dict) as written to the journal.
        """
        entries = []
        if not os.path.exists(self.path):
            return entries
        try:
            started = []
            completed_ids = set()
            with open(self.path, 'r', encoding='utf-8') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                    except Exception:
                        continue
                    status = entry.get('status')
                    if status == 'started':
                        started.append(entry)
                    elif status == 'completed':
                        cid = entry.get('id')
                        if cid:
                            completed_ids.add(cid)

            # Return only those started entries that do not have a matching completed marker
            for s in started:
                if s.get('id') not in completed_ids:
                    entries.append(s)
        except Exception:
            pass
        return entries

    def mark_completed(self, entry_id: str) -> None:
        """Append a 'completed' entry for entry_id."""
        entry = {"id": entry_id, "time": time.time(), "status": "completed"}
        with self.lock:
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry) + "\n")
                f.flush()
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass

    def flush(self) -> None:
        """No-op (fsyncs happen during append); provided for compatibility."""
        # if needed we could open file and fsync; keep minimal
        try:
            with open(self.path, 'a', encoding='utf-8') as f:
                f.flush()
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass
        except Exception:
            pass

    def replay(self, daemon: 'Daemon') -> None:
        """
        Replay incomplete 'started' entries.
        daemon is passed so replay can use daemon.journal and server paths.
        """
        # Read incomplete entries and try to reconcile them. We iterate
        # over the started entries (in the order they appear) so replays
        # are predictable.
        incomplete = self.get_incomplete()
        if not incomplete:
            return

        for entry in incomplete:
            try:
                etype = entry.get('type')
                payload = entry.get('payload', {}) or {}
                entry_id = entry.get('id')

                dst = payload.get('dst') or payload.get('destination')
                tmp = payload.get('tmp')
                src = payload.get('src') or payload.get('source')

                # HANDLE COPY ENTRIES
                if etype == 'copy':
                    # Check if destination exists as a directory
                    if dst and os.path.exists(dst) and os.path.isdir(dst):
                        logging.warning(f"Journal replay: destination is a directory, removing: {dst}")
                        shutil.rmtree(dst)

                    # If tmp exists, validate (when hash/size provided) and move
                    if tmp and os.path.exists(tmp):
                        valid = True
                        expected_hash = payload.get('hash')
                        expected_size = payload.get('size')

                        try:
                            if expected_size is not None:
                                actual_size = os.path.getsize(tmp)
                                if int(actual_size) != int(expected_size):
                                    logging.warning(f"Journal replay: tmp size mismatch for {tmp} (expected {expected_size}, got {actual_size})")
                                    valid = False
                            if expected_hash:
                                actual_hash = calculate_sha256(tmp)
                                if not actual_hash or actual_hash != expected_hash:
                                    logging.warning(f"Journal replay: tmp hash mismatch for {tmp} (expected {expected_hash}, got {actual_hash})")
                                    valid = False
                        except Exception as e:
                            logging.warning(f"Journal replay: failed to validate tmp {tmp}: {e}")
                            valid = False

                        if valid:
                            try:
                                os.makedirs(os.path.dirname(dst), exist_ok=True)

                                if os.path.exists(dst) and os.path.isdir(dst):
                                    shutil.rmtree(dst)

                                os.replace(tmp, dst)
                                logging.info(f"Journal replay completed move {tmp} -> {dst}")
                                
                                try:
                                    if entry_id:
                                        self.mark_completed(entry_id)
                                except Exception:
                                    pass
                            except Exception as e:
                                logging.warning(f"Journal replay failed to finalize {tmp} -> {dst}: {e}")
                        else:
                            # tmp seems corrupt/incomplete; remove it to allow a fresh copy later
                            try:
                                os.remove(tmp)
                                logging.info(f"Journal replay removed corrupt tmp file {tmp}")
                            except Exception:
                                pass
                            # Consider the journal entry resolved so we don't replay it again
                            try:
                                if entry_id:
                                    self.mark_completed(entry_id)
                            except Exception:
                                pass

                    else:
                        # tmp missing. If dst is already present, treat as completed.
                        if dst and os.path.exists(dst):
                            logging.info(f"Journal replay: dst already present {dst}; marking entry complete")
                            try:
                                if entry_id:
                                    self.mark_completed(entry_id)
                            except Exception:
                                pass
                        else:
                            logging.debug(f"Journal replay: no tmp for entry {entry_id} and dst missing; nothing to do.")

                # HANDLE LINK ENTRIES (hardlink creation)
                elif etype == 'link':
                    try:
                        if src and dst:
                            os.makedirs(os.path.dirname(dst), exist_ok=True)
                            # If dst already exists, consider the link completed.
                            if os.path.exists(dst):
                                logging.info(f"Journal replay: link dst already exists {dst}; marking complete")
                                if entry_id:
                                    # self._send_progress_update(
                                    self.mark_completed(entry_id)
                                continue
                            os.link(src, dst)
                            logging.info(f"Journal replay created hardlink {dst} -> {src}")
                            if entry_id:
                                self.mark_completed(entry_id)
                    except Exception as e:
                        logging.warning(f"Journal replay failed to create link {dst} -> {src}: {e}")

                else:
                    logging.debug(f"Journal replay: unknown entry type {etype}; skipping")

            except Exception as e:
                logging.error(f"Failed to process journal entry {entry}: {e}")


# =============================================================================
# MESSAGE SENDER VIA UNIX SOCKET
# =============================================================================
class MessageSender():
    def __init__(self):
        self.socket_path = server.SOCKET_PATH
        self.timeout = 2
        self.min_update_interval = 0.1  # Throttle updates to 100ms
        self.last_progress_update_time = 0.0

    async def initialize_websocket(self):
        """Initialize WebSocket connection"""
        await self.ws_client.connect()
    
    async def send_message(self, message_data: dict) -> bool:
        """  
        Asynchronously send a JSON message to the UI via UNIX socket.
        """
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(self.timeout)
                sock.connect(self.socket_path)
                sock.sendall((json.dumps(message_data) + "\n").encode("utf-8"))
            return True
        except Exception as e:
            logging.debug(f"[MessageSender] Failed to send message: {e}")
            return False
        
        # try:
        #     # Await the execution of the blocking function in a separate thread
        #     return await asyncio.to_thread(
        #         _send_message_blocking,
        #         self.socket_path,
        #         self.timeout,
        #         message_data
        #     )
        # except asyncio.CancelledError:
        #     logging.debug("Message sending was cancelled")
        #     return False
        # except Exception as e:
        #     logging.debug(f"[MessageSender] Failed to send message: {e}")
        #     return False
    
    async def send_sleeping(self, description: str, processed: int = 0, progress: int = 0) -> bool:
        """Send sleeping files activity."""
        message = {
            "type": "sleeping",
            "title": "Sleeping...",
            "description": description,
            "progress": "progress",
            "processed": "processed",
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message)

    async def send_analyzing(self, description: str, processed: int = 0, progress: int = 0) -> bool:
        """Send analyzing files activity."""
        # Remove state setting that conflicts with backup progress
        message = {
            "type": "analyzing",
            "title": "Analyzing files", 
            "description": description,
            "progress": progress,
            "processed": processed,
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message) 

    async def send_backup_progress(self, description: str, progress: int, eta: str) -> bool:
        """Send backup in progress activity (Rate Limited)."""
        current_time = time.time()
        
        # Remove state update that conflicts
        if current_time - self.last_progress_update_time < self.min_update_interval:
            return True
        
        self.last_progress_update_time = current_time
        
        message = {
            "type": "progress", 
            "title": "Backup in progress",
            "description": description,
            "progress": progress,
            "eta": eta,
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message)

    async def send_backup_completed(self, description: str) -> bool:
        """Send backup completed activity."""
        message = {
            "type": "completed",
            "title": "Backup completed",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message)  

    async def send_warning(self, description: str) -> bool:
        """Send warning activity."""
        message = {
            "type": "warning",
            "title": "Warning",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message)

    async def send_new_folder(self, description: str) -> bool:
        """Send new folder added activity."""
        message = {
            "type": "info", 
            "title": "New folder added",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return await self.send_message(message)
    

# =============================================================================
# MAIN EXECUTION BLOCK
# =============================================================================
async def main():
    """Asynchronous main entry point for the daemon."""
    # Initialize a global server instance for the send_to_ui helper
    server = SERVER()
    daemon = Daemon()

    log_file_path = server.LOG_FILE_PATH

    # Setup Logging (moved from original if __name__ block)
    os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
    formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
    logger = logging.getLogger()
    if not logger.handlers: # Avoid adding handlers multiple times
        logger.setLevel(logging.INFO)

        # File Handler (INFO level)
        file_handler = logging.FileHandler(log_file_path)
        file_handler.setFormatter(formatter)
        file_handler.setLevel(logging.INFO)
        logger.addHandler(file_handler)

        # Console Handler (DEBUG level for development visibility)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        console_handler.setLevel(logging.DEBUG)
        logger.addHandler(console_handler)

    try:
        # Set process title for easier identification
        if setproctitle:
            setproctitle.setproctitle(f'{server.APP_NAME} - daemon')
    except Exception:
        pass # Optional dependency
    
    # Register signal handlers to ensure graceful shutdown on SIGTERM/SIGINT
    try:
        loop = asyncio.get_running_loop()
        import signal
        def _on_signal(sig):
            logging.info(f"Signal {sig} received: requesting graceful shutdown.")
            # prefer graceful cancel on SIGTERM, immediate on SIGINT (adjust to your policy)
            daemon.cancel_event.set()
            if sig == signal.SIGINT:
                daemon.immediate_cancel = True
            # also wake the loop if sleeping
            for task in asyncio.all_tasks(loop):
                if task is not asyncio.current_task():
                    task.cancel()
        loop.add_signal_handler(signal.SIGTERM, lambda: _on_signal(signal.SIGTERM))
        loop.add_signal_handler(signal.SIGINT, lambda: _on_signal(signal.SIGINT))

    except Exception:
        # running on platform without add_signal_handler or other issue; continue without
        pass

    # Asynchronously wait for the backup location to be ready before starting the main loop.
    if not await daemon._check_backup_errors():
        logging.error("Could not connect to backup location on startup. Exiting.")
        return # Exit if check was cancelled or failed initially.

    try:
        # Create the necessary backup root directory if it doesn't exist
        os.makedirs(daemon.app_main_backup_dir, exist_ok=True)
        
        # Replay any incomplete journal entries
        journal = Journal()
        journal.replay(daemon)

        # Start the main daemon loop
        await daemon.run()
    except SystemExit:
        logging.info("Daemon received SystemExit.")
    except KeyboardInterrupt:
        logging.info("Daemon interrupted by user.")
    except Exception as e:
        # Full exception logging for unhandled errors
        logging.critical(f"Unhandled exception in daemon main: {e}", exc_info=True)
    finally:
        logging.info("Daemon shutting down (begin cleanup).")
        try:
            # Request immediate cancellation of in-progress operations to speed shutdown
            if daemon and getattr(daemon, 'cancel_event', None):
                daemon.cancel_event.set()
                daemon.immediate_cancel = True

            # Allow a short grace period for workers to observe cancel and finish
            try:
                await asyncio.sleep(1.0)
            except Exception:
                pass

            # Shutdown executor and wait for currently running tasks to finish
            if daemon and getattr(daemon, 'executor', None):
                try:
                    daemon.executor.shutdown(wait=True)
                except Exception:
                    try:
                        daemon.executor.shutdown(wait=False)
                    except Exception:
                        pass

            # Persist metadata and flush journal to minimize recovery work
            try:
                server.save_metadata(daemon.metadata)
            except Exception as e:
                logging.warning(f"Failed to save metadata during shutdown: {e}")
            try:
                daemon.journal.flush()
            except Exception:
                pass

            logging.info("Daemon cleanup complete.")
        except Exception as e:
            logging.warning(f"Error during shutdown cleanup: {e}")


if __name__ == "__main__":
    # Run the async main function
    asyncio.run(main())
