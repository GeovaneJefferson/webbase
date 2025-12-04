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
# import gi
import json
import fnmatch
import hashlib
import stat
import psutil
import fcntl
import mimetypes
# import cairo
import tempfile
import math
import difflib 

from pathlib import Path
from datetime import datetime, timedelta
from threading import Thread, Timer
from queue import Queue, Empty
from time import time

# Assuming these modules exist in your project structure
from static.py.server import *
from static.py.search_handler import SearchHandler
from static.py.storage_util import get_storage_info, get_all_storage_devices
from static.py.daemon_control import send_control_command
from static.py.necessaries_actions import base_folders_creation

# from static.py.daemon import main as daemon_main

# Flask libraries
from flask import Flask, render_template, jsonify, request, send_file
from flask_sock import Sock

# Create app
app = Flask(__name__)
sock = Sock(app)
server = SERVER()
search_handler = SearchHandler()

# =============================================================================######
# APP SETTINGS
# =============================================================================######
# Path to your config file
app_dir = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(app_dir, 'config', 'config.conf')

# Calculations
bytes_to_human = SERVER.bytes_to_human

USERS_HOME: str = os.path.expanduser("~")
USERNAME: str = getpass.getuser()

# Socket 
SOCKET_PATH = server.SOCKET_PATH
ws_clients = []  # Track WebSocket clients

# --- Icon Mapping (Define this outside the function, e.g., at the top of app.py) ---
FOLDER_ICONS = {
    # Common system directories (keys are lowercase for reliable matching)
    'documents': {'icon': 'bi-file-earmark-text-fill', 'color': 'text-blue-500'},
    'downloads': {'icon': 'bi-arrow-down-circle-fill', 'color': 'text-teal-500'},
    'pictures': {'icon': 'bi-image-fill', 'color': 'text-pink-500'},
    'photos': {'icon': 'bi-image-fill', 'color': 'text-pink-500'},
    'videos': {'icon': 'bi-camera-video-fill', 'color': 'text-red-500'},
    'video': {'icon': 'bi-camera-video-fill', 'color': 'text-red-500'},
    'music': {'icon': 'bi-music-note-beamed', 'color': 'text-purple-500'},
    'desktop': {'icon': 'bi-display-fill', 'color': 'text-emerald-500'},
    'public': {'icon': 'bi-share-fill', 'color': 'text-yellow-500'},
    'templates': {'icon': 'bi-code-square', 'color': 'text-orange-500'},
    'code': {'icon': 'bi-code-slash', 'color': 'text-cyan-500'},
    'games': {'icon': 'bi bi-joystick', 'color': 'text-cyan-500'},
    'mega': {'icon': 'bi bi-cloudy-fill', 'color': 'text-cyan-500'},
    'dropbox': {'icon': 'bi bi-cloudy-fill', 'color': 'text-cyan-500'},
    
}

# PATHS
# DRIVER_NAME =
# DRIVER_PATH =
# DRIVER_FILESYTEM =
# DRIVER_MODEL =
# APP_MAIN_BACKUP_DIR =
# APP_BACKUP_DIR =

# =============================================================================######
# APP SETTINGS
# =============================================================================######
# Path to your config file
app_dir = os.path.dirname(os.path.abspath(__file__))


class BackupService:
    """
    Placeholder class for the application's core backup/daemon service.
    This is necessary to resolve the NameError in the __main__ block.
    The start_server method is the entry point for the background thread.
    """
    def __init__(self):
        logging.info("BackupService initialized.")

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

    def clear_cache(self):
        """Clear the file cache (useful when backup files change)"""
        self._files_cache = None
        self._cache_time = 0
        self.files_loaded = False

    def update_backup_location(self):
        """Clear cache to force rescan of new location"""
        print(f"SearchHandler: Clearing cache for new backup location: {self.main_files_dir}")
        self.clear_cache()


