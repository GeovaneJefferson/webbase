# app.py
from flask import Flask, render_template, jsonify, request, send_file  # Add send_file here
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
from threading import Timer
from queue import Queue, Empty
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
from threading import Thread
from static.py.server import *
from storage_util import get_storage_info, get_all_storage_devices

app = Flask(__name__)

################################################################################
# APP SETTINGS
################################################################################
DEV_NAME: str = "Geovane J."
GITHUB_PAGE: str = "https://github.com/GeovaneJefferson/dataguardian"
GITHUB__ISSUES: str = "https://github.com/GeovaneJefferson/dataguardian/issues"
COPYRIGHT: str = "Copyright © 2025 Geovane J.\n\n This application comes with absolutely no warranty. See the GNU General Public License, version 3 or later for details."
ID: str = "io.github.geovanejefferson.dataguardian"
APP_NAME: str = "Data Guardian"
# APP_NAME_CLOSE_LOWER: str = "dataguardian"
APP_NAME_CLOSE_LOWER: str = APP_NAME.lower().replace(" ", "")
APP_VERSION: str = "v0.1 dev"
SUMMARY_FILENAME: str = ".backup_summary.json"
BACKUPS_LOCATION_DIR_NAME: str = "backups"  # Where backups will be saved
APPLICATIONS_LOCATION_DIR_NAME: str = "applications"
APP_RELEASE_NOTES: str = ""
		
# Path to your config file
CONFIG_PATH = 'config/config.conf'
BACKUP_STATUS = {
    'running': False,
    'progress': 0,
    'current_file': '',
    'last_error': None

}

# Configuration
LOG_FILE_PATH: str = os.path.expanduser('~/.dataguardian.log') 
DAEMON_PATH: str = os.path.join(os.path.dirname(__file__), 'daemon.py') # Assuming daemon.py is in the same directory as app.py
MAIN_BACKUP_LOCATION: str = '.main_backup'

# Flatpak
DAEMON_PY_LOCATION: str = os.path.join('/app/share/dataguardian/src', 'daemon.py')
DAEMON_PID_LOCATION: str = os.path.join(os.path.expanduser("~"), '.var', 'app', ID, 'config', 'daemon.pid')

SOCKET_PATH = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), f"{APP_NAME_CLOSE_LOWER}-ui.sock")
# Concurrency settings for copying files
# Default, can be adjusted based on system resources and current load
DEFAULT_COPY_CONCURRENCY = 2

server = SERVER()
message_queue = Queue()

