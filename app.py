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

HOME_USERNAME: str = os.path.join(os.path.expanduser("~"))
USERNAME: str = getpass.getuser()


################################################################################
# APP SETTINGS
################################################################################
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
DAEMON_PID_LOCATION: str = os.path.join(HOME_USERNAME, '.var', 'app', id, 'config', 'daemon.pid')

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
WATCHED_FOLDERS: str = server.WATCHED_FOLDERS
EXCLUDED_FOLDERS: str = server.EXCLUDED_FOLDERS

# Calculations
bytes_to_human = SERVER.bytes_to_human

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
            destination = self.config['BACKUP'].get('destination', '/backups')
            
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
	
    ##########################################################################
	# Socket reciever
	##########################################################################
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

    ##########################################################################
	# Open file location
	##########################################################################
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


##########################################################################
# APIS
##########################################################################
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
@app.route('/api/config', methods=['GET'])
def get_config():
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    config_dict = {s: dict(config.items(s)) for s in config.sections()}
    return jsonify({**config_dict, 'backup_status': BACKUP_STATUS})

@app.route('/api/storage')
def storage_info():
    return jsonify({
        'configured': get_storage_info(),
        'all_devices': get_all_storage_devices()
    })

@app.route('/api/storage/current')
def current_storage():
    # Get the currently configured device from config
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    driver_path = config.get('DRIVER', 'driver_location', fallback=None)
    
    return jsonify(get_storage_info(driver_path))

@app.route('/api/config', methods=['POST'])
def update_config():
    new_config = request.json
    
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    
    for section, options in new_config.items():
        if not config.has_section(section):
            config.add_section(section)
        for key, value in options.items():
            config.set(section, key, str(value))
    
    with open(CONFIG_PATH, 'w') as configfile:
        config.write(configfile)
    
    return jsonify({'status': 'success'})

@app.route('/api/backup/usage')
def backup_usage():
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # Check if config file has the necessary options
        if not config.has_section('DEVICE_INFO') or not config.has_option('DEVICE_INFO', 'path'):
            return jsonify({
                'success': False,
                'error': 'Please select a backup device first! Go to Devices → Select your storage → Confirm Selection',
                'user_action_required': True,
                'location': 'Not configured'
            })
            
        # Check if backup device was chosen        
        if not DRIVER_PATH or not os.path.exists(DRIVER_PATH):
            return jsonify({
                'success': False,
                'error': f'Your selected device is not available. Please: 1) Connect your device, 2) Go to Devices → Select it again → Confirm',
                'user_action_required': True,
                'location': DRIVER_PATH
            })

        # Get disk usage
        total, used, free = shutil.disk_usage(DRIVER_PATH)
        percent_used = (used / total) * 100 if total > 0 else 0
        
        # Get home disk usage (this seems to be using the same path - you might want to fix this)
        home_total, home_used, home_free = shutil.disk_usage(os.path.expanduser('~'))  # Fixed: use home directory
        home_percent_used = (home_used / home_total) * 100 if home_total > 0 else 0
        
        ##########################################################################
        # Summary and backup summary
        ##########################################################################
        def get_backup_summary() -> dict:
            try:
                summary_file = server.SUMMARY_FILE_PATH
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
            'summary': get_backup_summary(),
            # Add device information from config
            'device_name': DRIVER_NAME,
            'filesystem': DRIVER_FILESYTEM,
            'model': DRIVER_MODEL,
            'serial_number': "DRIVER_SERIAL"  # Add this if available
        })        
    except Exception as e:
        app.logger.error(f"Error in backup_usage: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e),
            'location': 'Error'
        }), 500