# =============================================================================######
# DEVICE AND SYSTEM ROUTES
# =============================================================================######
def get_system_devices():
    """
    Gathers local storage device information (mount points) for the Devices tab.
    It simulates the data structure expected by the frontend's renderDevices function.
    
    Returns:
        list: A list of device dictionaries.
    """
    devices = []
    # Get information about disk partitions (storage devices)
    partitions = psutil.disk_partitions(all=False)
    
    for i, partition in enumerate(partitions):
        try:
            usage = psutil.disk_usage(partition.mountpoint)
            
            # Calculate used space in GB for display
            used_gb = usage.used / (1024 ** 3)
            total_gb = usage.total / (1024 ** 3)
            percent_used = usage.percent
            
            # Determine status based on usage
            status = 'Healthy'
            color = 'text-green-500'
            if percent_used > 90:
                status = 'Critical'
                color = 'text-red-500'
            elif percent_used > 75:
                status = 'Warning'
                color = 'text-yellow-500'

            devices.append({
                'id': i + 1,
                'name': f"{os.path.basename(partition.mountpoint) or 'Root'}",
                'mountpoint': partition.mountpoint,
                'status': status,
                'color': color,
                'progress': percent_used,
                'used_space': f"{used_gb:.2f} GB",
                'total_space': f"{total_gb:.2f} GB",
                'last_backup': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'backup_count': random.randint(10, 50),
                'icon': 'bi-hdd-fill' if partition.mountpoint == '/' else ('bi-usb-drive-fill' if partition.opts.startswith('rw') else 'bi-disc-fill')
            })
        except Exception as e:
            # Handle cases where disk usage info is inaccessible (e.g., /proc, /sys)
            print(f"Error reading partition {partition.mountpoint}: {e}")
            continue

    return devices


# =============================================================================
# USER
# =============================================================================
@app.route('/api/username')
def get_username():
    # Replace with your actual username retrieval logic
    username = os.path.basename(os.path.expanduser("~"))
    return jsonify({'username': username})


# =============================================================================
# FIRST ACTIONS
# =============================================================================
@app.route('/api/base-folders-creation')
def create_necessaries_folders():
    try:
        # base_folders_creation() will now raise exceptions on failure
        if base_folders_creation():
            return jsonify({'success': True, 'message': 'Created necessaries folders!'})
        
        # If the function returns False (e.g., due to an internal check), handle it here.
        # However, for I/O errors, it should be raising an exception now.
        return jsonify({'success': False, 'message': 'Folder creation failed due to internal check.'})
        
    except Exception as e:
        # The specific error is caught here and returned as 'error_detail'
        return jsonify({
            'success': False,
            'message': 'Error creating necessary folders: Operation failed.',
            'error': str(e) # This is the "more info" you requested
        })


# =============================================================================
# CONFIG FILE
# =============================================================================
@app.route('/api/config')
def get_config_data():
    """
    Reads the entire config.conf file using configparser and returns its contents 
    as a structured JSON object for the frontend to use for path comparison.
    """
    config = configparser.ConfigParser()
    try:
        # CONFIG_PATH is defined globally at the top of your app.py
        config.read(CONFIG_PATH)

        # Convert the configparser object to a serializable dictionary
        config_dict = {}
        for section in config.sections():
            # dict(config.items(section)) extracts all key/value pairs from the section
            config_dict[section] = dict(config.items(section))
        
        # Optionally include the DEFAULT section if you use it
        if config.defaults():
            config_dict['DEFAULT'] = config.defaults()

        return jsonify(config_dict)

    except Exception as e:
        # Handle cases where the config file might be missing or corrupt
        return jsonify({
            'success': False,
            'error': f'Failed to read configuration file: {str(e)}'
        }), 500
    