class BackupService:
    def __init__(self, config_path):
        self.config_path = config_path
        self.config = configparser.ConfigParser()
        self.load_config()
        
        self.currently_scanning_top_level_folder_name = None # Track which top-level folder is scanning
        self.transfer_rows = {} # To track active transfers and their Gtk.ListBoxRow widgets
        
        threading.Thread(target=self.start_server, daemon=True).start()  # Start the socket server in a separate thread
    
    def load_config(self):
        self.config.read(self.config_path)
        # Get backup path from DEVICE_INFO instead of DRIVER
        self.backup_path = self.config.get('DEVICE_INFO', 'path', fallback=None)
        
        try:
            BACKUP_STATUS['running'] = True
            BACKUP_STATUS['progress'] = 0
            BACKUP_STATUS['last_error'] = None
            
            source = self.config['DRIVER']['driver_location']
            destination = self.config['BACKUP'].get('destination', '/backups')
            
            # Create destination if it doesn't exist
            Path(destination).mkdir(parents=True, exist_ok=True)
            
            # Use rsync for efficient backups
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
                    # Parse rsync progress output
                    parts = line.split()
                    if len(parts) > 2:
                        BACKUP_STATUS['current_file'] = parts[-1]
                        progress_parts = parts[2].split('/')
                        if len(progress_parts) == 2:
                            BACKUP_STATUS['progress'] = int(
                                (int(progress_parts[0]) / int(progress_parts[1])) * 100
                            )
                
                # You could add more detailed parsing here
                
            process.wait()
            
            if process.returncode != 0:
                BACKUP_STATUS['last_error'] = process.stderr.read()
            
        except Exception as e:
            BACKUP_STATUS['last_error'] = str(e)
        finally:
            BACKUP_STATUS['running'] = False
            BACKUP_STATUS['progress'] = 100 if not BACKUP_STATUS['last_error'] else 0
    
    def pause_backup(self):
        if self.process:
            self.process.terminate()
            BACKUP_STATUS['running'] = False
	
    ##########################################################################
	# Socket reciever
	##########################################################################
    def start_server(self):
        # Make sure the directory for the socket exists
        os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

        # Remove old socket if it exists
        if os.path.exists(SOCKET_PATH):
            os.remove(SOCKET_PATH)

        # Create and bind the socket once
        server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server_socket.bind(SOCKET_PATH)
        server_socket.listen(5)
        logging.info(f"Listening on UNIX socket {SOCKET_PATH}...")

        while True:
            conn, _ = server_socket.accept()
            threading.Thread(target=self.handle_client, args=(conn, message_queue), daemon=True).start()
    
    def handle_client(self, conn):
        with conn:
            while True:
                data = conn.recv(1024)
                if not data:
                    break
                try:
                    msg = json.loads(data.decode("utf-8").strip())
                    file_id = msg.get("id")  # must be unique per file (e.g., hash or relative path)
                    filename = msg.get("filename", "unknown")
                    size = msg.get("size", "0 KB")
                    eta = msg.get("eta", "n/a")
                    progress = msg.get("progress", 0.0)
                    
                    current_state_before_message = self.current_daemon_state
                    msg_type = msg.get("type")

                    if msg_type == "scanning":
                        folder_being_scanned = msg.get("folder") # Can be None
                        if folder_being_scanned:
                            self.current_daemon_state = "scanning"
                        else: # Scanning phase ended for this top-level folder or all
                            if not self.transfer_rows: # Check if any transfers are ongoing
                                if os.path.exists(server.get_interrupted_main_file()):
                                    self.current_daemon_state = "interrupted"
                                else:
                                    self.current_daemon_state = "idle"
                            # If transfers are active, state will become "copying" from transfer messages
                        GLib.idle_add(self.update_scanning_folder_display, folder_being_scanned)
                    elif msg_type == "transfer_progress": # Explicitly handle transfer progress
                        self.current_daemon_state = "copying"
                        GLib.idle_add(self.update_or_create_transfer, file_id, filename, size, eta, progress)
                        # When transfers start, scanning of current top-level folder is done or all scans are done.
                        GLib.idle_add(self.update_scanning_folder_display, None) # Hide scanning card
                    elif msg_type == "summary_updated":
                        GLib.idle_add(self._refresh_left_sidebar_summary_and_usage)
                        GLib.idle_add(self.update_scanning_folder_display, None) # Ensure scanning display is cleared
                        # If no transfers are active, transition to idle or interrupted
                        if not self.transfer_rows:
                            if os.path.exists(server.get_interrupted_main_file()):
                                self.current_daemon_state = "interrupted" #NOSONAR
                            else:
                                self.current_daemon_state = "idle"
                    elif msg_type == "restoring_file":
                        # This message type is no longer handled here for UI-initiated restores
                        pass

                    if current_state_before_message != self.current_daemon_state:
                        GLib.idle_add(self._update_status_icon_display)

                    GLib.idle_add(self._update_left_panel_visibility)
                except Exception as e:
                    print("Socket error:", e)
                    
@app.route('/')
def index():
    return render_template('web.html')

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