@app.route('/api/backup/location')
def backup_location():
    """Docstring for backup_location"""
    # Get disk usage (simplified version)
    try:
        total, used, free = shutil.disk_usage(DRIVER_PATH)
        percent_used = round((used / total) * 100) if total > 0 else 0
        
        return jsonify({
            'location': DRIVER_PATH,
            'total': bytes_to_human(total),
            'used': bytes_to_human(used),
            'free': bytes_to_human(free),
            'percent_used': percent_used
        })
    except Exception as e:
        return jsonify({
            'location': DRIVER_PATH,
            'error': str(e)
        })

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
    
    # 1. Validation Check
    if not device_path:
        return jsonify({'success': False, 'error': 'No device path provided'}), 400
    
    try:
        if not os.path.exists(device_path):
            return jsonify({
                'success': False, 
                'error': f'Path does not exist: {device_path}'
            }), 400
            
        # 2. Load Configuration
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if not config.has_section('DEVICE_INFO'):
            config.add_section('DEVICE_INFO')
            
        # 3. Store ALL necessary fields from the client-provided dictionary
        
        # Mandatory field
        config.set('DEVICE_INFO', 'path', device_path)
        
        # Optional fields, relying on the client to send the full, pre-fetched data
        config.set('DEVICE_INFO', 'name', device_info.get('name', 'N/A'))
        config.set('DEVICE_INFO', 'device', device_info.get('device', 'N/A'))
        config.set('DEVICE_INFO', 'serial_number', device_info.get('serial_number', 'N/A'))
        config.set('DEVICE_INFO', 'model', device_info.get('model', 'N/A'))
        
        # Save the detected disk type
        # NOTE: If 'is_ssd' isn't explicitly sent, the default logic assumes 'hdd'
        is_ssd_value = 'ssd' if device_info.get('is_ssd') else 'hdd'
        config.set('DEVICE_INFO', 'disk_type', is_ssd_value)

        # Optional: Save filesystem and total size for display/checks
        config.set('DEVICE_INFO', 'filesystem', device_info.get('filesystem', 'N/A'))
        config.set('DEVICE_INFO', 'total_size_bytes', str(device_info.get('total', 0)))

        # 4. Write Configuration
        with open(CONFIG_PATH, 'w') as configfile:
            config.write(configfile)
        
        # 5. Reload the global variables
        global DRIVER_NAME, DRIVER_PATH, DRIVER_FILESYTEM, DRIVER_MODEL
        DRIVER_NAME = device_info.get('name', 'N/A')
        DRIVER_PATH = device_path
        DRIVER_FILESYTEM = device_info.get('filesystem', 'N/A')
        DRIVER_MODEL = device_info.get('model', 'N/A')
        
        # 6. Send Success Response
        return jsonify({
            'success': True,
            'message': f'Backup device {device_path} configured successfully.',
            'path': device_path
        })
    
    except Exception as e:
        # A 500 status code is appropriate for a server failure during save.
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

@app.route('/api/config/folders')
def get_folder_config():
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    
    watched = WATCHED_FOLDERS.split(',') if config.has_section('WATCHED') else []  # Get watched folders
    excluded = EXCLUDED_FOLDERS.split(',')  # Get excluded folders
    
    return jsonify({
        'watched': [f.strip() for f in watched if f.strip()],
        'excluded': [f.strip() for f in excluded if f.strip()]
    })


# =============================================================================
# WATCHED FOLDERS
# =============================================================================
def rate_limit(requests_per_minute=10):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            # Use IP address as key
            key = request.remote_addr
            current_time = time()
            
            # Initialize or get existing data
            if key not in _rate_limit_data:
                _rate_limit_data[key] = {'count': 0, 'start_time': current_time}
            
            data = _rate_limit_data[key]
            
            # Reset counter if more than a minute has passed
            if current_time - data['start_time'] > 60:
                data['count'] = 0
                data['start_time'] = current_time
            
            # Check if over limit
            if data['count'] >= requests_per_minute:
                return jsonify({
                    'success': False,
                    'error': f'Rate limit exceeded. Maximum {requests_per_minute} requests per minute.'
                }), 429
            
            # Increment counter
            data['count'] += 1
            
            return f(*args, **kwargs)
        return decorated_function
    return decorator


@app.route('/api/watched-folders')
def get_watched_folders():
    try:
        home_path = os.path.expanduser('~')
        print(f"Home path: {home_path}")
        
        # Check if home directory exists and is accessible
        if not os.path.exists(home_path):
            return jsonify({'error': f'Home directory not found: {home_path}', 'folders': []}), 404
        
        # Get excluded folders safely
        excluded_folders = []
        if hasattr(server, 'EXCLUDE_FOLDER'):
            excluded_folders = server.EXCLUDE_FOLDER.split(',')
            excluded_folders = [f.strip() for f in excluded_folders if f.strip()]
        print(f"Excluded folders: {excluded_folders}")
        
        # Get backup directory safely
        dest_to_main = ""
        if hasattr(server, 'app_main_backup_dir'):
            dest_to_main = server.app_main_backup_dir()
        print(f"Backup directory: {dest_to_main}")
            
        watched_folders = []
        
        for item in os.listdir(home_path):
            item_path = os.path.join(home_path, item)
            
            if not os.path.isdir(item_path) or item.startswith('.'):
                continue
                
            is_excluded = item in excluded_folders or item_path in excluded_folders
            
            watched_folders.append({
                'name': item,
                'path': item_path,
                'status': 'Inactive' if is_excluded else 'Active',
                'last_activity': datetime.now().isoformat(),
                'destination': os.path.join(dest_to_main, item) if dest_to_main else "",
                'is_excluded': is_excluded,
                'excluded_subfolders': [
                    os.path.relpath(sub, item_path) 
                    for sub in excluded_folders 
                    if sub.startswith(item_path)
                ]
            })
            
        watched_folders.sort(key=lambda x: (x['status'] == 'Active', x['name'].lower()))
        
        print(f"Found {len(watched_folders)} folders")
        return jsonify(watched_folders)
        
    except Exception as e:
        logging.error(f"Error in get_watched_folders: {str(e)}")
        import traceback
        traceback.print_exc()  # This will print the full traceback to console
        return jsonify({'error': str(e), 'folders': []}), 500
    