@app.route('/api/backup-folders', methods=['GET'])
def get_backup_folders():
    """List ALL home folders and check if they are in config."""
    try:
        home_path = os.path.expanduser('~')
        
        # 1. Get currently saved folders from config to mark checkboxes
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        saved_folders = []
        if config.has_section('BACKUP_FOLDERS') and config.has_option('BACKUP_FOLDERS', 'folders'):
            raw = config.get('BACKUP_FOLDERS', 'folders')
            saved_folders = [os.path.normpath(f.strip()) for f in raw.split(',') if f.strip()]

        folders_data = []
        
        def get_icon_for_folder(name: str):
            """Returns specific icon/color or a default."""
            return FOLDER_ICONS.get(
                name.lower(), 
                {'icon': 'bi-folder-fill', 'color': 'text-brand-500'} # Default icon
            )
        
        # 2. LIST ALL FOLDERS in Home Directory
        if os.path.exists(home_path):
            for item in os.listdir(home_path):
                full_path = os.path.join(home_path, item)
                # Check for directory and ignore hidden (dot) folders
                if os.path.isdir(full_path) and not item.startswith('.'):
                    
                    # Check if this folder is currently saved in config
                    is_selected = os.path.normpath(full_path) in saved_folders
                    
                    # Get specific icon based on folder name
                    icon_data = get_icon_for_folder(item)
                    
                    folders_data.append({
                        'name': item,
                        'path': full_path,
                        'selected': is_selected,
                        'icon': icon_data['icon'],      
                        'color': icon_data['color']     
                    })
        
        # Sort alphabetically
        folders_data.sort(key=lambda x: x['name'].lower())
        
        return jsonify({'success': True, 'folders': folders_data})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/backup-folders', methods=['POST'])
def save_backup_folders():
    """Save the user's selection to the config file."""
    try:
        data = request.get_json()
        selected_folders = data.get('folders', [])
        
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # Join list into string and save
        config.set('BACKUP_FOLDERS', 'folders', ','.join(selected_folders))
        
        with open(CONFIG_PATH, 'w') as f:
            config.write(f)
            
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    

# =============================================================================
# USAGE
# =============================================================================
@app.route('/api/backup/connection')  # Use tooltip if device is connected
def backup_connection():
    DRIVER_PATH = server.get_database_value('DEVICE_INFO', 'path')

    if DRIVER_PATH:  # Check if user registered a device
        if os.path.exists(DRIVER_PATH):  # Check if path exists (Acessible)
            return jsonify({
                'success': True,
                'connected': True,
                'location': DRIVER_PATH
            })
        else:
            return jsonify({
                'success': True,
                'connected': False,
                'location': DRIVER_PATH
            })
    else:
        return jsonify({
            'success': False,
            'connected': False,
            'location': 'Not configured'
        })

@app.route('/api/backup/usage')
def backup_usage():
    try:
        config = configparser.ConfigParser()
        config.read(CONFIG_PATH)
        
        # 1. Ensure the necessary config information are registered
        necessary_config_sections = config.has_section('DEVICE_INFO')
        necessary_config_options = config.has_option('DEVICE_INFO', 'path')
        DRIVER_PATH = server.get_database_value('DEVICE_INFO', 'path')
        
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
            'device_name': server.DRIVER_NAME,
            'filesystem': server.DRIVER_FILESYTEM,
            'model': server.DRIVER_MODEL,
            'serial_number': "DRIVER_SERIAL"
        })        
    except Exception as e:
        app.logger.error(f"Error in backup_usage: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e),
            'location': 'Error'
        }), 500


# =============================================================================
# DEVICES
# =============================================================================
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
        
        # Ensure all values are strings before setting them
        config.set('DEVICE_INFO', 'path', str(device_path))
        config.set('DEVICE_INFO', 'name', str(device_info.get('name', 'N/A')))
        config.set('DEVICE_INFO', 'device', str(device_info.get('device', 'N/A')))
        config.set('DEVICE_INFO', 'serial_number', str(device_info.get('serial_number', 'N/A')))
        config.set('DEVICE_INFO', 'model', str(device_info.get('model', 'N/A')))
        
        # Handle boolean conversion for is_ssd
        is_ssd = device_info.get('is_ssd', False)
        is_ssd_value = 'ssd' if is_ssd else 'hdd'
        config.set('DEVICE_INFO', 'disk_type', is_ssd_value)
        config.set('DEVICE_INFO', 'filesystem', str(device_info.get('filesystem', 'N/A')))
        
        # Convert total_size_bytes to string
        total_size = device_info.get('total', 0)
        config.set('DEVICE_INFO', 'total_size_bytes', str(int(total_size)))  # Ensure it's an integer then string

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

