import socket
import json
import time
import os
import random
from datetime import datetime

# This script simulates the daemon sending messages to the UI.
# It should be run while the main Flask application (app.py) is running,
# as app.py is responsible for creating and listening on the UNIX socket.

# This configuration must match the socket path defined in your `app.py`.
APP_NAME_CLOSE_LOWER = "dataguardian"
SOCKET_PATH = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), f"{APP_NAME_CLOSE_LOWER}-ui.sock")

def send_message(sock, message_dict):
    """Encodes and sends a message dictionary to the UI socket."""
    try:
        # The server expects each message to be a separate, self-contained JSON string.
        # We'll send one message and then a newline might help some servers, but here we'll just send the JSON.
        message_str = json.dumps(message_dict) + '\n' # Adding newline as a separator.
        sock.sendall(message_str.encode('utf-8'))
        print(f"Sent: {json.dumps(message_dict)}")
    except Exception as e:
        print(f"Failed to send message: {e}")
        # This might indicate the server closed the connection.
        # We will let the main loop handle reconnection.
        raise

def main():
    """Main function to run the socket client demo."""
    print(f"Attempting to connect to UI socket at: {SOCKET_PATH}")
    if not os.path.exists(SOCKET_PATH):
        print("\nError: Socket file does not exist.")
        print("Please ensure the main Flask application (app.py) is running, as it creates the socket.")
        return

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.connect(SOCKET_PATH)
            print("Successfully connected to UI socket. Starting demo sequence...")

            # --- 1. Simulate Analysis Phase ---
            print("\n--- Phase 1: Simulating File Analysis ---")
            folders_to_scan = ["Documents/Work", "Pictures/Vacation", "Projects/ClientX", "Music/Collection"]
            for i, folder in enumerate(folders_to_scan):
                analysis_msg = {
                    "type": "analysis_progress",
                    "status_text": f"Scanning {folder}/...",
                    "progress_percent": (i + 1) * 25,
                    "count_text": f"{(i + 1) * 312} files processed"
                }
                send_message(sock, analysis_msg)
                time.sleep(1.5)

            # --- 2. Simulate Analysis Completion ---
            activity_msg = {
                "type": "new_activity",
                "activity": {
                    "icon": "search",
                    "color": "blue",
                    "title": "Analysis complete",
                    "message": f"Finished scanning {len(folders_to_scan)} top-level folders.",
                    "timestamp": datetime.now().isoformat()
                }
            }
            send_message(sock, activity_msg)
            time.sleep(1)

            # --- 3. Simulate File Transfer Phase ---
            print("\n--- Phase 2: Simulating File Transfers ---")
            files_to_backup = [
                ("Documents/Reports/Q1_Report.pdf", "5.2 MB"),
                ("Pictures/Vacation/IMG_2024.jpg", "3.1 MB"),
                ("Projects/ClientX/archive.zip", "150.7 MB"),
                ("Music/Collection/song.mp3", "8.9 MB")
            ]

            for rel_path, size in files_to_backup:
                filename = os.path.basename(rel_path)
                
                # Simulate progress for a single file (from 0% to 100%)
                for progress_step in range(0, 101, 20):
                    progress_float = progress_step / 100.0
                    eta_seconds = (100 - progress_step) * 0.1 # Fake ETA calculation
                    eta_str = f"{int(eta_seconds)}s"

                    # This message type is not yet handled by the UI's UIMessageHandler,
                    # but we send it for future-proofing your demo.
                    transfer_msg = {
                        "type": "transfer_progress",
                        "id": rel_path,
                        "filename": filename,
                        "size": size,
                        "eta": "done" if progress_float == 1.0 else eta_str,
                        "progress": progress_float
                    }
                    # This message is not currently handled by the UI, but we print it.
                    # To see it in the UI, you would need to add a 'case' for 'transfer_progress'
                    # in the UIMessageHandler in scripts.js
                    print(f"Sending (UI will ignore): {json.dumps(transfer_msg)}")
                    time.sleep(0.2)

            print("\nDemo complete. Sent a series of messages to the UI socket.")

    except ConnectionRefusedError:
        print("Error: Connection refused. Is the main application (app.py) running and listening?")
    except BrokenPipeError:
        print("Error: The connection was closed by the server. Has the main app been shut down?")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    main()