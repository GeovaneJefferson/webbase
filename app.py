# app.py
import getpass
import os
import pathlib
import itertools
import subprocess as sub
import configparser
import shutil
import time
import sys
import signal
import asyncio
import threading
import multiprocessing
import locale
import logging
import traceback
import socket
import errno
import setproctitle
import csv
import random
import platform
import inspect
import gi
import json
import fnmatch
import hashlib
import stat
import psutil
import fcntl
import mimetypes
import cairo
import tempfile
import math
import difflib 

from pathlib import Path
from datetime import datetime, timedelta
from threading import Thread, Timer
from queue import Queue, Empty
from time import time
from functools import wraps

from static.py.server import *
from static.py.search_handler import SeachHandler

from storage_util import get_storage_info, get_all_storage_devices

# Flask libraries
from flask import Flask, render_template, jsonify, request, send_file  # Add send_file here
from flask_sock import Sock

# Create app
app = Flask(__name__)
sock = Sock(app)

# Simple in-memory rate limiting
_rate_limit_data = {}

# External sc
server = SERVER()

USERS_HOME: str = os.path.expanduser("~")
USERNAME: str = getpass.getuser()


# =============================================================================######
# APP SETTINGS
# =============================================================================######
# Path to your config file
app_dir = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(app_dir, 'config', 'config.conf')

# Configuration
LOG_FILE_PATH: str = os.path.expanduser('~/.timemachine.log') 
DAEMON_PATH: str = os.path.join(os.path.dirname(__file__), 'daemon.py') # Assuming daemon.py is in the same directory as app.py
MAIN_BACKUP_LOCATION: str = '.main_backup'

# Flatpak
DAEMON_PY_LOCATION: str = os.path.join('/app/share/timemachine/src', 'daemon.py')
id: str = server.ID
DAEMON_PID_LOCATION: str = server.DAEMON_PID_LOCATION

# SOCKET_PATH = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), f"{APP_NAME_CLOSE_LOWER}-ui.sock")
SOCKET_PATH = server.SOCKET_PATH

# Concurrency settings for copying files
# Default, can be adjusted based on system resources and current load
DEFAULT_COPY_CONCURRENCY = 2
PAGE_SIZE: int = 17  # Number of results per page

APP_MAIN_BACKUP_DIR = server.app_main_backup_dir()
APP_BACKUP_DIR = server.app_backup_dir()

# Socket clients list
ws_clients = []  # Track WebSocket clients
BACKUP_STATUS = {}

# Read configuration files
DRIVER_NAME: str = server.DRIVER_NAME
DRIVER_PATH: str = server.DRIVER_PATH
DRIVER_FILESYTEM: str = server.DRIVER_FILESYTEM
DRIVER_MODEL: str = server.DRIVER_MODEL
WATCHED_FOLDERS: str = server.WATCHED_FOLDERS if server.WATCHED_FOLDERS else []
EXCLUDED_FOLDERS: str = server.EXCLUDED_FOLDERS if server.EXCLUDE_FOLDER else []

# Calculations
bytes_to_human = SERVER.bytes_to_human

REFRESH_FLAG_CONFIG = 'need_refresh_database'

server = SERVER()
message_queue = Queue()
search_handler = SeachHandler()