# =============================================================================
# WEBSOCKET FOR LIVE TRANSFERS FEED
# =============================================================================
@sock.route('/ws/transfers-feed')
def transfers_feed_websocket(ws):
    """
    WebSocket endpoint for live transfers feed updates from the daemon.
    Clients connect here to receive real-time backup status updates.
    """
    # print(f"[WebSocket] New client connected. Total clients: {len(ws_clients) + 1}")
    ws_clients.append(ws)
    
    try:
        while True:
            try:
                # Keep connection open and receive client messages (if any)
                data = ws.receive(timeout=None)
                if data is None:
                    break
                # Optionally handle incoming messages from client
                # print(f"[WebSocket] Received from client: {data}")
            except Exception as e:
                if "timeout" not in str(e).lower():
                    print(f"[WebSocket] Receive error: {e}")
                break
    except Exception as e:
        print(f"[WebSocket] Connection error: {e}")
    finally:
        try:
            ws_clients.remove(ws)
            print(f"[WebSocket] Client disconnected. Remaining clients: {len(ws_clients)}")
        except ValueError:
            pass


# =============================================================================
# SEARCH HANDLER WITH CACHING
# =============================================================================
@app.route('/api/search/status', methods=['GET'])
def search_status():
    """
    Check the status of file caching and scanning.
    Useful for the frontend to know when to enable search.
    """
    try:
        return jsonify({
            'success': True,
            'files_loaded': search_handler.files_loaded,
            'file_count': len(search_handler.files),
            'cache_valid': search_handler._files_cache is not None
        })
    except Exception as e:
        app.logger.error(f"Error getting search status: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/search/init', methods=['POST'])
def init_search():
    """
    Trigger initial file scanning in background if not already done.
    Frontend can call this to ensure files are cached before searching.
    """
    try:
        if not search_handler.files_loaded:
            search_handler.scan_files_folder_threaded()
            return jsonify({
                'success': True,
                'message': 'File scanning started in background',
                'scanning': True
            })
        else:
            return jsonify({
                'success': True,
                'message': 'Files already loaded',
                'scanning': False,
                'file_count': len(search_handler.files)
            })
    except Exception as e:
        app.logger.error(f"Error initializing search: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/search', methods=['GET'])
def search_files():
    """
    Search endpoint with robust error handling and caching support.
    Uses search_handler's perform_search method which includes:
    - File caching with 5-minute TTL
    - Background file scanning
    - Efficient fuzzy/substring matching
    """
    query = request.args.get('query', '').strip().lower()
    print(f"Search query received: '{query}'")
    
    # Return empty results for empty query
    if not query:
        return jsonify({'files': [], 'total': 0})
    
    try:
        # Use the search handler's perform_search which handles:
        # - Cached file lookups
        # - Background scanning if cache expired
        # - Proper error handling and state management
        search_results = search_handler.perform_search(query)
        
        return jsonify({
            'files': search_results,           # Return the actual search results
            'total': len(search_handler.files) # Return total number of files in cache
        })
    except AttributeError as e:
        app.logger.error(f"Search handler attribute error: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': 'Search handler not properly initialized. Please refresh the page.',
            'files': []
        }), 500
    except Exception as e:
        app.logger.error(f"Error during file search: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': 'An error occurred during search.',
            'files': []
        }), 500


