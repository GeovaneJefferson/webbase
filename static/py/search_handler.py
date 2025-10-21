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
from concurrent.futures import ProcessPoolExecutor
from static.py.server import *

server = SERVER()

# Constants
HOME_USERNAME: str = os.path.join(os.path.expanduser("~"))
USERNAME: str = getpass.getuser()

MEDIA = '/media'
RUN = '/run'
USERNAME = os.getenv('USER', 'user')  # Default to 'user' if USER env var is not set
LOG = logging.getLogger(__name__)


class SeachHandler:
    def __init__(self):
        ##########################################################################
		# VARIABLES
		##########################################################################
        self.selected_file_path: bool = None
        self.MAIN_BACKUP_FOLDER: str = f"/media/{USERNAME}/{server.BACKUP_FOLDERS_NAME}/{server.APP_NAME_CLOSE_LOWER}/{server.BACKUPS_LOCATION_DIR_NAME}/{server.MAIN_BACKUP_LOCATION}"
        self.documents_path: str = os.path.expanduser(self.MAIN_BACKUP_FOLDER)
        self.location_buttons: list = []
        # For search
        self.files: list = [] # Holds dicts of scanned files from .main_backup
        self.file_names_lower: list = [] # Lowercase basenames for searching
        self.file_search_display_paths_lower: list = [] # Lowercase relative paths for searching
        self.last_query: str = ""
        self.files_loaded: bool = False # Flag indicating if initial scan is complete
        self.pending_search_query: str = None # Stores search query if files aren't loaded yet
        self.scan_files_folder_threaded()
        self.thumbnail_cache = {} # For in-memory thumbnail caching
        self.ignored_folders = []
        self.page_size = 17  # Number of results per page
        self.current_page = 0  # Start from the first page
        self.search_results = []  # Store results based on filtering/searching
        self.date_combo = None  # To reference date combo in filtering
        self.search_timer = None  # Initialize in the class constructor
        self.folder_status_widgets = {} # To store icon widgets for top-level folders
        self.currently_scanning_top_level_folder_name = None # Track which top-level folder is scanning
        self.transfer_rows = {} # To track active transfers and their Gtk.ListBoxRow widgets
        self.search_spinner = None # Initialize search spinner
        self.starred_files_flowbox = None # For the "Starred Items" section
        self.starred_files = [] # Use a list to maintain order for starred files

    def perform_search(self, query):
        """Perform the search and update the results."""
        try:
            query = query.strip().lower()
            if not query:
                return

            def search_backup_sources(query):
                # With index
                matches = []
                for idx, name in enumerate(self.file_names_lower):
                    # Check against basename or the searchable display path
                    if query in name or query in self.file_search_display_paths_lower[idx]:
                        matches.append(self.files[idx])
                #matches.sort(key=lambda x: x["date"], reverse=True)
                return matches[:self.page_size]

            results = search_backup_sources(query)
        except AttributeError as e:
            # This is a fallback. Ideally, the `if not self.files_loaded` check prevents this.
            # If this happens, it indicates a deeper issue with state management during file loading.
            print(f"Critical Search Error (AttributeError): {e}. File attributes might be missing.")
            print("Attempting to re-initialize file scan and deferring search.")
            self.files_loaded = False  # Mark as not loaded to ensure re-check/re-scan
            self.pending_search_query = query # Re-queue the current search
            self.scan_files_folder_threaded() # Re-trigger the scan
            results = []
        except Exception as e:
            print(f"Error during search: {e}")
            results = []

        # Return results
        print(f"Search completed. Found {len(results)} results for query: '{query}'")
        return results
    
    ##########################################################################
    # SOCKET
    ##########################################################################
    def _send_message_to_frontend(self, message_type, data=None):
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(server.SOCKET_PATH)
            sock.sendall(message_type.encode("utf-8"))
            sock.close()
        except socket.timeout:
            logging.warning(f"self._send_message_to_frontend: Socket operation timed out for {server.SOCKET_PATH}.")
        except FileNotFoundError:
            logging.debug(f"self._send_message_to_frontend: Socket file not found at {server.SOCKET_PATH}. UI likely not running or socket not created yet.")
        except ConnectionRefusedError:
            # This is common if UI is not running, can be debug level if too noisy
            logging.debug(f"self._send_message_to_frontend: Connection refused at {server.SOCKET_PATH}. UI likely not running or not listening.")
        except Exception as e:
            # Log other unexpected errors during UI communication
            logging.warning(f"self._send_message_to_frontend: Error communicating with UI via {server.SOCKET_PATH}: {e}")

    ##########################################################################
    # SEARCH ENTRY
    ##########################################################################
    def scan_files_folder_threaded(self):
        def scan_files_folder():
            print("Searching in:", self.documents_path)
            """Scan files and return a list of file dictionaries."""
            if not os.path.exists(self.documents_path):
                print(f"Documents path for scanning does not exist: {self.documents_path}")
                return []
            
            print("Caching files, Please Wait...")

            file_list = []
            # base_for_rel_path is the folder *containing* .main_backup, i.e., server.backup_folder_name()
            base_for_search_display_path = os.path.dirname(self.documents_path) 

            for root, dirs, files in os.walk(self.documents_path):
                # Optionally, add logic here to exclude hidden directories or specific directories
                # dirs[:] = [d for d in dirs if not d.startswith('.')] # Example: exclude hidden dirs
                for file_name in files:
                    # Optionally, add logic here to exclude hidden files
                    # if file_name.startswith('.'): continue # Example: exclude hidden files
                    file_path = os.path.join(root, file_name)
                    file_date = os.path.getmtime(file_path)
                    search_display_path = os.path.relpath(file_path, base_for_search_display_path)
                    file_list.append({"name": file_name, "path": file_path, "date": file_date, "search_display_path": search_display_path})
            return file_list

        def scan():
            try:
                # --- Send signal to socket ---
                self._send_message_to_frontend("scan_complete", {"status": "scanning"})

                self.files = scan_files_folder()
                self.file_names_lower = [f["name"].lower() for f in self.files]
                self.file_search_display_paths_lower = [f["search_display_path"].lower().replace(os.sep, "/") for f in self.files]
                self.files_loaded = True  # Mark files as loaded only after successful initialization

                # --- Send signal to socket ---
                print("Caching completed!")
                self._send_message_to_frontend("scan_complete", {"status": "success"})

                # You might also want to send the initial file list for display if needed
                # self._send_message_to_frontend("initial_file_list", {"files": self.files[:self.page_size]})
                # --- END NEW ---

            except Exception as e:
                print(f"Error during background file scanning: {e}")
                # Ensure a clean state on error
                self.files = []
                self.file_names_lower = []
                self.file_search_display_paths_lower = []
                self.files_loaded = False # Crucial: mark as not loaded
                # GLib.idle_add(self._hide_center_spinner) # Hide spinner on error
                return # Stop further processing in this thread if scanning failed

            # # If scan was successful and files are loaded, process any pending/last search
            # # hide_spinner_after_scan = True
            # if self.pending_search_query is not None:
            #     # GLib.idle_add(self.perform_search, self.pending_search_query)
            #     self.pending_search_query = None
            #     # hide_spinner_after_scan = False # perform_search will hide it
            # elif self.last_query:
            #     pass
            #     # GLib.idle_add(self.perform_search, self.last_query)
            #     # hide_spinner_after_scan = False # perform_search will hide it
            # else: # No search query, populate with latest backups as default
            #     pass
            #     # GLib.idle_add(self.populate_latest_backups)
            #     # populate_latest_backups itself calls _hide_center_spinner if it populates results
            #     # but to be safe, ensure it's hidden if it doesn't populate anything.
            #     # However, populate_latest_backups calls populate_results which will hide it.

            # if hide_spinner_after_scan: # If no search took over, hide the initial scanning spinner
            #     GLib.idle_add(self._hide_center_spinner)



        threading.Thread(target=scan, daemon=True).start()
        # scan()


    # # 1. Cache user's home files
    # # 2. Filter using query search
    # def handle_query(self, query: str) -> dict:
    #     backup_service = SeachHandler()
        
    #     # scan_files_folder_threaded is called in __init__ which starts the thread
    #     # We need to wait for the thread to complete its work
        
    #     print("Starting file scan in background...")
        
    #     # Wait until files are loaded. In a real application, you might use an Event.
    #     # For a simple script, a loop with time.sleep works to demonstrate.
    #     while not backup_service.files_loaded:
    #         time.sleep(0.5) # Wait for 500 milliseconds before checking again
        
    #     print("Files are loaded. Performing search.")
    #     backup_service.perform_search(query)


if __name__ == "__main__":    
    pass