# =============================================================================
# BACKUP SERVICE CLASS
# =============================================================================
class BackupService:
    def __init__(self):
        self.load_config()
        
        # Add the missing attributes
        self.current_daemon_state = "idle"  # Add this line
        self.currently_scanning_top_level_folder_name = None
        self.transfer_rows = {}
        
        self.documents_path: str = os.path.expanduser(APP_MAIN_BACKUP_DIR)
        
    def load_config(self):
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        try:
            # Update status and broadcast
            BACKUP_STATUS.update({
                'running': True,
                'progress': 0,
                'last_error': None
            })
            self.broadcast_to_websockets({
                'type': 'status',
                'data': BACKUP_STATUS
            })
            
            source = self.config['DEVICE_INFO']['path']
            backup_location_dir_name: str = server.BACKUPS_LOCATION_DIR_NAME
            destination = self.config['BACKUP'].get('destination', f'/{backup_location_dir_name}')
            
            Path(destination).mkdir(parents=True, exist_ok=True)
            
            cmd = [
                'rsync', '-avz', '--progress',
                '--exclude', '.*' if self.config['EXCLUDE'].getboolean('exclude_hidden_itens') else '',
                source, destination
            ]
            
            process = sub.Popen(
                cmd,
                stdout=sub.PIPE,
                stderr=sub.PIPE,
                universal_newlines=True
            )
            
            for line in process.stdout:
                if 'to-check=' in line:
                    parts = line.split()
                    if len(parts) > 2:
                        BACKUP_STATUS['current_file'] = parts[-1]
                        progress_parts = parts[2].split('/')
                        if len(progress_parts) == 2:
                            progress = int((int(progress_parts[0]) / int(progress_parts[1])) * 100)
                            BACKUP_STATUS['progress'] = progress
                            
                            # Broadcast progress update
                            self.broadcast_to_websockets({
                                'type': 'status',
                                'data': BACKUP_STATUS
                            })
                
            process.wait()
            
            if process.returncode != 0:
                BACKUP_STATUS['last_error'] = process.stderr.read()
            
        except Exception as e:
            BACKUP_STATUS['last_error'] = str(e)
        finally:
            BACKUP_STATUS['running'] = False
            BACKUP_STATUS['progress'] = 100 if not BACKUP_STATUS['last_error'] else 0
            
            # Broadcast final status
            self.broadcast_to_websockets({
                'type': 'status', 
                'data': BACKUP_STATUS
            })
    
    def pause_backup(self):
        if self.process:
            self.process.terminate()
            BACKUP_STATUS['running'] = False
	
    # =============================================================================
	# Socket reciever
	# =============================================================================
    def start_server(self):
            """UNIX Socket listener to receive messages and broadcast to WebSockets."""
            if os.path.exists(SOCKET_PATH):
                os.remove(SOCKET_PATH)

            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(SOCKET_PATH)
                    listener.listen(1)
                    print(f"[IPC] Listening for daemon on UNIX socket: {SOCKET_PATH}")

                    while True:
                        conn, _ = listener.accept()
                        with conn:
                            data = b''
                            while True:
                                chunk = conn.recv(4096)
                                if not chunk:
                                    break
                                data += chunk

                            if data:
                                decoded_data = data.decode('utf-8')
                                
                                # --- CRITICAL FIX FOR JSON ERROR ---
                                # Split the stream by '\n' to handle multiple JSON messages
                                for line in decoded_data.strip().split('\n'):
                                    if not line: continue
                                    try:
                                        msg = json.loads(line)
                                        # --- BROADCAST LOGIC ---
                                        message_json = json.dumps(msg)
                                        for client_ws in list(ws_clients):
                                            try:
                                                client_ws.send(message_json)
                                            except Exception:
                                                try:
                                                    ws_clients.remove(client_ws)
                                                except ValueError:
                                                    pass
                                    except json.JSONDecodeError as e:
                                        print(f"[IPC] Invalid JSON line: {e}. Data: {line[:50]}...")
            
            except Exception as e:
                print(f"[IPC] Fatal UNIX Socket listener error: {e}")

    def handle_client(self, conn):
        with conn:
            while True:
                try:
                    data = conn.recv(1024)
                    if not data:
                        break
                                    
                    try:
                        decoded_data = None
                        if isinstance(data, bytes):
                            decoded_data = data.decode('utf-8')
                        else:
                            decoded_data = data
                        
                        if not decoded_data.strip():
                            continue

                        msg = json.loads(decoded_data.strip())
                        
                        # Format the message for Recent Activity display
                        activity_message = self.format_activity_message(msg)
                        
                        # Broadcast to WebSocket clients
                        if activity_message:
                            self.broadcast_to_websockets(activity_message)
                        
                        # Update internal state (keep your existing logic)
                        self.update_internal_state(msg)

                    except json.JSONDecodeError as e:
                        print(f"Invalid JSON received: {decoded_data}")
                        continue
                    except Exception as e:
                        print(f"Error processing message: {e}")
                        continue
                        
                except Exception as e:
                    print(f"Socket connection error: {e}")
                    break

    def format_activity_message(self, msg):
        """Format daemon messages for Recent Activity display"""
        msg_type = msg.get("type")
        timestamp = datetime.now().strftime('%H:%M:%S')
        
        activity_msg = {
            'type': 'activity',
            'timestamp': timestamp,
            'category': 'backup'  # Could be 'scan', 'transfer', 'system'
        }
        
        if msg_type == "scanning":
            folder = msg.get("folder")
            if folder:
                activity_msg.update({
                    'title': 'Scanning Files',
                    'message': f'Scanning folder: {os.path.basename(folder)}',
                    'icon': 'search',
                    'status': 'info'
                })
                return activity_msg
            else:
                activity_msg.update({
                    'title': 'Scanning Complete',
                    'message': 'Finished scanning files',
                    'icon': 'check',
                    'status': 'success'
                })
                return activity_msg
                
        elif msg_type == "transfer_progress":
            filename = msg.get("filename", "unknown")
            progress = msg.get("progress", 0)
            size = msg.get("size", "0 KB")
            eta = msg.get("eta", "n/a")
            
            activity_msg.update({
                'title': 'Copying Files',
                'message': f'{filename} - {progress}% ({size})',
                'progress': progress,
                'eta': eta,
                'icon': 'copy',
                'status': 'active'
            })
            return activity_msg
            
        elif msg_type == "summary_updated":
            activity_msg.update({
                'title': 'Backup Updated',
                'message': 'Backup summary has been updated',
                'icon': 'refresh',
                'status': 'success'
            })
            return activity_msg
            
        elif msg_type == "error":
            activity_msg.update({
                'title': 'Error',
                'message': msg.get("message", "Unknown error"),
                'icon': 'error',
                'status': 'error'
            })
            return activity_msg
            
        elif msg_type == "backup_complete":
            activity_msg.update({
                'title': 'Backup Complete',
                'message': 'Real-time backup cycle completed',
                'icon': 'check_circle',
                'status': 'success'
            })
            return activity_msg
        
        return None

    def update_internal_state(self, msg):
        """Your existing state management logic"""
        if not hasattr(self, 'current_daemon_state'):
            self.current_daemon_state = "idle"
            
        msg_type = msg.get("type")
        
        if msg_type == "scanning":
            folder_being_scanned = msg.get("folder")
            if folder_being_scanned:
                self.current_daemon_state = "scanning"
            else:
                if not self.transfer_rows:
                    if os.path.exists(server.get_interrupted_main_file()):
                        self.current_daemon_state = "interrupted"
                    else:
                        self.current_daemon_state = "idle"
                        
        elif msg_type == "transfer_progress":
            self.current_daemon_state = "copying"
            
        elif msg_type == "summary_updated":
            if not self.transfer_rows:
                if os.path.exists(server.get_interrupted_main_file()):
                    self.current_daemon_state = "interrupted"
                else:
                    self.current_daemon_state = "idle"
                    
    def broadcast_to_websockets(self, message):
        """Broadcast message to all connected WebSocket clients"""
        if isinstance(message, dict):
            message = json.dumps(message)
        
        # Iterate over a copy of the list (list(ws_clients))
        # This allows safe removal from the original 'ws_clients' list.
        for client in list(ws_clients): 
            try:
                client.send(message)
            except Exception as e:
                print(f"Error sending to WebSocket client: {e}")
                # Remove disconnected clients from the original list
                try:
                    ws_clients.remove(client)
                except ValueError:
                    pass # Client already removed

    # =============================================================================
	# Open file location
	# =============================================================================
    def on_open_location_clicked(self, file_path_from_button):
        if file_path_from_button:
            folder_path = os.path.dirname(file_path_from_button)
            
            if not os.path.isdir(folder_path):
                print(f"Error: The parent directory does not exist or is not accessible: {folder_path}")
                return

            self._open_location(folder_path)

    def _open_file(self, file_path):
        """Fallback to xdg-open if Gio methods fail for opening a file."""
        try:
            sub.Popen(["xdg-open", file_path])
        except Exception as e_xdg:
            print(f"Failed to open file {file_path} with xdg-open: {e_xdg}")

    def _open_location(self, folder_path):
        """Fallback to xdg-open if Gio methods fail."""
        try:
            sub.Popen(["xdg-open", folder_path])
        except Exception as e_xdg:
            print(f"Failed to open folder {folder_path} with xdg-open: {e_xdg}")


# =============================================================================
# APIS
# =============================================================================
@app.route('/')
def index():
    return render_template('web.html')

@sock.route('/ws') 
def ws(ws_client):
    """WebSocket endpoint to manage client list and handle pings."""
    global ws_clients, BACKUP_STATUS
    
    ws_clients.append(ws_client)
    
    try:
        # Send initial status (if you maintain one)
        ws_client.send(json.dumps({'type': 'status', 'data': BACKUP_STATUS}))
        
        while True:
            # Block and wait for messages from the browser (mostly pings)
            message = ws_client.receive()
            if message is None:
                break
            
            # Respond to PING for heartbeat
            data = json.loads(message)
            if data.get('type') == 'ping':
                ws_client.send(json.dumps({'type': 'pong'}))
            
    except Exception:
        # Client disconnect or error
        pass
    finally:
        # Remove client on disconnect
        if ws_client in ws_clients:
            ws_clients.remove(ws_client)


# =============================================================================
# ERRORS HANDLERS
# =============================================================================
@app.errorhandler(500)
def handle_500_error(error):
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(404)
def handle_404_error(error):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(Exception)
def handle_unexpected_error(error):
    logging.error(f"Unhandled exception: {str(error)}")
    return jsonify({'error': 'An unexpected error occurred'}), 500