@app.route('/api/search/folder', methods=['GET'])
def get_folder_contents():
    """
    Get folder contents (files and directories) from the backup directory.
    Returns the main folder contents by default, or subdirectory contents if path is specified.
    """
    path = request.args.get('path', '').strip()
    main_backup_dirname = server.MAIN_BACKUP_LOCATION
    
    try:
        # Get the main backup directory from server
        backup_dir = server.app_main_backup_dir()
        
        if not os.path.isdir(backup_dir):
            return jsonify({
                'success': False,
                'error': f'Backup directory not found: {backup_dir}',
                'items': []
            }), 404
        
        # If path specified, append it to backup_dir
        if path and path != '' and path != main_backup_dirname:
            full_path = os.path.join(backup_dir, path.lstrip('/'))
        else:
            full_path = backup_dir
        
        # Verify the path is within backup_dir (security check)
        real_path = os.path.realpath(full_path)
        real_backup = os.path.realpath(backup_dir)
        if not real_path.startswith(real_backup):
            return jsonify({
                'success': False,
                'error': 'Invalid path',
                'items': []
            }), 403
        
        if not os.path.isdir(real_path):
            return jsonify({
                'success': False,
                'error': f'Directory not found: {path}',
                'items': []
            }), 404
        
        # Scan the directory
        items = []
        try:
            for entry in os.scandir(real_path):
                item = {
                    'name': entry.name,
                    'type': 'folder' if entry.is_dir(follow_symlinks=False) else 'file',
                    'path': entry.path
                }
                
                # Add file-specific attributes
                if item['type'] == 'file':
                    item['icon'] = 'bi-file-earmark-fill'
                    item['color'] = 'text-gray-500'
                
                items.append(item)
        except PermissionError:
            return jsonify({
                'success': False,
                'error': 'Permission denied accessing directory',
                'items': []
            }), 403
        
        return jsonify({
            'success': True,
            'items': items,
            'path': path or '/'
        })
    
    except Exception as e:
        app.logger.error(f"Error getting folder contents: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e),
            'items': []
        }), 500

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
    
@app.route('/api/open-location', methods=['POST'])
def open_location():
    try:
        data = request.get_json()
        file_path = data.get('file_path')
        file_path = os.path.dirname(file_path)
        
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