@app.route('/api/backup/start', methods=['POST'])
def start_backup():
    if BACKUP_STATUS['running']:
        return jsonify({'error': 'Backup already running'}), 400
        
    backup_service = BackupService(CONFIG_PATH)
    thread = Thread(target=backup_service.perform_backup)
    thread.start()
    
    return jsonify({'status': 'Backup started'})

@app.route('/api/backup/pause', methods=['POST'])
def pause_backup():
    # You'll need to implement actual pausing logic
    # This is a placeholder - you might need to kill the rsync process
    BACKUP_STATUS['running'] = False
    return jsonify({'status': 'Backup paused'})

@app.route('/api/backup/status', methods=['GET'])
def backup_status():
    return jsonify(BACKUP_STATUS)

@app.route('/api/backup/usage')
def backup_usage():
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        if not config.has_section('DEVICE_INFO') or not config.has_option('DEVICE_INFO', 'path'):
            return jsonify({
                'success': False,
                'error': 'Please select a backup device first! Go to Devices → Select your storage → Confirm Selection',
                'user_action_required': True,
                'location': 'Not configured'
            })
            
        location = config.get('DEVICE_INFO', 'path')
        
        if not location or not os.path.exists(location):
            return jsonify({
                'success': False,
                'error': f'Your selected device is not available. Please: 1) Connect your device, 2) Go to Devices → Select it again → Confirm',
                'user_action_required': True,
                'location': location
            })
        
        # Get disk usage
        total, used, free = shutil.disk_usage(location)
        percent_used = (used / total) * 100 if total > 0 else 0
        
        return jsonify({
            'success': True,
            'location': location,
            'percent_used': round(percent_used, 1),
            'human_used': bytes_to_human(used),
            'human_total': bytes_to_human(total),
            'human_free': bytes_to_human(free),
            'users_home_path': os.path.expanduser('~'),
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
    config = configparser.ConfigParser()
    config.read('config/config.conf')
    
    location = config.get('DRIVER', 'driver_location', fallback='Not configured')

    # Get disk usage (simplified version)
    try:
        total, used, free = shutil.disk_usage(location)
        percent_used = round((used / total) * 100) if total > 0 else 0
        
        return jsonify({
            'location': location,
            'total': bytes_to_human(total),
            'used': bytes_to_human(used),
            'free': bytes_to_human(free),
            'percent_used': percent_used
        })
    except Exception as e:
        return jsonify({
            'location': location,
            'error': str(e)
        })

def bytes_to_human(size):
    """Convert bytes to human-readable format"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0:
            break
        size /= 1024.0
    return f"{size:.1f} {unit}"

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

        # Read log file
        with open(LOG_FILE_PATH, 'r') as f:
            log_content = f.read()

        # Optionally parse into structured format
        logs = []
        for line in log_content.split('\n'):
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
                    'raw': line,
                    'error': str(e)
                })

        return jsonify({
            'success': True,
            'logs': logs,
            'raw': log_content,
            'last_modified': os.path.getmtime(LOG_FILE_PATH)
        })

    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/logs/raw', methods=['GET'])
def get_raw_logs():
    """Return the raw log file for download"""
    try:
        return send_file(
            LOG_FILE_PATH,
            mimetype='text/plain',
            as_attachment=True,
            download_name='dataguardian.log'
        )
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
        backup_service = BackupService(CONFIG_PATH)
        return jsonify({
            'success': True,
            'device_path': backup_service.config.get('DRIVER', 'driver_location', fallback=None)
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/backup/select-device', methods=['POST'])
def select_device():
    data = request.get_json()
    device_path = data.get('path')
    # device_info = data.get('device_info', {})
    
    if not device_path:
        return jsonify({'success': False, 'error': 'No device path provided'}), 400
    
    # TODO: Use only 1 method, i am using 2 to get almost the same information 
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
            
        # Only store essential fields
        config.set('DEVICE_INFO', 'path', device_path)
        # config.set('DEVICE_INFO', 'name', device_info.get('name', 'N/A'))

        # Save drive information (Serial, Model, etc.) in to config file
        for device in get_all_storage_devices():
            if 'mount_point' in device:
                if 'device' in device:  # /dev/sda1, /dev/sdb1, etc.
                    config.set('DEVICE_INFO', 'device', device.get('device', 'N/A'))
                elif 'name' in device:
                    config.set('DEVICE_INFO', 'name', device.get('name', 'N/A'))
                elif 'serial_number' in device:
                    config.set('DEVICE_INFO', 'serial_number', device.get('serial_number', 'N/A'))                
                elif 'model' in device:
                    config.set('DEVICE_INFO', 'model', device.get('model', 'N/A'))


        with open(CONFIG_PATH, 'w') as configfile:
            config.write(configfile)
        
        return jsonify({
            'success': True,
            'message': 'Device configured successfully',
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
    
# Get information from the config file
@app.route('/api/backup/check-config')
def check_config():
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    
    has_config = config.has_option('DEVICE_INFO', 'path')
    path = config.get('DEVICE_INFO', 'path', fallback=None)
    
    return jsonify({
        'is_configured': has_config,
        'path': path,
        'device_name': config.get('DEVICE_INFO', 'name', fallback='N/A'),
        'filesystem': config.get('DEVICE_INFO', 'filesystem', fallback='N/A'),
        'model': config.get('DEVICE_INFO', 'model', fallback='N/A'), 
        'model': config.get('DEVICE_INFO', 'model', fallback='N/A'), 
    })

@app.route('/api/config/folders')
def get_folder_config():
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    
    # Get watched folders (you'll need to add this section to your config)
    watched = config.get('WATCHED', 'folders', fallback='').split(',') if config.has_section('WATCHED') else []
    
    # Get excluded folders
    excluded = config.get('EXCLUDE_FOLDER', 'folders', fallback='').split(',')
    
    return jsonify({
        'watched': [f.strip() for f in watched if f.strip()],
        'excluded': [f.strip() for f in excluded if f.strip()]
    })

@app.route('/api/watched-folders')
def get_watched_folders():
    home_path = os.path.expanduser('~')
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    
    # Get all excluded folders from config
    excluded_folders = config.get('EXCLUDE_FOLDER', 'folders', fallback='').split(',')
    excluded_folders = [f.strip() for f in excluded_folders if f.strip()]
    
    watched_folders = []
    try:
        for item in os.listdir(home_path):
            item_path = os.path.join(home_path, item)
            
            # Skip hidden folders and non-directories
            if not os.path.isdir(item_path) or item.startswith('.'):
                continue
                
            # Check if this folder is excluded
            is_excluded = item in excluded_folders or item_path in excluded_folders
            
            watched_folders.append({
                'name': item,
                'path': item_path,
                'status': 'Inactive' if is_excluded else 'Active',
                'last_activity': datetime.now().isoformat(),
                'destination': os.path.join(
                    config.get('DEVICE_INFO', 'path', fallback='/backups'),
                    'dataguardian',
                    'backups',
                    MAIN_BACKUP_LOCATION,
                    item
                ), # Adding "dataguardian/backups/.main_backup" to destination path
                'is_excluded': is_excluded,
                'excluded_subfolders': [
                    os.path.relpath(sub, item_path) 
                    for sub in excluded_folders 
                    if sub.startswith(item_path)
                ]
            })
            
    except Exception as e:
        app.logger.error(f"Error listing home directory: {str(e)}")
        return jsonify({
            'error': str(e),
            'path': home_path
        }), 500
    
    # Sort folders alphabetically with Active ones first
    watched_folders.sort(key=lambda x: (x['status'] == 'Active', x['name'].lower()))
    
    return jsonify(watched_folders)


##############################################################################
# FOLDERS INCLUSION/EXCLUSION
##############################################################################
# INCLUSION/EXCLUSION
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


if __name__ == '__main__':
    app.run(debug=True)