# =============================================================================
# CONFIG FILE HANDLER
# =============================================================================
@app.route('/api/backup/usage')
def backup_usage():
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # 1. Ensure the necessary config information are registered
        necessary_config_sections = config.has_section('DEVICE_INFO')
        necessary_config_options = config.has_option('DEVICE_INFO', 'path')
        
        if not necessary_config_sections or not necessary_config_options:
            # User did not registered a backup device yet      
            return jsonify({
                'success': False,
                'error': 'Please select a backup device first! Go to Devices → Select your storage → Confirm Selection',
                'user_action_required': True,
                'location': 'Not configured'
            })
        
        # Now we know the config exists, so we can safely get DRIVER_PATH
        if not DRIVER_PATH or not os.path.exists(DRIVER_PATH):
            # Device is disconnected or path doesn't exist
            return jsonify({
                'success': False,
                'error': 'Connection to backup device is not available. Please ensure the backup device is connected and mounted.',
                'user_action_required': True,
                'location': DRIVER_PATH or 'Not configured'
            })

        # Get disk usage
        total, used, free = shutil.disk_usage(DRIVER_PATH)
        percent_used = (used / total) * 100 if total > 0 else 0
        
        # Get home disk usage
        home_total, home_used, home_free = shutil.disk_usage(os.path.expanduser('~'))
        home_percent_used = (home_used / home_total) * 100 if home_total > 0 else 0
        
        # =============================================================================
        # Summary and backup summary
        # =============================================================================
        def get_backup_summary() -> dict:
            try:
                summary_file = server.get_summary_file_path()
                if not os.path.exists(summary_file):
                    print(f"Summary file not found: {summary_file}")
                    return {}

                if os.path.exists(summary_file):
                    with open(summary_file, 'r') as f:
                        return json.load(f)
                else:
                    return {}
            except json.JSONDecodeError as e:
                logging.error(f"Error decoding JSON from backup summary: {e}")
                return {}
          
        # Return the combined usage and device information
        return jsonify({
            'success': True,
            'location': DRIVER_PATH,
            'percent_used': round(percent_used, 1),
            'human_used': bytes_to_human(used),
            'human_total': bytes_to_human(total),
            'human_free': bytes_to_human(free),
            'home_human_used': bytes_to_human(home_used),
            'home_human_total': bytes_to_human(home_total),
            'home_human_free': bytes_to_human(home_free),
            'home_percent_used': round(home_percent_used, 1),
            'users_home_path': os.path.expanduser('~'),
            'summary': get_backup_summary() if get_backup_summary() else "No backup summary available",
            # Add device information from config
            'device_name': DRIVER_NAME,
            'filesystem': DRIVER_FILESYTEM,
            'model': DRIVER_MODEL,
            'serial_number': "DRIVER_SERIAL"
        })        
    except Exception as e:
        app.logger.error(f"Error in backup_usage: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e),
            'location': 'Error'
        }), 500