@app.route('/api/restore-file', methods=['POST'])
def restore_file():
    try:
        data = request.get_json()
        file_path = data.get('file_path')
        app_main_backup_dir = server.app_main_backup_dir()
        app_backup_dir = server.app_backup_dir()

        if not file_path:
            return jsonify({'success': False, 'error': 'No file_path provided'}), 400

        # Your existing restoration logic...
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
            main_backup_abs_path = os.path.abspath(app_main_backup_dir)
            incremental_backups_abs_path = os.path.abspath(app_backup_dir)

            rel_path = None
            if abs_file_to_restore_path.startswith(main_backup_abs_path):
                rel_path = os.path.relpath(abs_file_to_restore_path, main_backup_abs_path)
            elif abs_file_to_restore_path.startswith(incremental_backups_abs_path):
                temp_rel_path = os.path.relpath(abs_file_to_restore_path, incremental_backups_abs_path)
                parts = temp_rel_path.split(os.sep)
                if len(parts) > 2:
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
                    
                    # TODO: Create a notification "Restoring file"
                    # Use send_restoring_file from server.py file.

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
                    
                    # TODO: Create a notification "Restoration completed"
                    
                except Exception as e:
                    print(f"❌ Error restoring file (async thread): {e}")
            
            # Start the restoration in a background thread
            threading.Thread(target=do_restore_async, args=(file_path, destination_path), daemon=True).start()

            return jsonify({
                'success': True, 
                'message': 'File restoration process started in background.',
                'restored_to': destination_path  # This is now defined
            }), 202

    except Exception as e:
        print(f"Error in restore_file endpoint: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


# ===========================================================================
# FILE VERSIONS ENDPOINT
# ===========================================================================
@app.route('/api/file-versions', methods=['GET'])
def get_file_versions():
    file_path_requested = request.args.get('file_path')
    if not file_path_requested:
        return jsonify({'success': False, 'error': 'Missing file_path'}), 400

    versions: list = []
    try:
        # Debug logging
        app.logger.debug(f"File versions lookup requested for: {file_path_requested}")

        # Resolve absolute base paths
        home_abs_path = os.path.abspath(USERS_HOME)
        main_backup_abs_path = os.path.abspath(server.app_main_backup_dir())
        incremental_base_path = os.path.abspath(server.app_backup_dir())

        # Determine relative path within backups or home
        rel_path = None
        file_abs_path = os.path.abspath(file_path_requested)

        if file_abs_path.startswith(main_backup_abs_path):
            rel_path = os.path.relpath(file_abs_path, main_backup_abs_path)
        elif file_abs_path.startswith(incremental_base_path):
            temp_rel = os.path.relpath(file_abs_path, incremental_base_path)
            parts = temp_rel.split(os.sep)
            if len(parts) >= 3:
                rel_path = os.path.join(*parts[2:])
            else:
                rel_path = parts[-1] if parts else ""
        elif file_abs_path.startswith(home_abs_path):
            rel_path = os.path.relpath(file_abs_path, home_abs_path)
        else:
            rel_path = file_path_requested

        if not rel_path:
            return jsonify({'success': False, 'error': 'Could not determine file path'}), 400

        # REMOVE the home current file from versions - we'll handle it separately in the frontend
        # The "Current File (Latest)" section should show the file from the user's home directory
        
        # 1) Main backup version
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

        # 2) Incremental backups (scan date/time folders)
        if os.path.exists(incremental_base_path):
            for date_folder in sorted(os.listdir(incremental_base_path), reverse=True):
                date_path = os.path.join(incremental_base_path, date_folder)
                if not os.path.isdir(date_path):
                    continue
                for time_folder in sorted(os.listdir(date_path), reverse=True):
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

        # Sort newest first and strip mtime for client
        versions.sort(key=lambda x: x.get('mtime', 0), reverse=True)
        for v in versions:
            v.pop('mtime', None)

        return jsonify({'success': True, 'versions': versions}), 200

    except Exception as e:
        app.logger.error(f"Error in get_file_versions: {e}", exc_info=True)
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/file-info', methods=['POST'])
def file_info():
    data = request.json
    backup_path = data.get('file_path', '')
    
    # Convert backup path to home path
    home_path = convert_backup_to_home_path(backup_path)
    
    # Get file size
    size = 0
    if os.path.exists(backup_path):
        size = os.path.getsize(backup_path)
    elif os.path.exists(home_path):
        size = os.path.getsize(home_path)
    
    return jsonify({
        'success': True,
        'size': size,
        'home_path': home_path,  # Send the converted home path back
        'exists': os.path.exists(home_path),
        'backup_path': backup_path
    })

def convert_backup_to_home_path(backup_path):
    """Convert .main_backup path to home directory path"""
    if not backup_path:
        return ''
    
    # Remove everything up to and including .main_backup/
    if '.main_backup' in backup_path:
        # Split and get everything after .main_backup
        parts = backup_path.split('.main_backup')
        if len(parts) > 1:
            relative_path = parts[1].lstrip('/').lstrip('\\')
            # Join with user's home directory
            home_dir = os.path.expanduser("~")
            return os.path.join(home_dir, relative_path)
    
    return backup_path  # Return as-is if no .main_backup found


# ===========================================================================
# MIGRATION SOURCES
# ===========================================================================
@app.route('/api/migration/sources', methods=['GET'])
def get_migration_sources():
    """
    Scans all storage devices and returns only those that contain a valid
    Time Machine backup directory.
    """
    try:
        all_devices = get_all_storage_devices()
        valid_sources = []

        for device in all_devices:
            mount_point = device.get('mount_point')
            if not mount_point:
                continue

            # Define the expected backup path structure
            main_backup_path = os.path.join(mount_point, 'timemachine', 'backups', '.main_backup')

            # Check if the main backup directory exists, is a directory, and is not empty
            if os.path.isdir(main_backup_path) and os.listdir(main_backup_path):
                # This device is a valid backup source
                device['has_backup'] = True
                # You could add logic here to find the last backup date if needed
                device['last_backup_date'] = "Recent" 
                valid_sources.append(device)

        return jsonify({
            'success': True,
            'sources': valid_sources
        })

    except Exception as e:
        app.logger.error(f"Error scanning for migration sources: {e}", exc_info=True)
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================######
# DAEMON CONTROL ROUTES
# =============================================================================######

# Status check (for UI indicator)
@app.route('/api/daemon/status', methods=['GET'])
def get_daemon_status():
    return jsonify(server.get_daemon_status()) 

# [RUN DAEMON] - Process Start
@app.route('/api/daemon/start', methods=['POST'])
def start_daemon_process():
    result = server.start_daemon() or {'success': False, 'error': 'No response from daemon'}
    return jsonify(result), 200 if result.get('success') else 500
    
# [AUTO STARTUP] - Config/System Toggle
@app.route('/api/daemon/autostart', methods=['POST'])
def set_autostart():
    data = request.get_json() or {}
    enable = data.get('enable', False)
    result = server.set_autostart(enable)
    return jsonify(result), (200 if result.get('success') else 500)

# [STOP BACKUP] - Task Control (Uses your existing daemon_control.py)
@app.post('/api/backup/cancel')
def cancel_backup_task():
    data = request.get_json(silent=True) or {}
    mode = data.get('mode', 'graceful')
    ok = send_control_command('cancel', mode)
    return jsonify({'result': 'ok' if ok else 'error', 'mode': mode}), (200 if ok else 500)


# =============================================================================######
# CORE APPLICATION ROUTES 
# =============================================================================######
@app.route('/')
def main_index():
    """
    The main route rendering the base index.html template.
    """
    return render_template('index.html')


if __name__ == '__main__':
    backup_service = BackupService()

    # # --- CRITICAL: Daemon-Only Mode Check for Autostart ---
    # if '--daemon-only' in sys.argv:
    #     try:
    #         # 1. Write PID file using the persistent path from SERVER
    #         pid = os.getpid()
    #         os.makedirs(server.DAEMON_PID_LOCATION.parent, exist_ok=True)
    #         with open(server.DAEMON_PID_LOCATION, 'w') as f:
    #             f.write(str(pid))
            
    #         # 2. Run the core daemon logic
    #         asyncio.run(daemon_main())
            
    #     except Exception as e:
    #         logging.error(f"Daemon-only failed: {e}")
    #     finally:
    #         # 3. Clean up PID file on exit
    #         server.DAEMON_PID_LOCATION.unlink(missing_ok=True)
    #         sys.exit(0)

    #     # This is the path taken by Autostart or the manual 'start' button.
    #     try:
    #         # 1. Write PID file (uses the persistent path from server/server)
    #         pid = os.getpid()
    #         pid_path = server.DAEMON_PID_LOCATION 
    #         os.makedirs(pid_path.parent, exist_ok=True)
    #         with open(pid_path, 'w') as f:
    #             f.write(str(pid))
            
    #         # 2. Run the core daemon logic until a signal is received
    #         asyncio.run(daemon_main()) 
            
    #     except Exception as e:
    #         # Log failure
    #         logging.error(f"Daemon-only failed: {e}")
    #     finally:
    #         # 3. Clean up PID file on exit
    #         server.DAEMON_PID_LOCATION.unlink(missing_ok=True)
    #         sys.exit(0)
    
    threading.Thread(target=backup_service.start_server, daemon=True).start()
    # app.run(debug=False, use_reloader=False)
    from werkzeug.serving import run_simple
    run_simple('127.0.0.1', 5000, app, use_reloader=False, use_debugger=False, threaded=True)