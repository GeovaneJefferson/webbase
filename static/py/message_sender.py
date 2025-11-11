from server import *
import time

# from static.py.server import *


class MessageSender:
    def __init__(self):
        self.socket_path = server.SOCKET_PATH
        self.timeout = 2
        # self.ws_client = WebSocketClient(ws_url)
    
    async def initialize_websocket(self):
        """Initialize WebSocket connection"""
        await self.ws_client.connect()
    
    def send_message(self, message_data: dict) -> bool:
        """Send a JSON message to the UI via UNIX socket."""
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(self.timeout)
                sock.connect(self.socket_path)
                sock.sendall((json.dumps(message_data) + "\n").encode("utf-8"))
            return True
        except Exception as e:
            logging.debug(f"[MessageSender] Failed to send message: {e}")
            return False
    
    def send_sleeping(self, description: str, processed: int = 0, progress: int = 0) -> bool:
        """Send sleeping files activity."""
        message = {
            "type": "sleeping",
            "title": "Sleeping...",
            "description": description,
            "progress": "progress",
            "processed": "processed",
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)

    def send_analyzing(self, description: str, processed: int = 0, progress: int = 0) -> bool:
        """Send analyzing files activity."""
        message = {
            "type": "analyzing",
            "title": "Analyzing files",
            "description": description,
            "progress": progress,
            "processed": processed,
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)

    def send_backup_progress(self, description: str, progress: int, eta: str) -> bool:
        """Send backup in progress activity."""
        message = {
            "type": "progress", 
            "title": "Backup in progress",
            "description": description,
            "progress": progress,
            "eta": eta,
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)

    def send_backup_completed(self, description: str) -> bool:
        """Send backup completed activity."""
        message = {
            "type": "completed",
            "title": "Backup completed",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)

    def send_warning(self, description: str) -> bool:
        """Send warning activity."""
        message = {
            "type": "warning",
            "title": "Warning",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)

    def send_new_folder(self, description: str) -> bool:
        """Send new folder added activity."""
        message = {
            "type": "info", 
            "title": "New folder added",
            "description": description,
            "timestamp": datetime.now().isoformat()
        }
        return self.send_message(message)
    
if __name__ == "__main__":
    server = SERVER()
    sender = MessageSender()

    print("--- Starting Message Sender Test Sequence ---")
    
    # 1. Initial State: Sleeping/Waiting
    sender.send_sleeping("Waiting for scheduled backup window...", processed=0, progress=0)
    time.sleep(2)
    
    # 2. Scanning/Analyzing Phase (with 5 steps)
    total_files_to_scan = 150
    print(f"-> Sending {total_files_to_scan} analyzing progress steps...")
    
    for i in range(1, 6):
        processed_files = int(total_files_to_scan * (i / 5))
        progress_percentage = i * 20
        description = f"Scanning /home/user/Documents... ({i}/5)"
        sender.send_analyzing(description, processed=processed_files, progress=progress_percentage)
        time.sleep(0.5)
        
    # 3. Interject with a New Folder message
    sender.send_new_folder("Discovered a new folder: /home/user/Projects/NewFeature")
    time.sleep(1)
    
    # 4. Backup Progress Phase (10 granular steps)
    total_files_to_copy = 10
    print(f"-> Sending {total_files_to_copy} backup progress steps...")
    
    for i in range(1, total_files_to_copy + 1):
        progress_percentage = i * 10
        eta = f"{total_files_to_copy - i} min" if total_files_to_copy - i > 0 else "< 1 min"
        filename = f"file_{i}.txt"
        sender.send_backup_progress(f"Copying /data/source/{filename}...", progress=progress_percentage, eta=eta)
        time.sleep(0.25)
        
    # 5. Interject with a Warning
    sender.send_warning("Skipped /media/temp/cache.log: File is currently in use.")
    time.sleep(1)
    
    # 6. Final progress update
    sender.send_backup_progress("Finalizing file integrity checks...", progress=99, eta="< 1 min")
    time.sleep(1)
    
    # 7. Completion
    sender.send_backup_completed("Backup to external drive completed successfully.")
    
    print("--- Test Sequence Complete ---")