@app.route('/api/logs', methods=['GET'])
def get_logs():
    try:
        # Check if log file exists
        if not os.path.exists(LOG_FILE_PATH):
            return jsonify({
                'success': False,
                'error': 'Log file not found',
                'path': LOG_FILE_PATH
            }), 404

        # Get limit parameter (default to 100 lines)
        limit = request.args.get('limit', 100, type=int)
        
        # Read log file with limit
        logs = []
        line_count = 0
        
        with open(LOG_FILE_PATH, 'r') as f:
            for line in f:
                if line_count >= limit and limit > 0:
                    break
                    
                if not line.strip():
                    continue
                    
                # Simple parsing of log lines
                try:
                    timestamp_str = line[:23]
                    message = line[24:].strip()
                    
                    # Parse timestamp
                    timestamp = datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S,%f')
                    
                    # Detect log level
                    log_level = 'INFO'
                    if '[WARNING]' in message:
                        log_level = 'WARNING'
                    elif '[ERROR]' in message:
                        log_level = 'ERROR'
                    
                    logs.append({
                        'timestamp': timestamp_str,
                        'level': log_level,
                        'message': message
                    })
                except Exception as e:
                    logs.append({
                        'raw': line.strip(),
                        'error': str(e)
                    })
                
                line_count += 1

        return jsonify({
            'success': True,
            'logs': logs,
            'limit_applied': limit,
            'last_modified': os.path.getmtime(LOG_FILE_PATH)
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/logs/clear', methods=['POST'])
def clear_logs():
    """Clear the log file (rotate it)"""
    try:
        if os.path.exists(LOG_FILE_PATH):
            # Instead of deleting, rotate the log file
            rotated_path = f"{LOG_FILE_PATH}.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            os.rename(LOG_FILE_PATH, rotated_path)
            
            # Create new empty log file
            open(LOG_FILE_PATH, 'w').close()
            
            return jsonify({
                'success': True,
                'message': 'Logs rotated',
                'rotated_to': rotated_path
            })
        return jsonify({
            'success': False,
            'error': 'Log file not found'
        }), 404
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
        
@app.route('/api/backup/current-device', methods=['GET'])
def get_current_device():
    """Get currently selected backup device"""
    try:
        return jsonify({'success': True, 'device_path': DRIVER_PATH})
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/backup/select-device', methods=['POST'])
def select_device():
    data = request.get_json()
    device_info = data.get('device_info', {})
    device_path = device_info.get('mount_point')
    
    if not device_path:
        return jsonify({'success': False, 'error': 'No device path provided'}), 400
    
    try:
        if not os.path.exists(device_path):
            return jsonify({
                'success': False, 
                'error': f'Path does not exist: {device_path}'
            }), 400
            
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if not config.has_section('DEVICE_INFO'):
            config.add_section('DEVICE_INFO')
            
        config.set('DEVICE_INFO', 'path', device_path)
        config.set('DEVICE_INFO', 'name', device_info.get('name', 'N/A'))
        config.set('DEVICE_INFO', 'device', device_info.get('device', 'N/A'))
        config.set('DEVICE_INFO', 'serial_number', device_info.get('serial_number', 'N/A'))
        config.set('DEVICE_INFO', 'model', device_info.get('model', 'N/A'))
        
        is_ssd_value = 'ssd' if device_info.get('is_ssd') else 'hdd'
        config.set('DEVICE_INFO', 'disk_type', is_ssd_value)
        config.set('DEVICE_INFO', 'filesystem', device_info.get('filesystem', 'N/A'))
        config.set('DEVICE_INFO', 'total_size_bytes', str(device_info.get('total', 0)))

        with open(CONFIG_PATH, 'w') as configfile:
            config.write(configfile)
        
        # Update global variables - CRITICAL: Update backup paths too!
        global DRIVER_NAME, DRIVER_PATH, DRIVER_FILESYTEM, DRIVER_MODEL
        global APP_MAIN_BACKUP_DIR, APP_BACKUP_DIR
        
        DRIVER_NAME = device_info.get('name', 'N/A')
        DRIVER_PATH = device_path
        DRIVER_FILESYTEM = device_info.get('filesystem', 'N/A')
        DRIVER_MODEL = device_info.get('model', 'N/A')
        
        # CRITICAL: Update backup directory paths to point to new device
        APP_MAIN_BACKUP_DIR = os.path.join(DRIVER_PATH, 'timemachine', 'backups', '.main_backup')
        APP_BACKUP_DIR = os.path.join(DRIVER_PATH, 'timemachine', 'backups')
        
        # Update search handler and clear caches
        search_handler.update_backup_location()
        search_handler.clear_cache()
        
        # Clear any file version caches
        import gc
        gc.collect()
        
        return jsonify({
            'success': True,
            'message': f'Backup device {device_path} configured successfully.',
            'path': device_path
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'Failed to save configuration: {str(e)}'
        }), 500

@app.route('/api/storage/devices', methods=['GET'])
def scan_devices():
    """Scan and return all available storage devices"""
    try:
        devices = get_all_storage_devices()  # storage_util.py
        app.logger.info(f"Found {len(devices)} storage devices")
        return jsonify({
            'success': True,
            'devices': devices,
            'count': len(devices)
        })
    except Exception as e:
        app.logger.error(f"Error scanning devices: {str(e)}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# WATCHED FOLDERS
# =============================================================================
@app.route('/api/watched-folders')
def get_watched_folders():
    try:
        # RELOAD the config every time this endpoint is called
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # Get the CURRENT excluded folders from config
        current_excluded_folders = config.get('EXCLUDE_FOLDER', 'folders', fallback='')
        if current_excluded_folders:
            not_backup_folders = [f.strip() for f in current_excluded_folders.split(',') if f.strip()]
        else:
            not_backup_folders = []
            
        watched_folders = []
        print(f"USERS_HOME: {USERS_HOME}")
        print(f"Current excluded folders: {not_backup_folders}")
        
        for item in os.listdir(USERS_HOME):
            item_path = os.path.join(USERS_HOME, item)
            
            if not os.path.isdir(item_path) or item.startswith('.'):
                continue
                
            # Check if folder should be excluded from backup
            to_backup = item in not_backup_folders or item_path in not_backup_folders
            
            watched_folders.append({
                'name': item,
                'path': item_path,
                'status': 'Inactive' if to_backup else 'Active',
                'last_activity': datetime.now().isoformat(),
                'destination': os.path.join(APP_MAIN_BACKUP_DIR, item),
                'to_backup': to_backup,  # This should match the exclude logic
                'excluded_subfolders': [
                    os.path.relpath(sub, item_path) 
                    for sub in not_backup_folders 
                    if sub.startswith(item_path)
                ]
            })
            
        watched_folders.sort(key=lambda x: (x['status'] == 'Active', x['name'].lower()))
        
        print(f"Found {len(watched_folders)} folders")
        return jsonify(watched_folders)
        
    except Exception as e:
        logging.error(f"Error in get_watched_folders: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e), 'folders': []}), 500
    
@app.route('/api/folders/handle_folder_include_exclude', methods=['POST'])
def handle_folder_include_exclude():
    # Input validation
    if not request.json:
        return jsonify({'success': False, 'error': 'No JSON data'}), 400
    
    folder_path = request.json.get('path', '').strip()
    to_backup = request.json.get('to_backup')
    
    if not folder_path:
        return jsonify({'success': False, 'error': 'Folder path required'}), 400
    
    if to_backup is None:
        return jsonify({'success': False, 'error': 'Backup preference required'}), 400

    try:
        # Normalize path
        abs_path = os.path.abspath(folder_path)
        if not os.path.isdir(abs_path):
            return jsonify({'success': False, 'error': 'Folder not found'}), 400

        # Read config
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # Ensure section exists
        if not config.has_section('EXCLUDE_FOLDER'):
            config.add_section('EXCLUDE_FOLDER')

        # Get current excludes as set for O(1) lookups
        current = config.get('EXCLUDE_FOLDER', 'folders', fallback='')
        excluded = {f.strip() for f in current.split(',') if f.strip()}
        
        # Apply changes
        if to_backup:
            # Include in backup - remove from excludes
            excluded.discard(abs_path)
        else:
            # Exclude from backup - add to excludes
            excluded.add(abs_path)

        # Write back if changed
        config.set('EXCLUDE_FOLDER', 'folders', ','.join(sorted(excluded)))
        
        with open(CONFIG_PATH, 'w') as f:
            config.write(f)

        return jsonify({
            'success': True,
            'message': f"Folder {'included in' if to_backup else 'excluded from'} backup",
            'to_backup': to_backup
        })

    except Exception as e:
        return jsonify({'success': False, 'error': f'Config error: {str(e)}'}), 500
    

# =============================================================================####
# HANDLER FOR DAEMON AND REALTIME CHECKBOX
# =============================================================================####
@app.route('/api/realtime-backup/daemon', methods=['POST'])
def call_daemon_script():
    data = request.get_json()
    is_active = data.get('is_active', False)
    
    def start_daemon():
        """Start the daemon and store its PID, ensuring only one instance runs."""
        def _do_start_daemon():
            process = None # Initialize process to None
            try:
                # Start a new daemon process
                daemon_cmd = ['python3', DAEMON_PY_LOCATION]
                logging.info(f"UI: Attempting to start daemon with command: {' '.join(daemon_cmd)}")
                print(f"UI: Attempting to start daemon with command: {' '.join(daemon_cmd)}")

                process = sub.Popen(
                    daemon_cmd,
                    start_new_session=True,
                    close_fds=True,
                    stdout=sub.PIPE,  # Capture standard output
                    stderr=sub.PIPE   # Capture standard error
                )

                # Get the output and errors (if any)
                # You can set a timeout to prevent blocking indefinitely if the daemon hangs
                stdout, stderr = process.communicate(timeout=10) # Increased timeout slightly

                # Store the new PID in the file
                with open(DAEMON_PID_LOCATION, 'w') as f:
                    f.write(str(process.pid))
                logging.info(f"UI: Daemon process launched with PID {process.pid}.")
                if stdout:
                    logging.info(f"UI: Daemon stdout:\n{stdout.decode(errors='replace')}")
                if stderr:
                    logging.error(f"UI: Daemon stderr:\n{stderr.decode(errors='replace')}")
            except sub.TimeoutExpired:
                logging.error(f"UI: Timeout expired while starting daemon or getting its initial output. PID: {process.pid if process else 'N/A'}")
                if process:
                    process.kill() # Ensure the process is killed if it timed out
                    stdout, stderr = process.communicate() # Try to get any final output
                    if stdout:
                        logging.info(f"UI: Daemon stdout (after timeout kill):\n{stdout.decode(errors='replace')}")
                    if stderr:
                        logging.error(f"UI: Daemon stderr (after timeout kill):\n{stderr.decode(errors='replace')}")
            except Exception as e:
                error_msg = f"UI: Failed to start daemon: {e}"
                print(error_msg)
                logging.error(error_msg, exc_info=True)
        threading.Thread(target=_do_start_daemon, daemon=True).start()

    def stop_daemon():
        """Stop the daemon by reading its PID."""
        pid_file_path = DAEMON_PID_LOCATION
        if os.path.exists(pid_file_path):
            pid_str = None
            pid = None
            try:
                with open(pid_file_path, 'r') as f:
                    pid_str = f.read().strip()
                if not pid_str:
                    logging.warning(f"Daemon PID file {pid_file_path} is empty. Removing stale file.")
                    os.remove(pid_file_path)
                    return # Nothing to stop
                pid = int(pid_str)
            except ValueError:
                logging.error(f"Invalid PID '{pid_str}' in {pid_file_path}. Removing stale file.")
                try:
                    os.remove(pid_file_path)
                except OSError as e_rem:
                    logging.error(f"Failed to remove stale/invalid PID file {pid_file_path}: {e_rem}")
                return # Cannot stop if PID is invalid
            except OSError as e_read: # Error reading or removing file
                logging.error(f"Error accessing PID file {pid_file_path}: {e_read}")
                return # Cannot proceed

            try:
                os.kill(pid, signal.SIGTERM)  # Send termination signal
                logging.info(f"Daemon with PID {pid} signaled to stop.")
                # Daemon is responsible for removing its PID file on clean shutdown.
            except OSError as e:
                # Log level changed to warning for ESRCH as it's a common "stale PID" scenario
                if e.errno == errno.ESRCH: # No such process
                    logging.warning(f"Daemon process with PID {pid} not found (ESRCH). PID file {pid_file_path} is stale, removing.")
                    try:
                        if os.path.exists(pid_file_path): # Check again before removing
                           os.remove(pid_file_path)
                    except OSError as e_rem_stale:
                        logging.error(f"Failed to remove stale PID file {pid_file_path} after ESRCH: {e_rem_stale}")
                else: # Other OS errors during kill
                    logging.error(f"[CRITICAL]: Failed to stop daemon PID {pid}. Error: {e}") # Corrected typo
        else:
            logging.info("Daemon is not running (no PID file).")

    def call_daemon_script():
        try:
            # Check if the daemon is running based on the existence and validity of the PID file
            if server.is_daemon_running():
                if not is_active:
                    # If daemon is running and is_active is False, stop the daemon
                    # stop_daemon()
                    logging.info("Real-time backup deactivated (daemon stopped).")
                    return jsonify({'status': 'Real-time backup deactivated'})
                else:
                    logging.info("Real-time backup is already active. No action taken.")
                    return jsonify({'status': 'Real-time backup already active'})
            elif is_active:
                # If daemon is not running and is_active is True, start the daemon
                
                # start_daemon()
                logging.info("Real-time backup activated (daemon started).")

                # Check if daemon process was started successfully; this checks if the process exists and is our daemon.
                # Using the checks within server.is_daemon_running() for consistency.
                if server.is_daemon_running():
                    return jsonify({'status': 'Real-time backup activated'})
                else: # If the daemon did not start correctly, report the failure
                    # Ideally include logging or more specific error handling from server.start_daemon()
                    error_message = "Failed to start the real-time backup daemon."
                    logging.error(error_message)
                    return jsonify({'error': error_message}), 500
            else: # Not running and not trying to start (unclear or UI sent off when it should not have)
                logging.info("Real-time backup is inactive.")
                return jsonify({'status': 'Real-time backup inactive'})  # Informative for UI even if no action
        except Exception as e:
            return jsonify({'error': f'Failed to toggle real-time backup: {str(e)}'}), 500


    try:
        # Read config file
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)

        # Check for section and option existence
        if not config.has_section('BACKUP'):
            config.add_section('BACKUP')
        
        # Get current value or default to 'false'
        current_value = config.get('BACKUP', 'automatically_backup', fallback='false')

        # Convert string value to boolean for comparison
        current_value_bool: bool = current_value.lower() == 'true'

        # Update the config only if the value is different from the requested is_active state
        if current_value_bool != is_active:
            config.set('BACKUP', 'automatically_backup', str(is_active).lower())
            with open(CONFIG_PATH, 'w') as config_file:
                config.write(config_file)
            logging.info(f"Real-time backup set to: {'Active' if is_active else 'Inactive'}")
            # Call daemon
            call_daemon_script()
            # Success message with updated state
            return jsonify({'status': f"Real-time backup {'activated' if is_active else 'deactivated'}"})
        else:
            # Indicate no change needed
            logging.info(f"Real-time backup is already {'active' if is_active else 'inactive'}. No changes made.")
            return jsonify({'status': f"Real-time backup already {'active' if is_active else 'inactive'}"})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# =============================================================================####
# HANDLER SEARCH FOR FILES
# =============================================================================####
@app.route('/api/search', methods=['GET'])
def search_files():
    query = request.args.get('query', '').strip().lower()
    if not query:
        return jsonify(files=[])
    try:
        # Instead of handling the query here, we'll rely on the client-side
        # to manage the cached results after the initial scan.
        search_results = search_handler.perform_search(query)
        return jsonify({
            'files': search_results, # Return the actual search results
            'total': len(search_handler.files)  # Return the total number of files
        })
    except Exception as e:
        app.logger.error(f"Error during file search: {e}", exc_info=True)
        return jsonify(error="An error occurred during search."), 500


# =============================================================================####
# HANDLER FILES ACTIONS (OPEN, OPEN LOCATION ETC.)
# =============================================================================####
@app.route('/api/open-location', methods=['POST'])
def open_location():
    try:
        data = request.get_json()
        file_path = data.get('file_path')
        
        if not file_path:
            return jsonify({'success': False, 'error': 'No file_path provided'}), 400

        if os.name == 'nt':  # Windows
            os.startfile(file_path)  # Open the folder
        elif os.uname().sysname == 'Darwin':  # macOS
            sub.run(['open', file_path])  # Open the folder
        else:  # Linux/Unix
            sub.run(['xdg-open', file_path])  # Open the folder

        return jsonify({'success': True, 'message': f'Attempted to open folder: {file_path}'}), 200

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/open-file', methods=['POST'])
def open_file():
    try:
        data = request.get_json()
        file_path = data.get('file_path')

        if not file_path:
            return jsonify({'success': False, 'error': 'No file_path provided'}), 400

        # Security precaution: Validate file_path if coming from untrusted sources
        # Ensure it's not trying to execute dangerous commands

        # Commands to open the file itself with its default application
        if os.name == 'nt':  # Windows
            os.startfile(file_path) # This opens the file itself
        elif os.uname().sysname == 'Darwin':  # macOS
            sub.run(['open', file_path]) # This opens the file itself
        else:  # Linux/Unix
            sub.run(['xdg-open', file_path]) # This opens the file itself

        return jsonify({'success': True, 'message': f'Attempted to open file: {file_path}'}), 200

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/restore-file', methods=['POST'])
def restore_file():
    try:
        data = request.get_json()
        file_path = data.get('file_path')

        if not file_path:
            return jsonify({'success': False, 'error': 'No file_path provided'}), 400

        # Commands to restore the file
        if os.name == 'nt':  # Windows
            # TODO: Implement Windows restoration logic
            print(f"Windows restoration for {file_path} is not yet implemented.")
            return jsonify({'success': False, 'error': 'Windows restoration not implemented'}), 501
        elif os.uname().sysname == 'Darwin':  # macOS
            # TODO: Implement macOS restoration logic
            print(f"macOS restoration for {file_path} is not yet implemented.")
            return jsonify({'success': False, 'error': 'macOS restoration not implemented'}), 501
        else:  # Linux/Unix
            abs_file_to_restore_path = os.path.abspath(file_path)
            main_backup_abs_path = os.path.abspath(APP_MAIN_BACKUP_DIR)
            incremental_backups_abs_path = os.path.abspath(APP_BACKUP_DIR)  # FIXED: Removed extra parenthesis

            rel_path = None
            if abs_file_to_restore_path.startswith(main_backup_abs_path):
                rel_path = os.path.relpath(abs_file_to_restore_path, main_backup_abs_path)
            elif abs_file_to_restore_path.startswith(incremental_backups_abs_path):
                temp_rel_path = os.path.relpath(abs_file_to_restore_path, incremental_backups_abs_path)
                # Expected structure: DATE/TIME/actual/path/to/file
                parts = temp_rel_path.split(os.sep)
                if len(parts) > 2: # Ensure there's at least DATE/TIME and then the actual relative path
                    rel_path = os.path.join(*parts[2:])
                else:
                    print(f"Error: Could not determine relative path for incremental backup: {file_path}")
                    return jsonify({'success': False, 'error': 'Could not determine relative path for incremental backup'}), 400
            else:
                print(f"Error: File path '{file_path}' is not within known backup locations: '{main_backup_abs_path}' or '{incremental_backups_abs_path}'")
                return jsonify({'success': False, 'error': 'File not within known backup locations'}), 400

            destination_path = os.path.join(USERS_HOME, rel_path)

            def do_restore_async(src, dst):
                try:
                    print(f"🚀 Starting restore from: {src}")
                    print(f"🎯 Restoring to: {dst}")
                    
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    
                    # Check if source file exists
                    if not os.path.exists(src):
                        print(f"❌ Error: Source file does not exist: {src}")
                        return
                    
                    total_size = os.path.getsize(src)
                    copied = 0
                    chunk_size = 1024 * 1024  # 1MB

                    print(f"📁 Copying {total_size} bytes...")
                    
                    # TODO
                    """ 
                        Create a notification "Restoring file"
                        Use send_restoring_file from server.py file.
                    """

                    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
                        while True:
                            chunk = fsrc.read(chunk_size)
                            if not chunk: 
                                break
                            fdst.write(chunk)
                            copied += len(chunk)

                    print(f"✅ Successfully restored {src} to {dst}")
                    shutil.copystat(src, dst)
                    print(f"🎉 Restore completed successfully!")
                    
                    # TODO
                    """ 
                        Create a notification "Restoretion completed"
                    """
                    
                except Exception as e:
                    print(f"❌ Error restoring file (async thread): {e}")
            
            # Start the restoration in a background thread
            threading.Thread(target=asyncio.run(do_restore_async, args=(file_path, destination_path), daemon=True)).start()

            return jsonify({
                'success': True, 
                'message': 'File restoration process started in background.',
                'restored_to': destination_path
            }), 202

    except Exception as e:
        print(f"Error in restore_file endpoint: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500
    

# =============================================================================####
# READ CONTENT
# =============================================================================####
@app.route('/api/file-content', methods=['GET'])
def read_file_content(file_path=None):
    # Accept either 'file' or 'file_path' as query parameter for compatibility
    file_path = request.args.get('file') or request.args.get('file_path')
    if not file_path:
        return jsonify({'success': False, 'error': 'File path is required'}), 400

    # Security: Only allow reading files from backup folders
    allowed_dirs = [APP_MAIN_BACKUP_DIR, server.app_backup_dir]
    abs_path = os.path.abspath(file_path)
    if not any(abs_path.startswith(os.path.abspath(d)) for d in allowed_dirs):
        return jsonify({'success': False, 'error': 'Access denied: file not in backup folders'}), 403

    # Only allow reading text files (simple extension check)
    text_extensions = ['.txt', '.md', '.py', '.json', '.csv', '.log', '.html', '.js', '.css', '.xml', '.yaml', '.yml', '.sh']
    ext = os.path.splitext(abs_path)[1].lower()
    if ext not in text_extensions:
        # Return metadata for unsupported/binary files
        try:
            stat_info = os.stat(abs_path)
            metadata = {
                'name': os.path.basename(abs_path),
                'size': f"{stat_info.st_size} bytes",
                'mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat_info.st_mtime)),
                'type': ext,
            }
            return jsonify({
                'success': False,
                'error': 'Binary or unsupported file type',
                'metadata': metadata
            }), 200
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    try:
        with open(abs_path, 'r', encoding='utf-8') as f:
            content = f.read()
        return jsonify({'success': True, 'content': content}), 200
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# FOR TESTING
# @app.route('/api/file-versions', methods=['GET'])
# def get_file_versions():
#     file_path_requested = request.args.get('file_path')
#     if not file_path_requested:
#         return jsonify({'success': False, 'error': 'Missing file_path'}), 400
    
#     versions = []
    
#     try:
#         print(f"\n=== File Version Lookup Debug ===")
#         print(f"Requested path: {file_path_requested}")
        
#         # Get absolute paths for all locations
#         home_abs_path = os.path.expanduser(USERS_HOME)
#         main_backup_abs_path = os.path.expanduser(APP_MAIN_BACKUP_DIR)
#         incremental_base_path = os.path.expanduser(APP_BACKUP_DIR)
        
#         print(f"Home path: {home_abs_path}")
#         print(f"Main backup: {main_backup_abs_path}")
#         print(f"Incremental base: {incremental_base_path}")
        
#         # CRITICAL FIX: Extract just the filename for lookup
#         file_name_only = os.path.basename(file_path_requested)
#         print(f"Using filename for search: {file_name_only}")
        
#         # 1. Current version in home directory
#         # Search for the file in home directory recursively
#         for root, dirs, files in os.walk(home_abs_path):
#             if file_name_only in files:
#                 home_file_path = os.path.join(root, file_name_only)
#                 stat = os.stat(home_file_path)
#                 versions.append({
#                     'key': 'home',
#                     'time': 'Current Version',
#                     'path': home_file_path,
#                     'size': stat.st_size,
#                     'mtime': stat.st_mtime
#                 })
#                 print(f"Found home version: {home_file_path}")
#                 break
        
#         # 2. Main backup version - from CURRENT device
#         main_backup_file = None
#         if os.path.exists(main_backup_abs_path):
#             for root, dirs, files in os.walk(main_backup_abs_path):
#                 if file_name_only in files:
#                     main_backup_file = os.path.join(root, file_name_only)
#                     stat = os.stat(main_backup_file)
#                     versions.append({
#                         'key': 'main',
#                         'time': 'Main Backup',
#                         'path': main_backup_file,
#                         'size': stat.st_size,
#                         'mtime': stat.st_mtime
#                     })
#                     print(f"Found main backup version: {main_backup_file}")
#                     break
        
#         # 3. Incremental backup versions - from CURRENT device
#         if os.path.exists(incremental_base_path):
#             for date_folder in sorted(os.listdir(incremental_base_path), reverse=True):
#                 date_path = os.path.join(incremental_base_path, date_folder)
#                 if not os.path.isdir(date_path):
#                     continue
                    
#                 for time_folder in sorted(os.listdir(date_path), reverse=True):
#                     time_path = os.path.join(date_path, time_folder)
#                     if not os.path.isdir(time_path):
#                         continue
                    
#                     # Search for the file in this incremental backup
#                     for root, dirs, files in os.walk(time_path):
#                         if file_name_only in files:
#                             backup_file = os.path.join(root, file_name_only)
#                             stat = os.stat(backup_file)
                            
#                             # FIXED: Use the original format "Nov 13, 2025, 10:53"
#                             try:
#                                 # Parse DD-MM-YYYY format and convert to "Nov 13, 2025"
#                                 day, month, year = date_folder.split('-')
#                                 month_int = int(month)
#                                 month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
#                                              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
#                                 month_name = month_names[month_int - 1] if 1 <= month_int <= 12 else month
                                
#                                 # Format time from "10_53" to "10:53"
#                                 formatted_time = time_folder.replace('_', ':')
                                
#                                 display_time = f"{month_name} {day}, {year}, {formatted_time}"
#                             except:
#                                 # Fallback to original format if parsing fails
#                                 display_time = f"{date_folder} {time_folder.replace('_', ':')}"
                                
#                             versions.append({
#                                 'key': f"{date_folder}_{time_folder}",
#                                 'time': display_time,
#                                 'path': backup_file,
#                                 'size': stat.st_size,
#                                 'mtime': stat.st_mtime
#                             })
#                             print(f"Found incremental version: {backup_file}")
#                             break  # Found in this time folder, move to next
        
#         # 4. If the requested file itself is different from what we found, include it
#         requested_file_abs = os.path.abspath(file_path_requested)
#         if (requested_file_abs not in [v['path'] for v in versions] and 
#             os.path.exists(requested_file_abs)):
            
#             stat = os.stat(requested_file_abs)
            
#             # Determine what type of file this is for display
#             if requested_file_abs.startswith(main_backup_abs_path):
#                 time_display = 'Main Backup'
#                 key = 'main_requested'
#             elif requested_file_abs.startswith(incremental_base_path):
#                 # Extract date/time from path
#                 temp_rel = os.path.relpath(requested_file_abs, incremental_base_path)
#                 parts = temp_rel.split(os.sep)
#                 if len(parts) >= 2:
#                     date_folder = parts[0]
#                     time_folder = parts[1]
#                     try:
#                         # Format to "Nov 13, 2025, 10:53"
#                         day, month, year = date_folder.split('-')
#                         month_int = int(month)
#                         month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
#                                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
#                         month_name = month_names[month_int - 1] if 1 <= month_int <= 12 else month
#                         formatted_time = time_folder.replace('_', ':')
#                         time_display = f"{month_name} {day}, {year}, {formatted_time}"
#                     except:
#                         time_display = f"{date_folder} {time_folder.replace('_', ':')}"
#                     key = f"{date_folder}_{time_folder}_requested"
#                 else:
#                     time_display = 'Backup Version'
#                     key = 'backup_requested'
#             else:
#                 time_display = 'Requested File'
#                 key = 'requested'
            
#             versions.append({
#                 'key': key,
#                 'time': time_display,
#                 'path': requested_file_abs,
#                 'size': stat.st_size,
#                 'mtime': stat.st_mtime
#             })
#             print(f"Added requested file as version: {requested_file_abs}")
        
#         # Sort versions by modification time (newest first)
#         versions.sort(key=lambda x: x.get('mtime', 0), reverse=True)
        
#         # Remove duplicates by path
#         seen_paths = set()
#         unique_versions = []
#         for version in versions:
#             if version['path'] not in seen_paths:
#                 seen_paths.add(version['path'])
#                 unique_versions.append(version)
        
#         # Clean up the response
#         for version in unique_versions:
#             version.pop('mtime', None)
        
#         print(f"Found {len(unique_versions)} unique versions")
#         for v in unique_versions:
#             print(f"  - {v['time']}: {v['path']}")
#         print("=== End File Version Lookup ===\n")
        
#         return jsonify({'success': True, 'versions': unique_versions}), 200
        
#     except Exception as e:
#         print(f"Error in get_file_versions: {e}")
#         import traceback
#         traceback.print_exc()
#         return jsonify({'success': False, 'error': str(e)}), 500
    
# BACKUP
@app.route('/api/file-versions', methods=['GET'])
def get_file_versions():
    file_path_requested = request.args.get('file_path')
    if not file_path_requested:
        return jsonify({'success': False, 'error': 'Missing file_path'}), 400
    
    versions: list = []
    
    try:
        print(f"\n=== File Version Lookup Debug ===")
        print(f"Requested path: {file_path_requested}")
        
        # Get absolute paths for all locations (WITH PARENTHESES!)
        home_abs_path = os.path.abspath(USERS_HOME)
        main_backup_abs_path = os.path.abspath(APP_MAIN_BACKUP_DIR)
        incremental_base_path = os.path.abspath(APP_BACKUP_DIR)  # FIXED: Added parentheses
        
        print(f"Home path: {home_abs_path}")
        print(f"Main backup: {main_backup_abs_path}")
        print(f"Incremental base: {incremental_base_path}")
        
        # Determine the relative path
        rel_path = None
        file_abs_path = os.path.abspath(file_path_requested)
        
        # Check if file is in main backup
        if file_abs_path.startswith(main_backup_abs_path):
            rel_path = os.path.relpath(file_abs_path, main_backup_abs_path)
            print(f"File is in main backup, relative path: {rel_path}")
        
        # Check if file is in incremental backup  
        elif file_abs_path.startswith(incremental_base_path):
            # Extract path after date/time
            temp_rel = os.path.relpath(file_abs_path, incremental_base_path)
            parts = temp_rel.split(os.sep)
            if len(parts) >= 3:  # Should be date/time/actual/path
                rel_path = os.path.join(*parts[2:])
                print(f"File is in incremental backup, relative path: {rel_path}")
            else:
                # If it's just date/time without further path, use the filename
                rel_path = parts[-1] if parts else ""
                print(f"File is direct in incremental folder, using: {rel_path}")
        
        # Check if file is in home directory
        elif file_abs_path.startswith(home_abs_path):
            rel_path = os.path.relpath(file_abs_path, home_abs_path)
            print(f"File is in home directory, relative path: {rel_path}")
        
        else:
            # Try to use the path as-is (might already be relative)
            rel_path = file_path_requested
            print(f"Using path as-is: {rel_path}")
        
        if not rel_path:
            return jsonify({'success': False, 'error': 'Could not determine file path'}), 400
        
        # 2. Find all versions
        
        # Current version in home directory
        home_current_file = os.path.join(home_abs_path, rel_path)
        if os.path.exists(home_current_file):
            stat = os.stat(home_current_file)
            versions.append({
                'key': 'home',
                'time': 'Current Version',
                'path': home_current_file,
                'size': stat.st_size,
                'mtime': stat.st_mtime
            })
            print(f"Found home version: {home_current_file}")
        
        # Main backup version
        main_backup_file = os.path.join(main_backup_abs_path, rel_path)
        if os.path.exists(main_backup_file):
            stat = os.stat(main_backup_file)
            versions.append({
                'key': 'main',
                'time': 'Main Backup',
                'path': main_backup_file,
                'size': stat.st_size,
                'mtime': stat.st_mtime
            })
            print(f"Found main backup version: {main_backup_file}")
        
        # Incremental backup versions (only if incremental directory exists)
        if os.path.exists(incremental_base_path):
            for date_folder in os.listdir(incremental_base_path):
                date_path = os.path.join(incremental_base_path, date_folder)
                if not os.path.isdir(date_path):
                    continue
                    
                for time_folder in os.listdir(date_path):
                    time_path = os.path.join(date_path, time_folder)
                    if not os.path.isdir(time_path):
                        continue
                        
                    backup_file = os.path.join(time_path, rel_path)
                    
                    if os.path.exists(backup_file):
                        stat = os.stat(backup_file)
                        versions.append({
                            'key': f"{date_folder}_{time_folder}",
                            'time': f"{date_folder} {time_folder.replace('_', ':')}",
                            'path': backup_file,
                            'size': stat.st_size,
                            'mtime': stat.st_mtime
                        })
                        print(f"Found incremental version: {backup_file}")
        
        # Sort versions by modification time (newest first)
        versions.sort(key=lambda x: x.get('mtime', 0), reverse=True)
        
        # Clean up the response (remove mtime if not needed in frontend)
        for version in versions:
            version.pop('mtime', None)
        
        print(f"Found {len(versions)} total versions")
        print("=== End File Version Lookup ===\n")
        
        return jsonify({'success': True, 'versions': versions}), 200
        
    except Exception as e:
        print(f"Error in get_file_versions: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


# =============================================================================
# SUGGESTED FILES
# =============================================================================
@app.route('/api/suggested-files', methods=['GET'])
def populate_suggested_files():
    """Get suggested files from backup summary data"""
    
    summary_file_path = server.get_summary_file_path()
    added_files: set = set()
    suggestions: list = []
    MAX_SUGGESTIONS: int = 6  # Total suggestions to return
    
    # Check if we can get suggestions from backup summary
    if not (server.has_driver_connection(path=DRIVER_PATH) and os.path.exists(summary_file_path)):
        return jsonify({'success': True, 'suggested_items_to_display': []})
    
    # Helper function to add a suggestion to the list
    def _add_suggestion(item, suggestions, added_files, source_type):
        """Helper to add a file suggestion if not already added"""
        rel_path = item.get("path")
        if not rel_path:
            return
        
        basename = os.path.basename(rel_path)
        if basename in added_files:
            return
        
        # Create paths for thumbnail and original file
        thumbnail_path = os.path.join(APP_MAIN_BACKUP_DIR, rel_path)
        original_path = os.path.join(USERS_HOME, rel_path)
        
        suggestions.append({
            "basename": basename,
            "thumbnail_path": thumbnail_path,
            "original_path": original_path,
            "source": source_type
        })
        added_files.add(basename)

    try:
        # Load summary data
        with open(summary_file_path, 'r') as f:
            summary_data = json.load(f)
        
        # 1. Add recent frequent files (last 5 days)
        recent_files = summary_data.get("most_frequent_recent_backups", [])
        for item in recent_files:
            if len(suggestions) >= MAX_SUGGESTIONS:
                break
            _add_suggestion(item, suggestions, added_files, "freq_recent")
        
        # 2. Add overall frequent files (if we need more)
        overall_files = summary_data.get("most_frequent_backups", [])
        for item in overall_files:
            if len(suggestions) >= MAX_SUGGESTIONS:
                break
            _add_suggestion(item, suggestions, added_files, "freq_overall")
            
    except Exception as e:
        print(f"Error loading backup summary: {e}")
        return jsonify({'success': True, 'suggested_items_to_display': []})
    
    return jsonify({
        'success': True, 
        'suggested_items_to_display': suggestions
    })

def get_original_home_path(backup_file_path: str) -> str:
    """
    Transforms a file path from the main backup folder (.main_backup) 
    to the original user's HOME path.
    """
    
    # 1. Ensure the main backup folder path is absolute and normalized
    main_backup_abs_path = os.path.abspath(APP_MAIN_BACKUP_DIR)
    home_abs_path = os.path.abspath(USERS_HOME)

    # 2. Check if the path starts with the main backup path
    if os.path.abspath(backup_file_path).startswith(main_backup_abs_path):
        # 3. Get the relative path (e.g., 'Documents/concept_art.blend')
        rel_path = os.path.relpath(backup_file_path, main_backup_abs_path)
        
        # 4. Construct the original HOME path (e.g., '/home/geovane/Documents/concept_art.blend')
        return os.path.join(home_abs_path, rel_path)
        
    # If the path is not from the main backup (e.g., an incremental backup), 
    # return it as is.
    return backup_file_path


# =============================================================================
# SEARCH
# =============================================================================
@app.route('/api/refresh-search-index', methods=['POST'])
def refresh_search_index():
    """Refresh the search index and clear the refresh flag"""
    try:
        # Clear the search handler cache to force rescan
        search_handler.clear_cache()
        search_handler.update_backup_location()
        
        # Clear the refresh flag in config
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if config.has_section('SEARCH'):
            config.set('SEARCH', REFRESH_FLAG_CONFIG, 'false')
            with open(CONFIG_PATH, 'w') as configfile:
                config.write(configfile)
        
        # Get the new backup location for logging
        new_backup_path = config.get('DEVICE_INFO', 'path', fallback=DRIVER_PATH)
        
        return jsonify({
            'success': True,
            'message': f'Search index refreshed. New backup location: {new_backup_path}',
            'new_location': new_backup_path
        })
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'Failed to refresh search index: {str(e)}'
        }), 500

def set_search_refresh_flag():
    """Set the flag indicating search database needs refresh"""
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if not config.has_section('SEARCH'):
            config.add_section('SEARCH')
            
        config.set('SEARCH', REFRESH_FLAG_CONFIG, 'true')
        
        with open(CONFIG_PATH, 'w') as configfile:
            config.write(configfile)
            
        print("Search refresh flag set to True")
    except Exception as e:
        print(f"Error setting refresh flag: {e}")

def needs_search_refresh():
    """Check if search database needs refresh"""
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if config.has_section('SEARCH') and config.has_option('SEARCH', REFRESH_FLAG_CONFIG):
            return config.getboolean('SEARCH', REFRESH_FLAG_CONFIG)
        return False
    except Exception as e:
        print(f"Error checking refresh flag: {e}")
        return False
    

# =============================================================================
# DAEMON MANAGER (Singleton Logic)
# =============================================================================
class DaemonManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.pid_file = DAEMON_PID_LOCATION
        self.script_path = DAEMON_PY_LOCATION

    def is_running(self):
        """Check if daemon is actually running using PID file and OS check."""
        if not os.path.exists(self.pid_file):
            return False

        try:
            with open(self.pid_file, 'r') as f:
                pid = int(f.read().strip())
            
            # Check if process exists (Unix specific)
            # os.kill(pid, 0) does not kill the process, just checks existence
            os.kill(pid, 0)
            return True
        except (OSError, ValueError, FileNotFoundError):
            # Process doesn't exist or PID file is corrupt/stale
            return False

    def start(self):
        """Thread-safe start method."""
        with self.lock:
            if self.is_running():
                logging.info("DaemonManager: Daemon is already running.")
                return True

            try:
                # Clean up stale PID file if it exists but process is dead
                if os.path.exists(self.pid_file):
                    os.remove(self.pid_file)

                logging.info(f"DaemonManager: Starting {self.script_path}...")
                
                # start_new_session=True ensures daemon survives if Flask dies
                process = sub.Popen(
                    ['python3', self.script_path],
                    start_new_session=True,
                    stdout=sub.DEVNULL, # Redirect output to avoid buffer filling
                    stderr=sub.DEVNULL
                )

                # Write PID immediately
                with open(self.pid_file, 'w') as f:
                    f.write(str(process.pid))
                
                logging.info(f"DaemonManager: Started with PID {process.pid}")
                return True
            except Exception as e:
                logging.error(f"DaemonManager: Failed to start: {e}")
                return False

    def stop(self):
        """Thread-safe stop method."""
        with self.lock:
            if not self.is_running():
                logging.info("DaemonManager: Daemon is not running.")
                return True

            try:
                with open(self.pid_file, 'r') as f:
                    pid = int(f.read().strip())

                os.kill(pid, signal.SIGTERM)
                logging.info(f"DaemonManager: Sent SIGTERM to PID {pid}")
                
                # Wait a moment for cleanup, then remove PID file
                # (Daemon should remove it, but we ensure it here just in case)
                if os.path.exists(self.pid_file):
                    os.remove(self.pid_file)
                return True
            except Exception as e:
                logging.error(f"DaemonManager: Failed to stop: {e}")
                return False
            

if __name__ == '__main__':
    backup_service = BackupService()

    # log_file_path = server.get_log_file_path()
    # os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
    
    # formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
    # logger = logging.getLogger()
    # logger.setLevel(logging.INFO)
    
    # file_handler = logging.FileHandler(log_file_path)
    # file_handler.setFormatter(formatter)
    # logger.addHandler(file_handler)

    threading.Thread(target=backup_service.start_server, daemon=True).start()

    app.run(debug=True, use_reloader=False)