@app.route('/api/folders/handle_folder_include_exclude', methods=['POST'])
def handle_folder_include_exclude():
    data = request.get_json()
    folder_path = data.get('path')
    is_excluded = data.get('is_excluded')
    new_exclude_folders: list = []

    if not folder_path:
        return jsonify({'success': False, 'error': 'No folder path provided'}), 400
    
    try:        
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)  # Load the configuration file
        
        # Check config file existence
        if os.path.exists(CONFIG_PATH):
            # Section existence check
            if not config.has_section('EXCLUDE_FOLDER'):
                config.add_section('EXCLUDE_FOLDER')
        
        # Read all excluded folders from config
        new_exclude_folders = config.get('EXCLUDE_FOLDER', 'folders').split(',')
        # Remove empty strings in case of trailing commas
        new_exclude_folders = [folder.strip() for folder in new_exclude_folders if folder.strip()]
        
        if is_excluded:  # Add folder to exclude list (config file)
            print(f"Add folder to exclude list: {folder_path}")
            if folder_path not in new_exclude_folders:
                new_exclude_folders.append(folder_path)
        else:  # Remove folder from exclude list (config file)
            print(f"Remove folder from exclude list: {folder_path}")
            if folder_path in new_exclude_folders:
                new_exclude_folders.remove(folder_path)

        # Update the config only if there's a change
        if config.get('EXCLUDE_FOLDER', 'folders', fallback='') != ','.join(new_exclude_folders):
            config.set('EXCLUDE_FOLDER', 'folders', ','.join(new_exclude_folders))
            with open(CONFIG_PATH, 'w') as configfile:
                config.write(configfile)
        
        # Clear cache after changes
        global _watched_folders_cache
        _watched_folders_cache = None
        
        return jsonify({
            'success': True,
            'message': f"Folder {'excluded' if is_excluded else 'included'} in backup.",  # Corrected message
            'is_excluded': is_excluded
        })
    except Exception as e:  # Handle any exceptions during the process
        return jsonify({'success': False, 'error': str(e)}), 500
    
@app.route('/api/folders/add-exclusion', methods=['POST'])
def add_folder_exclusion():
    data = request.get_json()
    parent_path = data.get('parent_path')
    exclusion_path = data.get('exclusion_path')

    if not parent_path or not exclusion_path:
        return jsonify({'success': False, 'error': 'Missing parent or exclusion path'}), 400

    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)

        if not config.has_section('EXCLUDE_FOLDER'):
            config.add_section('EXCLUDE_FOLDER')

        # Get the current list of excluded folders
        excluded_folders_str = config.get('EXCLUDE_FOLDER', 'folders', fallback='')
        excluded_folders = [f.strip() for f in excluded_folders_str.split(',') if f.strip()]

        # Ensure the parent path isn't already excluded directly
        if parent_path in excluded_folders:
            return jsonify({
                'success': False, 
                'error': f'The parent folder "{parent_path}" is already excluded. Cannot add sub-exclusions.'
            }), 400

        # Ensure the exclusion path is within the parent folder and doesn't overlap with existing exclusions
        if not exclusion_path.startswith(parent_path):
            return jsonify({
                'success': False, 
                'error': f'The exclusion path "{exclusion_path}" is not within the parent folder "{parent_path}".'
            }), 400

        # Check for overlap: prevent adding an exclusion if a broader one exists
        for existing_exclusion in excluded_folders:
            if exclusion_path.startswith(existing_exclusion) and existing_exclusion != parent_path:
                return jsonify({
                    'success': False,
                    'error': f'Cannot add "{exclusion_path}". It overlaps with existing exclusion "{existing_exclusion}".'
                }), 400

        # Add the new exclusion
        excluded_folders.append(exclusion_path)

        # Update the config
        config.set('EXCLUDE_FOLDER', 'folders', ','.join(excluded_folders))

        with open(CONFIG_PATH, 'w') as configfile:
            config.write(configfile)

        return jsonify({
            'success': True,
            'message': f'Added exclusion: "{exclusion_path}"'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

##############################################################################
# HANDLER FOR DAEMON AND REALTIME CHECKBOX
##############################################################################
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


##############################################################################
# HANDLER SEARCH FOR FILES
##############################################################################
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

##############################################################################
# HANDLER FILES ACTIONS (OPEN, OPEN LOCATION ETC.)
##############################################################################
@app.route('/api/open-location', methods=['POST'])
def open_location():
    try:
        data = request.get_json()
        file_path: str = data.get('file_path')
        print("data:", data)
        if not file_path:
            return jsonify({'success': False, 'error': 'No file_path provided'}), 400

        # Get item dir location
        file_path = '/'.join(file_path.split('/')[:-1])

        print()
        print("Opening folder location:", file_path)
        print()
        if os.name == 'nt':  # Windows
            os.startfile(file_path)
        elif os.uname().sysname == 'Darwin':  # macOS
            sub.run(['open', file_path])
        else:  # Linux/Unix
            sub.run(['xdg-open', file_path]) # or 'gnome-open', 'kde-open'

        return jsonify({'success': True, 'message': f'Attempted to open: {file_path}'}), 200

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
            incremental_backups_abs_path = os.path.abspath(server.app_backup_dir)

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
                    # Return an error response here
                    return jsonify({'success': False, 'error': 'Could not determine relative path for incremental backup'}), 400
            else:
                print(f"Error: File path '{file_path}' is not within known backup locations: '{main_backup_abs_path}' or '{incremental_backups_abs_path}'")
                # Return an error response here
                return jsonify({'success': False, 'error': 'File not within known backup locations'}), 400

            destination_path = os.path.join(HOME_USERNAME, rel_path)

            def do_restore_async(src, dst):
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    total_size = os.path.getsize(src)
                    copied = 0
                    chunk_size = 1024 * 1024  # 1MB

                    with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
                        while True:
                            chunk = fsrc.read(chunk_size)
                            if not chunk: break
                            fdst.write(chunk)
                            copied += len(chunk)
                            # You could send progress updates here via WebSockets/SSE if implemented
                            # For now, just print to console
                            # progress = copied / total_size if total_size > 0 else 1.0
                            # print(f"Restoring {os.path.basename(src)}: {progress*100:.2f}%")

                    print(f"Restored {src} to {dst}")
                    shutil.copystat(src, dst)
                    # No jsonify return here, as this is in a separate thread
                    # If you need frontend feedback, use WebSockets/SSE from here
                except Exception as e:
                    print(f"Error restoring file (async thread): {e}")
                    # Log error, potentially send error update via WebSockets/SSE
            
            # Start the restoration in a background thread
            threading.Thread(target=do_restore_async, args=(file_path, destination_path), daemon=True).start()

            # IMPORTANT: Return an immediate response to the client
            return jsonify({'success': True, 'message': 'File restoration process started in background.'}), 202 # 202 Accepted
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

##############################################################################
# READ CONTENT
##############################################################################
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

@app.route('/api/file-versions', methods=['GET'])
def get_file_versions():
    # 1. The frontend passes the path it knows (which is currently the old main backup path).
    file_path_requested = request.args.get('file_path')
    if not file_path_requested:
        return jsonify({'success': False, 'error': 'Missing file_path'}), 400
    
    # 2. Derive the relative path from the requested path. This relative path is
    #    the key that links all versions together (incremental, main backup, and HOME).
    
    # --- START OF CRITICAL MODIFICATION ---
    # We must determine the relative path regardless of whether the file_path_requested
    # is the HOME path, an incremental backup path, or the main backup path.
    rel_path = None
    
    # Attempt to derive rel_path from the APP_MAIN_BACKUP_DIR structure
    main_backup_abs_path = os.path.abspath(APP_MAIN_BACKUP_DIR)
    if os.path.abspath(file_path_requested).startswith(main_backup_abs_path):
        rel_path = os.path.relpath(file_path_requested, main_backup_abs_path)
    
    # If the relative path could not be determined (e.g., if the user clicks a HOME-based link),
    # we might need more complex logic, but based on your current flow, deriving it
    # from APP_MAIN_BACKUP_DIR is the standard approach. We default to the simple
    # rel_path calculation assuming the input is the main backup path.
    if rel_path is None:
        try:
            # Fallback assuming the input path IS relative to HOME_USERNAME 
            # (which is technically wrong based on your debug but safer)
            rel_path = os.path.relpath(file_path_requested, os.path.abspath(HOME_USERNAME))
        except ValueError:
             # If all else fails, assume the initial file_path_requested already 
             # represents the relative path or is derived from the main backup.
             # This block is where the file tracking (via daemon.py) is truly needed,
             # but for now, we continue with the path derived from the main backup.
             rel_path = os.path.relpath(file_path_requested, APP_MAIN_BACKUP_DIR)
    # --- END OF CRITICAL MODIFICATION ---

    versions = []
    
    # --- 3. Find Incremental Backup Versions ---
    # Search in incremental backup folders using the derived rel_path
    for date_folder in os.listdir(server.app_backup_dir):
        date_path = os.path.join(server.app_backup_dir, date_folder)
        if not os.path.isdir(date_path):
            continue
        for time_folder in os.listdir(date_path):
            time_path = os.path.join(date_path, time_folder)
            backup_file = os.path.join(time_path, rel_path)
            if os.path.exists(backup_file):
                stat = os.stat(backup_file)
                versions.append({
                    'key': f"{date_folder}_{time_folder}",
                    'time': f"{date_folder} {time_folder}",
                    'path': backup_file,
                    'size': stat.st_size,
                })
                
    # --- 4. Add Main Backup Version ---
    main_backup_file = os.path.join(APP_MAIN_BACKUP_DIR, rel_path)
    if os.path.exists(main_backup_file):
        stat = os.stat(main_backup_file)
        # Using the previously defined get_original_home_path here for consistency, 
        # though the 'Home' version below should take precedence if it exists.
        versions.insert(0, {
            'key': 'main',
            'time': 'Main Backup',
            'path': get_original_home_path(main_backup_file), 
            'size': stat.st_size,
        })
        
    # --- 5. Add Current File Version (Home) ---
    # Calculate the current (live) path in the user's home directory
    home_current_file = os.path.join(os.path.abspath(HOME_USERNAME), rel_path)
    
    # Debug print statements (can be removed later)
    print("\n--- File Version Lookup Debug ---")
    print(f"File path requested: {file_path_requested}")
    print(f"Relative path (derived): {rel_path}")
    print(f"Home current file check: {home_current_file}")
    print("--- End Debug ---\n")

    if os.path.exists(home_current_file):
        stat = os.stat(home_current_file)
        # We ensure the most recent version is at the top
        versions.insert(0, {
            'key': 'Home',
            'time': 'Current File Version (Live)',
            'path': home_current_file,
            'size': stat.st_size,
        })

    return jsonify({'success': True, 'versions': versions}), 200


##########################################################################
# SUGGESTED FILES
##########################################################################
@app.route('/api/suggested-files', methods=['GET'])
def populate_suggested_files():
    """Get suggested files from backup summary data"""
    
    summary_file_path = server.SUMMARY_FILE_PATH
    added_files = set()
    suggestions = []
    MAX_SUGGESTIONS = 6  # Total suggestions to return
    
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
        thumbnail_path = os.path.join(server.main_backup_folder(), rel_path)
        original_path = os.path.join(server.USER_HOME, rel_path)
        
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
    home_abs_path = os.path.abspath(HOME_USERNAME)

    # 2. Check if the path starts with the main backup path
    if os.path.abspath(backup_file_path).startswith(main_backup_abs_path):
        # 3. Get the relative path (e.g., 'Documents/concept_art.blend')
        rel_path = os.path.relpath(backup_file_path, main_backup_abs_path)
        
        # 4. Construct the original HOME path (e.g., '/home/geovane/Documents/concept_art.blend')
        return os.path.join(home_abs_path, rel_path)
        
    # If the path is not from the main backup (e.g., an incremental backup), 
    # return it as is.
    return backup_file_path


# @sock.route('/backup-status')
# def backup_status_ws(ws):
#     """WebSocket endpoint for real-time backup status updates"""
#     print("Backup status WebSocket client connected")
    
#     # Send initial status
#     try:
#         ws.send(json.dumps({
#             'type': 'status',
#             'data': BACKUP_STATUS
#         }))
#     except Exception as e:
#         print(f"Error sending initial status: {e}")
    
#     # Keep connection open and handle incoming messages
#     try:
#         while True:
#             message = ws.receive()
#             if message:
#                 # Handle client messages if needed
#                 data = json.loads(message)
#                 if data.get('type') == 'ping':
#                     ws.send(json.dumps({'type': 'pong'}))
#     except Exception as e:
#         print(f"WebSocket connection closed: {e}")


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
