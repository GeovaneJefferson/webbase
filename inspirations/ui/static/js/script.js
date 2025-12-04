/**
 * @file script.js
 * @description Main client-side script for the Time Machine UI.
 * Handles Navigation, Devices, Migration Assistant, Files, and Settings.
 */


// =====================================================================
// --- 1. GLOBAL DATA & STATE ---
// =====================================================================

let userPlan = 'basic'; 
let username = 'User';
var isDeviceConnected = false;
let activeSettingsTab = 'folders'; 
let currentTabId = 'overview';
let generalSettings = {
    autoStartup: true,
    autoUpdates: true,
    showNotifications: true
};
let currentFolder = null;
let selectedFile = null;
let currentEditCat = null;
let selectedSource = null;
let fileSystem = null;
let breadcrumbStack = [];
let migSelectionState = { home: false, flatpaks: false, installers: false };
let homeFolders = [];
let deviceData = [];

const MAX_FEED_ITEMS = 6; // Only show the last 10-15 items

// =====================================================================
// --- 2. FILE SYSTEM INITIALIZATION ---
// =====================================================================

// Initialize fileSystem from backend API
async function initializeFileSystem() {
    try {
        // Step 1: Trigger backend file scanning
        const initResponse = await fetch('/api/search/init', { method: 'POST' });
        const initData = await initResponse.json();
        
        // if (initData.success) {
        //     console.log(`[FileSystem] Search initialized with ${initData.file_count || 0} files`);
        // }
        
        // Step 2: Create the fileSystem root structure
        fileSystem = {
            name: '.main_backup',
            type: 'folder',
            children: []
        };
        
        // Step 3: Initialize navigation stack
        breadcrumbStack = [fileSystem];
        currentFolder = fileSystem;
        
        // console.log('[FileSystem] Ready for file operations');
    } catch (error) {
        console.error('[FileSystem] Failed to initialize:', error);
        // Fallback: Create empty fileSystem
        fileSystem = {
            name: '.main_backup',
            type: 'folder',
            children: []
        };
        breadcrumbStack = [fileSystem];
        currentFolder = fileSystem;
    }
}


// =====================================================================
// --- WEBSOCKET CLIENT FOR Transfers FEED ---
// =====================================================================
class BackupStatusClient {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 3000; // 3 seconds
        this.url = this.getWebSocketURL();
    }

    getWebSocketURL() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws/transfers-feed`;
    }

    connect() {
        try {
            console.log(`[WebSocket] Attempting to connect to ${this.url}`);
            this.ws = new WebSocket(this.url);
            
            this.ws.onopen = () => {
                console.log('[WebSocket] ✓ Connected to transfers feed');
                this.reconnectAttempts = 0;
                // Send a test/handshake message
                try {
                    this.ws.send(JSON.stringify({ type: 'client_connected', timestamp: Date.now() }));
                } catch (e) {
                    console.log('[WebSocket] Could not send handshake:', e);
                }
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    console.log('[WebSocket] Received message:', message);
                    ActivityFeedManager.handleMessage(message);
                } catch (e) {
                    console.error('[WebSocket] Error parsing message:', e, event.data);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[WebSocket] Connection error:', error);
            };

            this.ws.onclose = () => {
                // console.log('[WebSocket] Connection closed');
                this.attemptReconnect();
            };
        } catch (error) {
            console.error('[WebSocket] Failed to create connection:', error);
            this.attemptReconnect();
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
            // console.log(`[WebSocket] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        } else {
            console.warn('[WebSocket] Max reconnect attempts reached. Activity feed will not receive live updates.');
            console.log('[WebSocket] Make sure the Flask server is running and the socket path is configured correctly.');
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}

// Initialize the global WebSocket client
window.backupStatusClient = new BackupStatusClient();


// DATA: Migration Sources (Migration Step 1)
let migrationDevices = [
    { id: 1, name: 'Seagate Expansion', icon: 'bi-usb-drive-fill', type: 'External Drive', size: '2 TB', hasBackup: true, lastDate: 'Yesterday, 10:23 PM' },
    { id: 2, name: 'NAS_Home_Cloud', icon: 'bi-hdd-network-fill', type: 'Network Disk', size: '4 TB', hasBackup: true, lastDate: 'Today, 09:00 AM' },
    { id: 3, name: 'USB_Stick_SanDisk', icon: 'bi-usb-drive', type: 'USB Flash', size: '32 GB', hasBackup: false, lastDate: null }
];

// DATA: Migration Content (Migration Step 2)
const migrationData = {
    home: [
        { id: 'h1', name: 'Documents', size: '12 GB', icon: 'bi-file-earmark-text', color: 'text-yellow-500', selected: true },
        { id: 'h2', name: 'Pictures', size: '45 GB', icon: 'bi-image', color: 'text-purple-500', selected: true },
        { id: 'h3', name: 'Music', size: '8 GB', icon: 'bi-music-note-beamed', color: 'text-pink-500', selected: true },
        { id: 'h4', name: '.ssh (Keys)', size: '4 KB', icon: 'bi-key-fill', color: 'text-slate-500', selected: true },
        { id: 'h5', name: '.config', size: '150 MB', icon: 'bi-gear-fill', color: 'text-slate-500', selected: true }
    ],
    flatpaks: [
        { id: 'f1', name: 'Spotify', desc: 'Music Streaming', icon: 'bi-spotify', color: 'text-green-500', selected: true },
        { id: 'f2', name: 'Obsidian', desc: 'Note Taking', icon: 'bi-journal-text', color: 'text-purple-600', selected: true },
        { id: 'f3', name: 'VLC Media Player', desc: 'Video', icon: 'bi-cone-striped', color: 'text-orange-500', selected: true }
    ],
    installers: [
        { id: 'i1', name: 'google-chrome-stable.deb', desc: 'Found in /Downloads', size: '105 MB', icon: 'bi-browser-chrome', color: 'text-red-500', selected: true },
        { id: 'i2', name: 'visual-studio-code.rpm', desc: 'Found in /Downloads', size: '120 MB', icon: 'bi-code-slash', color: 'text-blue-500', selected: true },
        { id: 'i3', name: 'discord-0.0.5.deb', desc: 'Found in /Downloads', size: '85 MB', icon: 'bi-discord', color: 'text-indigo-500', selected: true },
        { id: 'i4', name: 'steam_latest.deb', desc: 'Found in /Downloads', size: '12 MB', icon: 'bi-controller', color: 'text-slate-800', selected: true }
    ]
};


// =====================================================================
// --- PRO FEATURE: RESTRICT START RESTORE BUTTON ---
// =====================================================================

/**
 * Checks if user has Pro access before starting restore
 */
function checkProBeforeRestore() {
    if (userPlan === 'pro') {
        startMigrationProcess();
    } else {
        showSystemNotification('info', 'Pro Feature Required', 'Upgrade to Pro to start system restoration.');
        openProPlanModal();
    }
}

/**
 * Updates the restore button based on user plan and selection state
 */
function updateRestoreButton() {
    const btn = document.getElementById('btn-start-restore');
    if (!btn) return;

    const hasSelection = Object.values(migSelectionState).some(v => v);
    const span = btn.querySelector('span');
    const cancel_restore_btn = document.getElementById('cancel-restore-btn')
    
    if (userPlan === 'pro') {
        // Pro user: Use default brand colors
        if (hasSelection) {
            btn.disabled = false;
            btn.className = "bg-brand-600 text-white hover:bg-brand-700 px-8 py-3 rounded-xl font-bold text-sm transition flex items-center gap-2 shadow-sm cursor-pointer";
            btn.onclick = startMigrationProcess;
            // Show restore cancel button
            if (cancel_restore_btn) {
                cancel_restore_btn.classList.remove('hidden');
            }
        } else {
            btn.disabled = true;
            btn.className = "bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500 px-8 py-3 rounded-xl font-bold text-sm transition cursor-not-allowed flex items-center gap-2";
            btn.onclick = null;
        }
        // Remove star icon for Pro users
        const starIcon = btn.querySelector('.bi-star-fill');
        if (starIcon) {
            starIcon.remove();
        }
    } else {
        // Basic user: Show Pro upgrade style with gradient and star
        btn.disabled = false;
        btn.className = "bg-gradient-to-r from-brand-600 to-purple-600 text-white hover:from-brand-700 hover:to-purple-700 px-8 py-3 rounded-xl font-bold text-sm transition flex items-center gap-2 shadow-sm cursor-pointer";
        btn.onclick = checkProBeforeRestore;
        
        // Ensure star icon exists for Basic users
        const starIcon = btn.querySelector('.bi-star-fill');
        if (!starIcon) {
            const newStarIcon = document.createElement('i');
            newStarIcon.className = 'bi bi-star-fill text-yellow-400 mr-1';
            btn.insertBefore(newStarIcon, btn.querySelector('span'));
        }
    }
    
    // Always ensure correct button text
    if (span) {
        span.textContent = "Start Restore";
    }
}

/**
 * Updates user plan and UI accordingly
 */
function updateUserPlan(plan) {
    userPlan = plan;
    updateProUI();
}


/**
 * Updates all UI elements based on user plan
 */
function updateProUI() {
    // Update restore button first
    updateRestoreButton();
    
    // Update dashboard status
    updateDashboardStatus();
}


// =====================================================================
// --- UI HELPERS ---
// =====================================================================

function nav(tabId) {
    currentTabId = tabId;  // Track current tab globally

    // 1. Sidebar Active States
    document.querySelectorAll('.btn-nav').forEach(btn => {
        btn.classList.remove('active', 'bg-blue-50', 'text-blue-600', 'dark:bg-blue-900/20', 'dark:text-blue-400');
        // Reset to default
        btn.classList.add('text-secondary');
    });

    const targetBtn = document.getElementById('btn-' + tabId);
    if (targetBtn) {
        targetBtn.classList.add('active'); // CSS handles the styling via .active class
        targetBtn.classList.remove('text-secondary');
    }

    // 2. View Switching
    ['overview', 'files', 'devices', 'migration', 'settings', 'logs'].forEach(t => {
        const view = document.getElementById('view-' + t);
        if (view) view.classList.add('hidden');
    });

    const targetView = document.getElementById('view-' + tabId);
    if (targetView) {
        targetView.classList.remove('hidden');
        // Add subtle entry animation class if supported
        targetView.classList.add('animate-entry');
    }

    // 3. Page Title Update
    const titles = {
        overview: 'Dashboard',
        files: 'File Explorer',
        devices: 'Backup Sources',
        migration: 'System Restore',
        settings: 'Preferences',
        logs: 'Console'
    };
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.innerText = titles[tabId] || 'Dashboard';

    // 4. Lazy Load Data
    if (tabId === 'devices') DeviceManager.load();
    if (tabId === 'files' && currentFolder && Array.isArray(currentFolder.children) && currentFolder.children.length === 0) loadFolderContents();
    if (tabId === 'migration') initMigrationView();
    if (tabId === 'settings') renderSettings();
}

function updateGreetingAndClock() {
    // const now = new Date();
    // const timeEl = document.getElementById('current-time');
    // if(timeEl) timeEl.innerText = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    const greetEl = document.getElementById('greeting');
    greetEl.innerText = `Hello, ${username}`;
    
    // // Greeting with real username from backend
    // fetch('/api/username')
    // .then(response => response.json())
    // .then(data => {
    //     username = data.username || 'User';
    //     if (greetEl) greetEl.innerText = `Hello, ${username.charAt(0).toUpperCase() + username.slice(1)}`;
    // });

}

function getUsersName() {
    // Greeting with real username from backend
    fetch('/api/username')
    .then(response => response.json())
    .then(data => {
        const name = data.username || 'User';
        username = name.charAt(0).toUpperCase() + name.slice(1);
    });
}

function checkBackupConnection() {
    // 1. Get elements and capture PREVIOUS state
    const staticDotElement = document.getElementById('devices-connection-ping'); 
    const pingElement = document.getElementById('devices-connection-ping-animation');
    
    // Capture the state *before* the API call
    const wasDisconnectedBefore = !isDeviceConnected; 
        
    if (!staticDotElement || !pingElement) {
        console.warn('Status UI elements not found. Check HTML IDs.');
        return;
    }

    // Check backup connection status from backend, in loop
    fetch('/api/backup/connection')
    .then(response => {
        if (!response.ok) throw new Error('API network error');
        return response.json();
    })
    .then(data => {
        const isConnectedNow = data.connected;

        // ⚠️ CRITICAL FIX: Update the global state FIRST.
        // This ensures loadFolderContents() uses the correct state (Disconnected)
        // when it runs, forcing it to display the "No Backup Device Connected" message.
        isDeviceConnected = isConnectedNow; // Set the new state immediately

        // ------------------ UI UPDATE LOGIC ------------------
        if (isConnectedNow) {
            // Connected (Green)
            staticDotElement.classList.replace('status-dot-disconnected', 'status-dot-connected');
            pingElement.classList.replace('animate-ping-disconnected', 'animate-ping-connected');
        } else {
            // Disconnected (Red)
            staticDotElement.classList.replace('status-dot-connected', 'status-dot-disconnected');
            pingElement.classList.replace('animate-ping-connected', 'animate-ping-disconnected');
        }
        
        // ------------------ STATE TRANSITION LOGIC ------------------
        
        // 1. Check for RECONNECTION (Transition: Disconnected -> Connected)
        // wasDisconnectedBefore is true AND isConnectedNow is true
        if (currentTabId === 'files' && wasDisconnectedBefore && isConnectedNow) {
            console.log("Device reconnected while on Files tab. Loading contents once.");
            // loadFolderContents will now run knowing isDeviceConnected is TRUE.
            loadFolderContents(); 
        } 
        
        // 2. Check for DISCONNECTION (Transition: Connected -> Disconnected)
        // wasDisconnectedBefore is false AND isConnectedNow is false
        else if (currentTabId === 'files' && !wasDisconnectedBefore && !isConnectedNow) {
            console.log("Device disconnected while on Files tab. Showing disconnection message once.");
            // loadFolderContents will now run knowing isDeviceConnected is FALSE.
            // This triggers your container.innerHTML logic.
            loadFolderContents();
        }
    })
    .catch(error => {
        // Disconnected (Red) on API failure
        console.error("Connection check failed, setting UI to disconnected.", error);

        // Ensure UI and global state reflect disconnection on error
        staticDotElement.classList.replace('status-dot-connected', 'status-dot-disconnected');
        pingElement.classList.replace('animate-ping-connected', 'animate-ping-disconnected');
        isDeviceConnected = false;
    });
}


// =====================================================================
// --- 3. DEVICES TAB LOGIC ---
// =====================================================================

function renderDevices(devices) {
    const container = document.getElementById('device-list-container');
    if (!container) return;
    container.innerHTML = ''; 

    if (!devices || devices.length === 0) {
        container.innerHTML = `<p class="text-gray-400 text-center col-span-3">No devices found.</p>`;
        return;
    }

    devices.forEach(device => {
        console.log(device);
        const usagePercent = Math.round((device.usedGB / device.totalGB) * 100);
        let statusBadgeClass = device.status === 'Active' ? 'bg-green-100 text-green-700' : (device.status === 'Error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700');
        let statusIcon = device.status === 'Active' ? 'bi-check-circle-fill' : (device.status === 'Error' ? 'bi-exclamation-triangle-fill' : 'bi-power');
        let actionButton = device.status === 'Active' 
            ? `<button disabled class="w-full py-2.5 rounded-lg text-xs font-bold bg-green-50 text-green-700 border border-green-200 cursor-default flex items-center justify-center gap-2"><i class="bi bi-check-circle-fill"></i> Currently Active</button>`
            : `<button onclick="useThisBackupDevice(${device})" class="w-full py-2.5 rounded-lg text-xs font-bold bg-white border border-brand-200 text-brand-600 hover:bg-brand-50 hover:border-brand-300 transition shadow-sm flex items-center justify-center gap-2"><i class="bi bi-hdd-network"></i> Use as backup device</button>`;

        const deviceCard = `
            <div id="device-${device.id}" class="bg-white p-6 rounded-xl border border-gray-200 shadow-lg hover:shadow-xl transition flex flex-col h-full">
                <div class="flex items-start justify-between mb-6">
                    <div class="flex items-center gap-4">
                        <i class="bi ${device.icon} text-3xl ${device.color}"></i>
                        <div>
                            <h4 class="font-bold text-lg">${device.name}</h4>
                            <span class="text-xs font-medium ${statusBadgeClass} px-2 py-0.5 rounded-full inline-flex items-center gap-1 mt-1"><i class="bi ${statusIcon} text-[10px]"></i> ${device.status}</span>
                        </div>
                    </div>
                </div>
                <div class="mb-6 flex-1">
                    <div class="flex justify-between text-xs text-gray-500 mb-2 font-medium"><span>Used: ${device.usedGB} GB</span><span>Total: ${device.totalGB} GB</span></div>
                    <div class="progress-bar-container h-2 bg-gray-100 rounded-full overflow-hidden"><div class="progress-bar-fill ${usagePercent > 80 ? 'bg-red-500' : 'bg-brand-500'} h-full rounded-full transition-all duration-500" style="width: ${usagePercent}%"></div></div>
                </div>
                <div class="pt-4 border-t border-gray-50 mt-auto">${actionButton}</div>
            </div>`;
        container.innerHTML += deviceCard;
    });
}

function refreshDevices() {
    const container = document.getElementById('device-list-container');
    if(container) {
        container.innerHTML = `
            <div class="col-span-3 bg-white p-10 rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center text-center">
                <i class="bi bi-arrow-clockwise animate-spin text-2xl text-brand-500 mb-3"></i>
                <p class="text-sm text-brand-600 font-medium">Scanning for new devices...</p>
            </div>`;
        DeviceManager.load();
    }
}


// =====================================================================
// --- 4. MIGRATION ASSISTANT LOGIC (Workflow) ---
// =====================================================================

function initMigrationView() {
    // Reset Steps
    document.getElementById('mig-step-1-source').classList.remove('hidden');
    document.getElementById('mig-step-2-content').classList.add('hidden');
    document.getElementById('mig-step-3-progress').classList.add('hidden');
    document.getElementById('mig-step-desc').innerText = "Select a source to start the restoration process.";
    
    // Auto-Scan
    renderSourceList();
}

function renderSourceList() {
    const container = document.getElementById('mig-source-list');
    if (!container) return;

    container.innerHTML = `
        <div class="text-center py-10 text-muted">
            <i class="bi bi-arrow-clockwise animate-spin text-2xl mb-2"></i>
            <p class="text-sm">Scanning for backup sources...</p>
        </div>
    `;

    fetch('/api/migration/sources')
        .then(res => res.json())
        .then(data => {
            container.innerHTML = '';
            if (!data.success || !data.sources || data.sources.length === 0) {
                container.innerHTML = `
                    <div class="text-center p-10 border-2 border-dashed border-main rounded-2xl text-muted">
                        <i class="bi bi-hdd-network-off text-4xl mb-3"></i>
                        <h4 class="font-bold text-main">No Backup Sources Found</h4>
                        <p class="text-sm mt-1">Connect a drive with a Time Machine backup and try again.</p>
                    </div>`;
                return;
            }

            // Use the fetched sources to render the list
            data.sources.forEach(device => {
                const totalGB = Math.round((device.total || 0) / (1024**3));
                const card = `
                    <div onclick='selectSource(${JSON.stringify(device).replace(/'/g, "\\'")})' class="bg-card border border-main rounded-2xl p-5 flex items-center gap-5 hover:border-brand-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer transition-all group">
                        <div class="w-16 h-16 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-500 flex items-center justify-center text-3xl border border-main">
                            <i class="bi bi-usb-drive-fill"></i>
                        </div>
                        <div class="flex-1">
                            <h4 class="font-bold text-main text-lg">${device.label || device.name}</h4>
                            <p class="text-xs text-muted">${device.filesystem} • ${totalGB} GB</p>
                        </div>
                        <i class="bi bi-chevron-right text-muted text-xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
                    </div>
                `;
                container.innerHTML += card;
            });
        });
}

function selectSource(device) {
    if (!device) {
        console.error("Invalid device object passed to selectSource.");
        return;
    }
    selectedSource = device;

    document.getElementById('mig-step-1-source').classList.add('hidden');
    document.getElementById('mig-step-2-content').classList.remove('hidden');
    document.getElementById('mig-step-desc').innerText = "Step 2 of 3: Choose what to restore from the backup.";
    
    migSelectionState = { home: false, flatpaks: false, installers: false };
    
    // Simulate scanning for content
    document.getElementById('desc-flatpaks').innerHTML = '<i class="bi bi-arrow-clockwise animate-spin mr-1"></i> Scanning...';
    document.getElementById('desc-installers').innerHTML = '<i class="bi bi-arrow-clockwise animate-spin mr-1"></i> Scanning...';

    setTimeout(() => {
        migSelectionState = { home: true, flatpaks: true, installers: true };
        updateMigContentUI();
    }, 800);
}

function backToSourceStep() {
    document.getElementById('mig-step-2-content').classList.add('hidden');
    document.getElementById('mig-step-1-source').classList.remove('hidden');
    document.getElementById('mig-step-desc').innerText = "Select a source to start the restoration process.";
}

function toggleMigrationItem(key) {
    migSelectionState[key] = !migSelectionState[key];
    updateMigContentUI();
}

function updateMigContentUI() {
    ['home', 'flatpaks', 'installers'].forEach(key => {
        const card = document.getElementById(`mig-card-${key}`);
        const check = document.getElementById(`check-${key}`);
        const desc = document.getElementById(`desc-${key}`);
        const isActive = migSelectionState[key];
        const list = migrationData[key];
        const selectedCount = list.filter(i => i.selected).length;

        if (key === 'home' && isActive && desc) desc.innerText = "Calculated: 142 GB";
        else if (key === 'flatpaks' && desc) desc.innerText = `${selectedCount}/${list.length} Apps selected`;
        else if (key === 'installers' && desc) desc.innerText = `${selectedCount}/${list.length} Files selected`;

        if (isActive) {
            if (key === 'home') { card.classList.add('ring-4', 'ring-brand-500'); card.classList.remove('border-transparent'); if(check) check.classList.remove('opacity-0', 'scale-75'); }
            else { card.classList.add('border-brand-500', 'bg-brand-50', 'shadow-md'); card.classList.remove('border-gray-200', 'bg-white'); if(check) check.classList.remove('opacity-0', 'scale-75'); }
            // Corrected styling for dark mode
            card.classList.remove('bg-card', 'border', 'border-main'); // Remove default card styling
            card.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-blue-500', 'dark:border-blue-400', 'shadow-md');
            if(check) check.classList.remove('opacity-0', 'scale-75');
        } else {
            if (key === 'home') { card.classList.remove('ring-4', 'ring-brand-500'); card.classList.add('border-transparent'); if(check) check.classList.add('opacity-0', 'scale-75'); }
            else { card.classList.remove('border-brand-500', 'bg-brand-50', 'shadow-md'); card.classList.add('border-gray-200', 'bg-white'); if(check) check.classList.add('opacity-0', 'scale-75'); }
            // Revert to default card styling
            card.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-blue-500', 'dark:border-blue-400', 'shadow-md');
            card.classList.add('bg-card', 'border', 'border-main'); // Add default card styling back
            if(check) check.classList.add('opacity-0', 'scale-75');
        }
    });

    updateRestoreButton();
}

function startMigrationProcess() {
    // Prepare UI
    const step2 = document.getElementById('mig-step-2-content');
    const step3 = document.getElementById('mig-step-3-progress');
    const desc = document.getElementById('mig-step-desc');
    if (step2) step2.classList.add('hidden');
    if (step3) step3.classList.remove('hidden');
    if (desc) desc.innerText = "Transferring data. Do not disconnect your drive.";

    // Elements
    const bar = document.getElementById('migration-progress-bar');
    const pct = document.getElementById('progress-percent');
    const status = document.getElementById('migration-status-text');
    const time = document.getElementById('time-remaining');
    const cancelBtn = document.getElementById('cancel-restore-btn');

    // Cancel handling
    let cancelled = false;
    if (cancelBtn) {
        cancelBtn.classList.remove('hidden');
        cancelBtn.disabled = false;
        cancelBtn.onclick = () => {
            cancelled = true;
            cancelBtn.disabled = true;
            if (status) { status.innerText = 'Cancelling...'; }
            showSystemNotification('info', 'Migration', 'Cancelling migration...');
        };
    }

    // Build processing queue from selected migration cards
    const filesToProcess = [];
    if (migSelectionState.home) migrationData.home.forEach(f => filesToProcess.push({ name: f.name || f, size: (f.size && typeof f.size === 'number') ? f.size : (Math.floor(Math.random() * 6) + 1) * 1024 * 1024 }));
    if (migSelectionState.flatpaks) migrationData.flatpaks.forEach(f => filesToProcess.push({ name: f.name || f, size: (f.size && typeof f.size === 'number') ? f.size : (Math.floor(Math.random() * 10) + 2) * 1024 * 1024 }));
    if (migSelectionState.installers) migrationData.installers.forEach(f => filesToProcess.push({ name: f.name || f, size: (f.size && typeof f.size === 'number') ? f.size : (Math.floor(Math.random() * 8) + 1) * 1024 * 1024 }));

    if (filesToProcess.length === 0) {
        showSystemNotification('info', 'Nothing to Migrate', 'No items selected for migration.');
        // Revert UI
        if (step2) step2.classList.remove('hidden');
        if (step3) step3.classList.add('hidden');
        return;
    }

    // Calculate totals
    const totalFiles = filesToProcess.length;
    const totalBytes = filesToProcess.reduce((s, f) => s + (f.size || 0), 0);
    let bytesProcessed = 0;
    const startTime = Date.now();

    // Helper to update progress UI
    function updateUI() {
        const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesProcessed / totalBytes) * 100)) : 0;
        if (bar) bar.style.width = `${percent}%`;
        if (pct) pct.innerText = `${percent}%`;
        // ETA estimation
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const speed = elapsed > 0 ? bytesProcessed / elapsed : 0; // bytes/sec
        const remaining = Math.max(0, totalBytes - bytesProcessed);
        const etaSec = speed > 0 ? Math.round(remaining / speed) : -1;
        if (etaSec >= 0) {
            const mins = Math.floor(etaSec / 60);
            time.innerText = mins > 0 ? `${mins} min` : '< 1 min';
        } else {
            time.innerText = 'Calculating...';
        }
    }

    // Sequentially process files (simulated durations based on size)
    (async () => {
        for (let i = 0; i < filesToProcess.length; i++) {
            if (cancelled) break;
            const file = filesToProcess[i];

            // Indicate which file is being processed (restore flow)
            if (status) status.innerHTML = `<i class="bi bi-arrow-repeat animate-spin mr-2"></i> Restoring ${file.name}`;

            // Simulate file backup duration proportional to size (but bounded)
            const simulatedSecs = Math.min(6 + (file.size / (1024 * 1024)) * 0.25, 20); // 0.25s per MB, min ~6s, max 20s
            const startFile = Date.now();
            const fileTarget = file.size || (1 * 1024 * 1024);
            let fileProcessed = 0;

            // Animate per-file progress in small ticks
            await new Promise(resolve => {
                const tickMs = 250;
                const ticks = Math.max(4, Math.round((simulatedSecs * 1000) / tickMs));
                let tick = 0;
                const interval = setInterval(() => {
                    if (cancelled) {
                        clearInterval(interval);
                        resolve();
                        return;
                    }
                    tick++;
                    // increment processed bytes for this file
                    const increment = Math.round(fileTarget / ticks);
                    fileProcessed = Math.min(fileTarget, fileProcessed + increment);
                    bytesProcessed += increment;
                    if (bytesProcessed > totalBytes) bytesProcessed = totalBytes;
                    updateUI();

                    // Every few ticks, optionally show a lightweight toast
                    if (tick % Math.max(1, Math.round(ticks / 3)) === 0) {
                        // no-op for now, UI is updating
                    }

                    if (tick >= ticks || fileProcessed >= fileTarget) {
                        clearInterval(interval);
                        // Count as file completed
                        bytesProcessed = Math.min(totalBytes, bytesProcessed + Math.max(0, fileTarget - fileProcessed));
                        updateUI();
                        resolve();
                    }
                }, tickMs);
            });

            if (cancelled) break;

            // Mark file as restored in the live feed (restore flow)
            try {
                if (ActivityFeedManager && ActivityFeedManager.handleMessage) {
                    ActivityFeedManager.handleMessage({
                        type: 'file_activity',
                        title: 'Restored',
                        description: file.name,
                        size: file.size || 0,
                        timestamp: Date.now(),
                        status: 'success'
                    });
                }
            } catch (e) {
                console.warn('Failed to push file activity to feed:', e);
            }

            // Update status label per-file (show check icon briefly)
            if (status) status.innerHTML = `<i class="bi bi-check-lg text-emerald-500 mr-2"></i> Restored ${i + 1}/${totalFiles}: ${file.name}`;
        }

        // Finalize
        if (cancelled) {
            if (status) { status.innerHTML = '<i class="bi bi-x-circle-fill text-orange-500 mr-2"></i> Migration Cancelled'; status.className = 'text-orange-500 font-bold'; }
            showSystemNotification('info', 'Migration Cancelled', 'Migration was cancelled by the user.');
        } else {
            bytesProcessed = totalBytes;
            updateUI();
            if (status) { status.innerHTML = '<i class="bi bi-check-circle-fill text-green-600 mr-2"></i> Migration Complete!'; status.className = 'text-green-600 font-bold text-lg'; }
            if (time) time.innerText = 'Done';
            showSystemNotification('success', 'Migration Completed', `Migrated ${totalFiles} item${totalFiles !== 1 ? 's' : ''}.`);
        }

        // Clean up UI
        if (cancelBtn) { cancelBtn.classList.add('hidden'); cancelBtn.onclick = null; }
    })();
}


async function openCustomizeModal(category) {
    currentEditCat = category;
    const modal = document.getElementById('migration-detail-modal');
    const container = document.getElementById('detail-modal-container');
    const list = document.getElementById('detail-list-container');
    const title = document.getElementById('detail-modal-title');

    if (!modal || !container || !list || !title) return;

    let displayName = category === 'installers' ? 'Installers' : (category === 'flatpaks' ? 'Applications' : 'Folders');
    title.innerText = `Select ${displayName}`;
    
    list.innerHTML = '<div class="text-center p-4 text-muted"><i class="bi bi-arrow-clockwise animate-spin"></i> Loading...</div>';

    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => { container.classList.remove('scale-95', 'opacity-0'); container.classList.add('scale-100', 'opacity-100'); }, 10);

    // Fetch data if it's for 'home' folders, otherwise use static data
    if (category === 'home') {
        try {
            const response = await fetch(`/api/search/folder?path=`);
            const data = await response.json();

            if (data.success && data.items) {
                // Filter for folders and map to the structure migrationData expects
                migrationData.home = data.items
                    .filter(item => item.type === 'folder')
                    .map(folder => ({
                        id: folder.name,
                        name: folder.name,
                        icon: 'bi-folder-fill',
                        color: 'text-blue-500',
                        selected: true // Default to selected
                    }));
            } else {
                migrationData.home = [];
            }
        } catch (error) {
            console.error("Failed to fetch home folders for migration:", error);
            migrationData.home = [];
            list.innerHTML = '<div class="text-center p-4 text-red-500">Failed to load folders.</div>';
        }
    }

    // Render items
    list.innerHTML = ''; // Clear loading
    if (migrationData[category].length === 0) {
        list.innerHTML = '<div class="text-center p-4 text-muted">No items found.</div>';
    } else {
        migrationData[category].forEach((item, idx) => {
            const row = `
                <div onclick="toggleDetailItem(${idx})" class="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-white/10 cursor-pointer transition-colors">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-md bg-gray-100 dark:bg-white/5 flex items-center justify-center text-lg ${item.color || 'text-gray-500'}">
                            <i class="bi ${item.icon || 'bi-folder'}"></i>
                        </div>
                        <p class="text-sm font-bold text-main leading-none">${item.name}</p>
                    </div>
                    <div class="w-5 h-5 rounded border ${item.selected ? 'bg-brand-600 border-brand-600' : 'border-gray-300 bg-white'} flex items-center justify-center text-white text-xs">
                        ${item.selected ? '<i class="bi bi-check"></i>' : ''}
                    </div>
                </div>`;
            list.innerHTML += row;
        });
    }
}

function toggleDetailItem(idx) {
    migrationData[currentEditCat][idx].selected = !migrationData[currentEditCat][idx].selected;
    openCustomizeModal(currentEditCat);
}

function closeCustomizeModal() {
    const modal = document.getElementById('migration-detail-modal');
    const container = document.getElementById('detail-modal-container');
    if (modal && container) {
        container.classList.add('scale-95', 'opacity-0');
        container.classList.remove('scale-100', 'opacity-100');
        setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 200);
    }
}


// =====================================================================
// --- 5. FILES TAB LOGIC ---
// =====================================================================
/**
 * Load folder contents from backend API
 */
async function loadFolderContents(folderPath = '') {
    const container = document.getElementById('file-list-container');
    // console.log("Is devive connected?", isDeviceConnected);

    // Handle no backup connection
    if (!isDeviceConnected) {
        const fileSearchField = document.getElementById('file-search-input');
        // Disable search input
        fileSearchField.disabled = true;
        container.innerHTML = `
            <div class="p-8 text-center text-muted">
                <i class="bi bi-exclamation-triangle-fill text-3xl mb-3"></i>
                <h4 class="font-bold text-main">No Backup Device Connected</h4>
                <p class="text-sm mt-1">Please connect your backup device to browse files.</p>
            </div>`;
        return;
    }

    // Instead, handle empty path:
    if (folderPath === null || folderPath === undefined) {
        folderPath = '';
    }

    // Show loading state
    container.innerHTML = `
        <div class="flex items-center gap-2 text-slate-500">
            <i class="bi bi-arrow-clockwise animate-spin"></i>
            <span>Loading folder...</span>
        </div>`;

    try {
        // Make sure path is properly encoded
        const encodedPath = encodeURIComponent(folderPath);
        const response = await fetch(`/api/search/folder?path=${encodedPath}`);
        const data = await response.json();
        console.log("Folder contents response:", data);

        if (data.success && data.items && data.items.length > 0) {
            // Add icons and colors to file items
            const enrichedItems = data.items.map(item => {
                if (item.type === 'file') {
                    item.icon = getIconForFile(item.name);
                    item.color = getColorForFile(item.name);
                } else if (item.type === 'folder') {
                    // Add folder-specific icons
                    item.icon = 'bi-folder-fill';
                    item.color = 'text-blue-500';
                }
                return item;
            });
            
            // Update currentFolder with the loaded items
            if (currentFolder) {
                currentFolder.children = enrichedItems;
            }
            renderExplorer(enrichedItems);
        } else {
            container.innerHTML = '<p class="p-4 text-gray-400">Folder is empty.</p>';
        }
    } catch (error) {
        console.error('Failed to load folder contents:', error);
        container.innerHTML = '<p class="p-4 text-red-500">Failed to load folder contents.</p>';
    }
}

function renderExplorer(items = null) {
    const container = document.getElementById('file-list-container');
    const breadcrumb = document.getElementById('file-path-breadcrumb');
    
    // Breadcrumbs
    breadcrumb.innerHTML = breadcrumbStack.map((folder, index) => {
        const isLast = index === breadcrumbStack.length - 1;
        return `
            <div class="flex items-center">
                <span class="${isLast ? 'font-bold text-main' : 'text-brand-500 hover:underline cursor-pointer'}" onclick="${!isLast ? `navigateFolder(${index})` : ''}">
                    ${folder.name || '/'}
                </span>
                ${!isLast ? '<i class="bi bi-chevron-right text-[10px] mx-2 text-muted"></i>' : ''}
            </div>
        `;
    }).join('');

    const itemsToRender = items || (currentFolder && currentFolder.children) || [];
    container.innerHTML = '';

    if (itemsToRender.length === 0) {
        container.innerHTML = '<div class="p-8 text-center text-muted text-sm">Folder is empty</div>';
        return;
    }

    // Sort: Folders first, then files, both alphabetically
    itemsToRender.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
    });

    itemsToRender.forEach(item => {
        const isFolder = item.type === 'folder';
        const iconClass = isFolder ? 'bi-folder-fill text-blue-400' : getIconForFile(item.name);
        const iconColor = isFolder ? '' : getColorForFile(item.name);
        
        const el = document.createElement('div');
        // New List Item Style
        el.className = 'flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors group';
        
        el.innerHTML = `
            <i class="bi ${iconClass} ${iconColor} text-lg"></i>
            <span class="text-sm text-main font-medium truncate flex-1">${item.name}</span>
            <i class="bi bi-chevron-right text-xs text-muted opacity-0 group-hover:opacity-100 transition-opacity"></i>
        `;

        el.onclick = () => {
            if(isFolder) openFolder(item);
            else selectFile(item);
        };
        container.appendChild(el);
    });
}

function openFolder(folder) {
    // Clear search when entering a folder to avoid confusion
    const searchInput = document.getElementById('file-search-input');
    if(searchInput) searchInput.value = "";

    breadcrumbStack.push(folder);
    currentFolder = folder;
    
    // DON'T clear selectedFile when opening folders!
    // Only clear it if we're actually navigating away from the current file context
    // selectedFile = null; // REMOVE THIS LINE
    
    // Load folder contents from API
    const folderPath = folder.path ? folder.path.replace(/^.*\.main_backup\/?/, '') : folder.name;
    loadFolderContents(folderPath);
    // DON'T clear the file preview - keep whatever is currently shown
    // The file preview will persist even when browsing folders
}

function navigateFolder(index) {
    // Clear search when navigating breadcrumbs
    const searchInput = document.getElementById('file-search-input');
    if(searchInput) searchInput.value = "";

    breadcrumbStack = breadcrumbStack.slice(0, index + 1);
    currentFolder = breadcrumbStack[index];
    
    // DON'T clear selectedFile when navigating folders!
    // selectedFile = null; // REMOVE THIS LINE
    
    // Load folder contents from API
    const folderPath = currentFolder.path ? currentFolder.path.replace(/^.*\.main_backup\/?/, '') : currentFolder.name;
    loadFolderContents(folderPath);
    // DON'T clear the file preview - keep whatever is currently shown
}

function resetExplorer() {
    const searchInput = document.getElementById('file-search-input');
    if(searchInput) searchInput.value = "";

    breadcrumbStack = [fileSystem];
    currentFolder = fileSystem;
    
    // DON'T clear selectedFile when resetting!
    // selectedFile = null; // REMOVE THIS LINE
    
    renderExplorer();
    // DON'T clear the file preview - keep whatever is currently shown
}


/**
 * Get bootstrap icon class based on file extension
 */
function getIconForFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        'blend': 'bi-box-fill', 'blend1': 'bi-box-fill',
        'pdf': 'bi-file-earmark-pdf-fill', 
        'doc': 'bi-file-earmark-word-fill', 'docx': 'bi-file-earmark-word-fill',
        'xls': 'bi-file-earmark-excel-fill', 'xlsx': 'bi-file-earmark-excel-fill',
        'ppt': 'bi-file-earmark-slides-fill', 'pptx': 'bi-file-earmark-slides-fill',
        'txt': 'bi-file-earmark-text-fill', 'md': 'bi-file-earmark-text-fill',
        'jpg': 'bi-file-earmark-image-fill', 'jpeg': 'bi-file-earmark-image-fill',
        'png': 'bi-file-earmark-image-fill', 'gif': 'bi-file-earmark-image-fill',
        'zip': 'bi-file-earmark-zip-fill', 'rar': 'bi-file-earmark-zip-fill',
        'mp3': 'bi-file-earmark-music-fill', 'wav': 'bi-file-earmark-music-fill',
        'mp4': 'bi-file-earmark-play-fill', 'avi': 'bi-file-earmark-play-fill',
        'json': 'bi-file-earmark-code-fill', 'js': 'bi-file-earmark-code-fill',
        'py': 'bi-file-earmark-code-fill', 'html': 'bi-file-earmark-code-fill',
        'appimage': 'bi-box2-fill',
    };
    return icons[ext] || 'bi-file-earmark-fill';
}

/**
 * Get color class based on file extension
 */
function getColorForFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const colors = {
        'blend': 'text-amber-600', 'blend1': 'text-amber-600',
        'pdf': 'text-red-500',
        'doc': 'text-blue-500', 'docx': 'text-blue-500',
        'xls': 'text-emerald-600', 'xlsx': 'text-emerald-600',
        'ppt': 'text-orange-500', 'pptx': 'text-orange-500',
        'jpg': 'text-pink-500', 'jpeg': 'text-pink-500', 'png': 'text-pink-500',
        'zip': 'text-purple-500', 'rar': 'text-purple-500',
        'mp3': 'text-purple-500', 'wav': 'text-purple-500',
        'mp4': 'text-red-500', 'avi': 'text-red-500',
        'json': 'text-orange-500', 'js': 'text-yellow-500',
        'py': 'text-blue-600', 'html': 'text-red-600',
        'appimage': 'text-cyan-400',
    };
    return colors[ext] || 'text-gray-500';
}

function selectFile(file) {
    selectedFile = file;
    const preview = document.getElementById('preview-content');

    // ------------------------------------------------------------------
    // ⚠️ NEW LOGIC: CHECK CONNECTION STATUS BEFORE PREVIEW
    // ------------------------------------------------------------------
    if (!isDeviceConnected) {
        // Clear the selected file state
        selectedFile = null; 
        
        // Display the disconnection message in the preview pane
        preview.innerHTML = `
            <div class="p-8 text-center text-muted">
                <i class="bi bi-file-earmark-bar-graph text-3xl mb-3"></i>
                <h4 class="font-bold text-main">Device Disconnected</h4>
                <p class="text-sm mt-1">File preview unavailable until the backup device reconnects.</p>
            </div>`;
        return; // Stop the function here
    }
    // ------------------------------------------------------------------

    // 1. Initial Loading State (Skeleton) 
    preview.innerHTML = `
        <div class="animate-entry h-full flex flex-col">
            <div class="flex items-start gap-4 mb-6 border-b border-main pb-6">
                <div class="w-16 h-16 rounded-2xl bg-gray-50 dark:bg-white/5 flex items-center justify-center text-3xl border border-main shadow-sm">
                    <i class="bi ${file.icon || 'bi-file-earmark-text-fill'} ${file.color || 'text-brand-500'}"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="font-bold text-main text-lg truncate" title="${file.name}">${file.name}</h4>
                    <div class="flex items-center gap-2 mt-1">
                        <span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[10px] font-bold text-muted border border-main uppercase tracking-wider">FILE</span>
                        <span id="preview-size" class="text-xs text-secondary">Loading size...</span>
                    </div>
                    
                    <div class="flex items-center gap-2 mt-1">
                        <span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[10px] font-bold text-muted border border-main uppercase tracking-wider">PATH</span>
                        <span id="preview-path" class="text-xs text-secondary">Checking file path...</span>
                    </div>

                    <div class="flex items-center gap-2 mt-1">
                        <span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[10px] font-bold text-muted border border-main uppercase tracking-wider">EXIST</span>
                        <span id="preview-exist" class="text-xs text-secondary">Checking file existence...</span>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-3 mb-6">
                <button id="btn-open-current" class="btn-normal flex items-center justify-center gap-2 py-2">
                    <i class="bi bi-eye-fill"></i> Open
                </button>
                <button id="btn-loc-current" class="btn-normal flex items-center justify-center gap-2 py-2">
                    <i class="bi bi-folder-fill"></i> Location
                </button>
            </div>

            <div class="flex-1 flex flex-col min-h-0">
                <div class="flex items-center justify-between mb-3">
                    <p class="text-xs font-bold text-muted uppercase tracking-wider">Version History</p>
                    <span class="text-[10px] text-brand-500 font-medium bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full">Time Machine</span>
                </div>
                
                <div id="preview-versions-list" class="flex-1 overflow-y-auto space-y-3 pr-1 no-scrollbar pb-4">
                    <div class="text-center py-8 text-muted">
                        <i class="bi bi-arrow-clockwise animate-spin text-xl"></i>
                        <p class="text-xs mt-2">Fetching versions...</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 2. Fetch File Info (Size)
    // This fetch only runs if the device is connected
    const filePath = file.path || file.name;
    
    // Send file path to backend to get size
    fetch('/api/file-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: filePath })
    })
    .then(res => res.json())
    .then(data => {
        const sizeEl = document.getElementById('preview-size');
        const pathEl = document.getElementById('preview-path');
        const existEl = document.getElementById('preview-exist');
        
        if (sizeEl) {
            if (data.success && data.size) {
                sizeEl.innerText = Utils.formatBytes(data.size) || 'Size unknown';
                pathEl.innerText = data.home_path || 'Path unknown';

                // Check file existence
                const fileExists = data.exists === true;
                existEl.innerText = fileExists ? 'FOUND' : 'NOT FOUND';
                existEl.className = fileExists ? 
                    'text-xs text-emerald-500 font-bold' : 
                    'text-xs text-red-500 font-bold';

                // Get the buttons
                const openBtn = document.getElementById('btn-open-current');
                const locBtn = document.getElementById('btn-loc-current');
                
                if (fileExists) {
                    // File exists - enable Open button
                    if (openBtn) {
                        openBtn.disabled = false;
                        // Remove any existing cursor styles and add pointer
                        openBtn.className = "btn-normal flex items-center justify-center gap-2 py-2 hover:bg-gray-100 dark:hover:bg-white/10";
                        // Add cursor-pointer back explicitly
                        openBtn.style.cursor = "pointer";
                        openBtn.onclick = () => openFile(data.home_path);
                    }
                    
                    if (locBtn) {
                        locBtn.disabled = false;
                        locBtn.className = "btn-normal flex items-center justify-center gap-2 py-2 hover:bg-gray-100 dark:hover:bg-white/10";
                        locBtn.style.cursor = "pointer";
                        locBtn.onclick = () => openLocation(data.home_path);
                    }
                } else {
                    // File does NOT exist - disable Open button
                    if (openBtn) {
                        openBtn.disabled = true;
                        // Override the cursor from .btn-normal class with inline style
                        openBtn.style.cursor = "not-allowed";
                        // Use a custom class that overrides .btn-normal's cursor
                        openBtn.className = "btn-normal flex items-center justify-center gap-2 py-2 opacity-50 select-none cursor-not-allowed";
                        openBtn.onclick = null;
                        
                        // Add tooltip or visual indicator
                        openBtn.title = "File not found in home directory";
                        
                        // Update button text to indicate disabled state
                        const icon = openBtn.querySelector('i');
                        if (icon) {
                            icon.className = "bi bi-eye-slash-fill text-gray-400";
                        }
                        const textSpan = openBtn.querySelector('span');
                        if (textSpan) {
                            textSpan.textContent = "File Not Found";
                        }
                    }
                    
                    // Location button can still work even if file doesn't exist
                    if (locBtn) {
                        locBtn.disabled = false;
                        locBtn.className = "btn-normal flex items-center justify-center gap-2 py-2 hover:bg-gray-100 dark:hover:bg-white/10";
                        locBtn.style.cursor = "pointer";
                        locBtn.onclick = () => openLocation(data.home_path);
                    }
                }
            }
        }
    }).catch(err => {
        console.error('Failed to get file size:', err);
    });


    // 3. Fetch Versions
    // This fetch only runs if the device is connected
    fetch(`/api/file-versions?file_path=${encodeURIComponent(filePath)}`)
        .then(res => res.json())
        .then(data => {
            const container = document.getElementById('preview-versions-list');
            if(!container) return;
            
            container.innerHTML = '';

            if (!data.success || !data.versions || data.versions.length === 0) {
                container.innerHTML = `
                    <div class="p-4 rounded-xl border border-dashed border-main text-center bg-gray-50 dark:bg-white/5">
                        <p class="text-xs text-muted">No history found for this file.</p>
                    </div>`;
                return;
            }

            // Render Versions
            data.versions.forEach((v, idx) => {
                const isMain = v.key === 'main';
                const sizeStr = v.size ? Utils.formatBytes(v.size) : 'Unknown';
                const timeStr = v.time || 'Unknown Date';
                const pathStr = v.path || 'Unknown Path';
                
                const card = document.createElement('div');
                card.className = "bg-card border border-main rounded-xl p-3 hover:border-brand-500 transition-all duration-200 group relative";
                
                card.innerHTML = `
                    <div class="flex justify-between items-start mb-3">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg ${isMain ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-500' : 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-500'} flex items-center justify-center text-sm font-bold border border-black/5">
                                ${isMain ? '<i class="bi bi-star-fill text-[10px]"></i>' : idx + 1}
                            </div>
                            <div>
                                <p class="text-xs font-bold text-main leading-tight">${timeStr}</p>
                                <p class="text-[10px] text-muted font-mono mt-0.5">${pathStr}</p>
                            </div>
                        </div>
                        ${isMain ? '<span class="text-[10px] font-bold text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded">ORIGINAL</span>' : ''}
                    </div>

                    <div class="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-main">
                        <button class="btn-version-action hover:bg-gray-100 dark:hover:bg-white/10 text-main cursor-pointer" onclick="openFile('${v.path.replace(/\\/g, '\\\\')}')">
                            <i class="bi bi-eye-fill"></i> Open
                        </button>
                        <button class="btn-version-action hover:bg-gray-100 dark:hover:bg-white/10 text-main cursor-pointer" onclick="openLocation('${v.path.replace(/\\/g, '\\\\')}')">
                            <i class="bi bi-folder-fill"></i> Location
                        </button>
                        <button class="btn-version-action text-brand-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 dark:text-blue-400 cursor-pointer" onclick="restoreFile(this)" data-filepath="${v.path.replace(/\\/g, '\\\\')}">
                            <i class="bi bi-arrow-counterclockwise"></i> Restore
                        </button>
                    </div>
                `;
                container.appendChild(card);
            });
        })
        .catch(err => {
            console.error(err);
            const container = document.getElementById('preview-versions-list');
            if(container) container.innerHTML = '<p class="text-xs text-red-500">Failed to load history.</p>';
        });
}

function searchFiles() {
    const query = document.getElementById('file-search-input').value.toLowerCase();
    const container = document.getElementById('file-list-container');
    
    // If search is cleared, show folder view
    if (query.length === 0) return renderExplorer();

    // Show loading state
    container.innerHTML = `
        <div class="flex items-center gap-2 text-slate-100">
            <i class="bi bi-arrow-clockwise animate-spin"></i>
            <span>Searching...</span>
        </div>`;

    // Fetch search results from backend
    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            if (!data.files || data.files.length === 0) {
                container.innerHTML = '<p class="p-4 text-gray-400">No files found matching your search.</p>';
                return;
            }

            // Convert backend file results to displayable items
            const results = data.files.map(file => ({
                name: file.name,
                path: file.path,
                search_display_path: file.search_display_path,
                type: 'file',
                icon: getIconForFile(file.name),
                color: getColorForFile(file.name)
            }));

            renderExplorer(results);
        })
        .catch(err => {
            console.error('Search failed:', err);
            container.innerHTML = '<p class="p-4 text-red-500">Search failed. Please try again.</p>';
        });
}

/**
 * Get bootstrap icon class based on file extension
 */
function getIconForFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        'blend': 'bi-box-fill', 'blend1': 'bi-box-fill',
        'pdf': 'bi-file-earmark-pdf-fill',
        'doc': 'bi-file-earmark-word-fill', 'docx': 'bi-file-earmark-word-fill',
        'xls': 'bi-file-earmark-excel-fill', 'xlsx': 'bi-file-earmark-excel-fill',
        'ppt': 'bi-file-earmark-slides-fill', 'pptx': 'bi-file-earmark-slides-fill',
        'txt': 'bi-file-earmark-text-fill', 'md': 'bi-file-earmark-text-fill',
        'jpg': 'bi-file-earmark-image-fill', 'jpeg': 'bi-file-earmark-image-fill',
        'png': 'bi-file-earmark-image-fill', 'gif': 'bi-file-earmark-image-fill',
        'zip': 'bi-file-earmark-zip-fill', 'rar': 'bi-file-earmark-zip-fill',
        'mp3': 'bi-file-earmark-music-fill', 'wav': 'bi-file-earmark-music-fill',
        'mp4': 'bi-file-earmark-play-fill', 'avi': 'bi-file-earmark-play-fill',
        'json': 'bi-file-earmark-code-fill', 'js': 'bi-file-earmark-code-fill',
        'py': 'bi-file-earmark-code-fill', 'html': 'bi-file-earmark-code-fill'
    };
    return icons[ext] || 'bi-file-earmark-fill';
}

/**
 * Get color class based on file extension
 */
function getColorForFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const colors = {
        'blend': 'text-amber-600', 'blend1': 'text-amber-600',
        'pdf': 'text-red-500',
        'doc': 'text-blue-500', 'docx': 'text-blue-500',
        'xls': 'text-emerald-600', 'xlsx': 'text-emerald-600',
        'ppt': 'text-orange-500', 'pptx': 'text-orange-500',
        'jpg': 'text-pink-500', 'jpeg': 'text-pink-500', 'png': 'text-pink-500',
        'zip': 'text-purple-500', 'rar': 'text-purple-500',
        'mp3': 'text-purple-500', 'wav': 'text-purple-500',
        'mp4': 'text-red-500', 'avi': 'text-red-500',
        'json': 'text-orange-500', 'js': 'text-yellow-500',
        'py': 'text-blue-600', 'html': 'text-red-600'
    };
    return colors[ext] || 'text-gray-500';
}

function renderFilePreview(file) {
    const nameEl = document.getElementById('preview-file-name');
    const contentEl = document.getElementById('preview-content');

    if (!file) {
        nameEl.innerText = "Select a file to view history";
        contentEl.className = "p-6 bg-gray-50 dark:bg-slate-700 flex-1 flex items-center justify-center text-gray-400 text-main text-sm";
        contentEl.innerHTML = '<p>No file selected.</p>';
        return;
    }

    nameEl.innerText = file.name;
    contentEl.className = "p-6 flex-1 space-y-4 no-scrollbar overflow-y-auto";

    // Construct the path to the current file in the user's home directory
    let currentFilePath = '';
    
    if (file.path) {
        // If file has a path, extract relative path from backup and map to home
        const backupPath = file.path;
        if (backupPath.includes('.main_backup')) {
            // Extract path relative to .main_backup
            const relativePath = backupPath.split('.main_backup')[1].replace(/^[\\/]+/, '');
            // We'll get the actual home path from the backend when needed
            currentFilePath = relativePath;
        } else {
            // For search results or other paths, use the file name directly
            currentFilePath = file.name;
        }
    } else if (file.search_display_path) {
        // For search results with display path
        const searchPath = file.search_display_path;
        if (searchPath.includes('.main_backup')) {
            const relativePath = searchPath.split('.main_backup')[1].replace(/^[\\/]+/, '');
            currentFilePath = relativePath;
        } else {
            currentFilePath = file.name;
        }
    } else {
        // Fallback: just use the file name
        currentFilePath = file.name;
    }

    // Normalize path separators
    currentFilePath = currentFilePath.replace(/\\/g, '/');

    contentEl.innerHTML = `
        <div class="mb-4 border-b border-gray-200 dark:border-slate-600 pb-4">
            <div class="flex items-center gap-2 mb-2">
                <i class="bi bi-clock text-blue"></i>
                <span class="text-sm font-bold text-blue">Current File (Latest)</span>
            </div>
            <div class="p-4 rounded-lg bg-card flex items-center justify-between">
                <div class="flex items-center gap-4">
                    <i class="bi ${file.icon} text-2xl ${file.color}"></i>
                    <div>
                        <p class="text-xs text-main font-bold">${file.name}</p>
                        <p id="preview-current-size" class="text-xs text-secondary">Size: Loading...</p>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button id="preview-open-btn" class="btn-normal text-secondary"><i class="bi bi-eye-fill mr-1"></i> Open</button>
                    <button id="preview-open-location-btn" class="btn-normal text-secondary"><i class="bi bi-geo-alt-fill mr-1"></i> Open Location</button>
                </div>
            </div>
        </div>

        <div class="space-y-4 pr-2">
            <div class="flex items-center gap-2 mb-2">
                <i class="bi bi-clock-history text-main"></i>
                <span class="font-bold text-sm text-main">Backup Versions</span>
            </div>

            <div id="preview-versions-container" class="space-y-4">
                <div class="p-4 text-slate-500"><i class="bi bi-arrow-clockwise animate-spin mr-2"></i> Loading versions...</div>
            </div>
        </div>
    `;

    // Fetch and render backup versions (excluding current home file)
    (async () => {
        const versionsContainer = document.getElementById('preview-versions-container');
        if (!versionsContainer) return;
        try {
            const filePath = file.path || file.search_display_path || file.name;
            const resp = await fetch(`/api/file-versions?file_path=${encodeURIComponent(filePath)}`);
            const json = await resp.json();

            if (!json || !json.success || !Array.isArray(json.versions) || json.versions.length === 0) {
                versionsContainer.innerHTML = '<p class="p-4 text-gray-400">No previous versions found.</p>';
                return;
            }

            // Separate main backup (initial) from other versions
            const mainVersionIndex = json.versions.findIndex(v => v.key === 'main');
            let mainVersion = null;
            let incremental = json.versions.slice();
            if (mainVersionIndex !== -1) {
                mainVersion = incremental.splice(mainVersionIndex, 1)[0];
            }

            // Render incremental versions (already sorted newest-first by backend)
            versionsContainer.innerHTML = '';
            const formatSize = (size) => { try { return Utils.formatBytes(size); } catch (e) { return `${size} B`; } };

            if (incremental.length === 0 && !mainVersion) {
                versionsContainer.innerHTML = '<p class="p-4 text-gray-400">No previous versions found.</p>';
                return;
            }

            incremental.forEach(v => {
                const displayTime = formatVersionTime(v.time || v.key || 'Backup');
                const displaySize = v.size ? formatSize(v.size) : 'Unknown size';

                const versionEl = document.createElement('div');
                versionEl.className = 'p-4 bg-card border rounded-lg flex items-center justify-between';

                const left = document.createElement('div');
                left.innerHTML = `<p class="text-xs text-main font-bold">${displayTime}</p><p class="text-xs text-secondary">Size: ${displaySize}</p>`;

                const right = document.createElement('div');
                right.className = 'flex gap-2';

                const openBtn = document.createElement('button');
                openBtn.className = 'btn-normal boder-main text-secondary border';
                openBtn.innerHTML = '<i class="bi bi-eye-fill"></i> Open';
                openBtn.onclick = () => openFile(v.path);

                const locBtn = document.createElement('button');
                locBtn.className = 'btn-normal boder-main text-secondary border';
                locBtn.innerHTML = '<i class="bi bi-geo-alt-fill"></i> Open Location';
                locBtn.onclick = () => openLocation(v.path);

                const restoreBtn = document.createElement('button');
                restoreBtn.className = 'btn-normal text-hyperlink';
                restoreBtn.innerHTML = '<i class="bi bi-download"></i> Restore File';
                restoreBtn.onclick = () => restoreFile(restoreBtn);
                restoreBtn.dataset.filepath = v.path;

                right.appendChild(openBtn);
                right.appendChild(locBtn);
                right.appendChild(restoreBtn);

                versionEl.appendChild(left);
                versionEl.appendChild(right);
                versionsContainer.appendChild(versionEl);
            });

            // Finally render the main backup as the last (Initial Backup)
            if (mainVersion) {
                const displayTime = formatVersionTime(mainVersion.time || 'Initial Backup');
                const displaySize = mainVersion.size ? formatSize(mainVersion.size) : 'Unknown size';

                const versionEl = document.createElement('div');
                versionEl.className = 'p-4 bg-card rounded-lg flex items-center justify-between';

                const left = document.createElement('div');
                left.innerHTML = `<p class="text-xs text-main font-bold">${displayTime} <span class="text-orange-500 ml-2 text-[11px] font-semibold">Initial Backup</span></p><p class="text-xs text-secondary">Size: ${displaySize}</p>`;

                const right = document.createElement('div');
                right.className = 'flex gap-2';

                const openBtn = document.createElement('button');
                openBtn.className = 'btn-normal text-secondary';
                openBtn.innerHTML = '<i class="bi bi-eye-fill"></i> Open';
                openBtn.onclick = () => openFile(mainVersion.path);

                const locBtn = document.createElement('button');
                locBtn.className = 'btn-normal text-secondary';
                locBtn.innerHTML = '<i class="bi bi-geo-alt-fill"></i> Open Location';
                locBtn.onclick = () => openLocation(mainVersion.path);

                const restoreBtn = document.createElement('button');
                restoreBtn.className = 'btn-normal text-hyperlink';
                restoreBtn.innerHTML = '<i class="bi bi-download"></i> Restore File';
                restoreBtn.onclick = () => restoreFile(restoreBtn);
                restoreBtn.dataset.filepath = mainVersion.path;

                right.appendChild(openBtn);
                right.appendChild(locBtn);
                right.appendChild(restoreBtn);

                versionEl.appendChild(left);
                versionEl.appendChild(right);
                versionsContainer.appendChild(versionEl);
            }

        } catch (err) {
            console.error('Failed to load file versions:', err);
            versionsContainer.innerHTML = '<p class="p-4 text-red-500">Failed to load versions.</p>';
        }
    })();
}

// Helper function to get user's home directory from backend
function getHomeDirectory() {
    return fetch('/api/backup/usage')
        .then(response => response.json())
        .then(data => {
            if (data.success && data.users_home_path) {
                return data.users_home_path;
            } else {
                throw new Error('Could not get home directory from backend');
            }
        });
}

/**
 * Try to parse backend time strings into a human label.
 * Examples input: "13-11-2025 10:53", "2025-11-27 17:04", "Nov 18, 14:30", "27-11-2025 17-04"
 */
function formatVersionTime(raw) {
    if (!raw) return 'Unknown';
    try {
        let s = String(raw).trim();
        s = s.replace(/_/g, ':');

        // If already has month name, try Date.parse
        if (/^[A-Za-z]/.test(s)) {
            const d = new Date(s);
            if (!isNaN(d)) return humanLabel(d);
        }

        // Split into date and time
        const parts = s.split(' ');
        const datePart = parts[0];
        const timePart = parts[1] || '00:00';

        const dateTokens = datePart.split('-');
        let year, month, day;
        if (dateTokens.length === 3) {
            if (dateTokens[0].length === 4) {
                // YYYY-MM-DD
                year = dateTokens[0]; month = dateTokens[1]; day = dateTokens[2];
            } else {
                // DD-MM-YYYY
                day = dateTokens[0]; month = dateTokens[1]; year = dateTokens[2];
            }
        } else if (datePart.includes('/')) {
            const dt = new Date(datePart);
            if (!isNaN(dt)) return humanLabel(dt);
        } else {
            // Fallback: try Date.parse
            const dt = new Date(s);
            if (!isNaN(dt)) return humanLabel(dt);
        }

        // Normalize to ISO
        month = String(month).padStart(2, '0');
        day = String(day).padStart(2, '0');
        const iso = `${year}-${month}-${day}T${timePart}`;
        const dt = new Date(iso);
        if (isNaN(dt)) return raw;
        return humanLabel(dt);
    } catch (e) {
        return raw;
    }

    function humanLabel(dt) {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffDays = Math.floor((startOfToday - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())) / 86400000);
        const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
        const formatted = dt.toLocaleString('en-US', opts).replace(',', '');
        if (diffDays === 0) return `Today (${formatted})`;
        if (diffDays === -1) return `Tomorrow (${formatted})`;
        if (diffDays === 1) return `Yesterday (${formatted})`;
        return `${formatted}`;
    }
}

// Open file in system via backend
function openFile(path) {
    if (!path) return;
    fetch('/api/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: path })
    }).then(res => res.json()).then(j => {
        if (!j || !j.success) console.warn('Open file failed', j);
    }).catch(err => console.error('Open file error', err));
}

// Open location (folder) via backend
function openLocation(path) {
    if (!path) return;
    fetch('/api/open-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: path })
    }).then(res => res.json()).then(j => {
        if (!j || !j.success) console.warn('Open location failed', j);
    }).catch(err => console.error('Open location error', err));
}

function restoreFile(buttonElement) {
    if (buttonElement.disabled) return;
    
    const filePath = buttonElement.dataset.filepath;
    const fileName = filePath.split('/').pop() || 'file';
    
    if (!filePath) {
        console.warn("No file path provided for restoration.");
        return;
    }

    // Store original button state
    const originalHTML = buttonElement.innerHTML;
    const originalClass = buttonElement.className;
    const originalOnClick = buttonElement.onclick;
    
    // Create progress container that replaces the button
    const progressContainer = document.createElement('div');
    progressContainer.className = 'w-full flex flex-col gap-2';
    
    // Progress bar container
    const progressBarContainer = document.createElement('div');
    progressBarContainer.className = 'w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden';
    
    // Progress bar fill
    const progressBarFill = document.createElement('div');
    progressBarFill.className = 'bg-brand-500 h-full rounded-full transition-all duration-300';
    progressBarFill.style.width = '0%';
    
    progressBarContainer.appendChild(progressBarFill);
    
    // Status text
    const statusText = document.createElement('div');
    statusText.className = 'flex items-center justify-between text-xs';
    statusText.innerHTML = `
        <span class="text-main font-medium">Restoring ${fileName}...</span>
        <span class="text-muted" id="progress-percent">0%</span>
    `;
    
    progressContainer.appendChild(progressBarContainer);
    progressContainer.appendChild(statusText);
    
    // Cancel button
    const cancelButton = document.createElement('button');
    cancelButton.innerHTML = '<i class="bi bi-x mr-1"></i> Cancel';
    cancelButton.className = 'text-xs text-red-500 hover:text-red-700 mt-1 self-end';
    cancelButton.onclick = (e) => {
        e.stopPropagation();
        cancelled = true;
        restoreButton.disabled = false;
        restoreButton.innerHTML = '<i class="bi bi-download"></i> Restore File';
        restoreButton.className = 'btn-normal text-hyperlink';
        buttonElement.parentNode.replaceChild(restoreButton, progressContainer);
        showSystemNotification('info', 'Restoration Cancelled', 'File restoration was cancelled.');
    };
    
    progressContainer.appendChild(cancelButton);
    
    // Create a new restore button element to replace later
    const restoreButton = document.createElement('button');
    restoreButton.innerHTML = originalHTML;
    restoreButton.className = originalClass;
    restoreButton.onclick = originalOnClick;
    restoreButton.disabled = true;
    
    // Replace button with progress container
    buttonElement.parentNode.replaceChild(progressContainer, buttonElement);
    
    let cancelled = false;
    let progressInterval;
    
    // Function to update progress
    const updateProgress = (percent, message) => {
        progressBarFill.style.width = `${percent}%`;
        const percentElement = document.getElementById('progress-percent');
        if (percentElement) {
            percentElement.textContent = `${percent}%`;
        }
        
        if (statusText.querySelector('span:first-child')) {
            statusText.querySelector('span:first-child').textContent = message || `Restoring ${fileName}...`;
        }
    };
    
    // Simulate progress (initial phase - preparing)
    updateProgress(10, 'Preparing restoration...');
    
    // Start progress simulation (will be replaced by real progress from backend)
    let simulatedProgress = 10;
    progressInterval = setInterval(() => {
        if (cancelled) {
            clearInterval(progressInterval);
            return;
        }
        
        simulatedProgress += Math.random() * 5;
        if (simulatedProgress > 90) {
            simulatedProgress = 90; // Hold at 90% until API call completes
        }
        
        const messages = [
            'Preparing restoration...',
            'Connecting to backup...',
            'Locating file versions...',
            'Preparing destination...',
            'Copying file data...'
        ];
        
        const messageIndex = Math.floor((simulatedProgress / 90) * (messages.length - 1));
        updateProgress(Math.floor(simulatedProgress), messages[messageIndex]);
    }, 500);
    
    // Make API call to backend
    fetch('/api/restore-file', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: filePath })
    })
    .then(response => {
        if (cancelled) {
            throw new Error('Cancelled by user');
        }
        
        // Check if response is okay before parsing JSON
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        return response.json();
    })
    .then(data => {
        clearInterval(progressInterval);
        
        if (cancelled) {
            progressContainer.parentNode.replaceChild(restoreButton, progressContainer);
            return;
        }
        
        if (data && data.success) {
            // Final progress update
            updateProgress(100, 'Restoration complete!');
            
            // Show success state for 2 seconds
            setTimeout(() => {
                progressBarFill.className = 'bg-green-500 h-full rounded-full transition-all duration-300';
                statusText.innerHTML = `
                    <span class="text-green-600 font-medium flex items-center gap-1">
                        <i class="bi bi-check-circle"></i> Successfully restored!
                    </span>
                    <span class="text-green-600" id="progress-percent">100%</span>
                `;
                
                // Remove cancel button
                if (cancelButton.parentNode) {
                    cancelButton.remove();
                }
                
                // Show success notification
                showSystemNotification('success', 'File Restored', 
                    data.message || `"${fileName}" has been restored successfully.`);
                
                // Replace progress container with original button after 3 seconds
                setTimeout(() => {
                    // Create success state button
                    const successButton = document.createElement('button');
                    successButton.innerHTML = '<i class="bi bi-check-lg mr-2"></i> Restored!';
                    successButton.className = 'px-3 py-1.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400 rounded text-xs font-bold cursor-default flex items-center gap-2';
                    
                    progressContainer.parentNode.replaceChild(successButton, progressContainer);
                    
                    // Reset to original button after 5 seconds
                    setTimeout(() => {
                        restoreButton.disabled = false;
                        successButton.parentNode.replaceChild(restoreButton, successButton);
                    }, 5000);
                }, 2000);
            }, 500);
            
        } else {
            // Error State
            clearInterval(progressInterval);
            const errorMsg = data ? data.error : 'Unknown error occurred';
            
            progressBarFill.className = 'bg-red-500 h-full rounded-full transition-all duration-300';
            updateProgress(100, 'Restoration failed');
            
            statusText.innerHTML = `
                <span class="text-red-600 font-medium flex items-center gap-1">
                    <i class="bi bi-x-circle"></i> Failed to restore
                </span>
                <span class="text-red-600" id="progress-percent">Error</span>
            `;
            
            // Remove cancel button
            if (cancelButton.parentNode) {
                cancelButton.remove();
            }
            
            showSystemNotification('error', 'Restoration Failed', errorMsg);
            
            // Replace with error button after 3 seconds
            setTimeout(() => {
                const errorButton = document.createElement('button');
                errorButton.innerHTML = '<i class="bi bi-x-circle mr-2"></i> Failed';
                errorButton.className = 'px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded text-xs font-bold cursor-default flex items-center gap-2';
                
                progressContainer.parentNode.replaceChild(errorButton, progressContainer);
                
                // Reset to original button after 5 seconds
                setTimeout(() => {
                    restoreButton.disabled = false;
                    errorButton.parentNode.replaceChild(restoreButton, errorButton);
                }, 5000);
            }, 3000);
        }
    })
    .catch(error => {
        clearInterval(progressInterval);
        
        if (cancelled) {
            progressContainer.parentNode.replaceChild(restoreButton, progressContainer);
            return;
        }
        
        // Network Error State
        progressBarFill.className = 'bg-red-500 h-full rounded-full transition-all duration-300';
        updateProgress(100, 'Network error');
        
        statusText.innerHTML = `
            <span class="text-red-600 font-medium flex items-center gap-1">
                <i class="bi bi-wifi-off"></i> Connection failed
            </span>
            <span class="text-red-600" id="progress-percent">Error</span>
        `;
        
        // Remove cancel button
        if (cancelButton.parentNode) {
            cancelButton.remove();
        }
        
        showSystemNotification('error', 'Network Error', 'Could not connect to server. Please check your connection.');
        
        // Replace with error button after 3 seconds
        setTimeout(() => {
            const errorButton = document.createElement('button');
            errorButton.innerHTML = '<i class="bi bi-wifi-off mr-2"></i> Network Error';
            errorButton.className = 'px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded text-xs font-bold cursor-default flex items-center gap-2';
            
            progressContainer.parentNode.replaceChild(errorButton, progressContainer);
            
            // Reset to original button after 5 seconds
            setTimeout(() => {
                restoreButton.disabled = false;
                errorButton.parentNode.replaceChild(restoreButton, errorButton);
            }, 5000);
        }, 3000);
    });
}

function switchSettingsTab(tabName) {
    activeSettingsTab = tabName;
    ['folders', 'general'].forEach(t => {
        const btn = document.getElementById(`sub-tab-btn-${t}`);
        const content = document.getElementById(`settings-tab-${t}`);
        if (t === tabName) {
            btn.className = "px-4 py-2 text-sm font-bold text-sm font-bold text-hyperlink border-b-2 cursor-pointer border-hyperlink";
            content.classList.remove('hidden');
        } else {
            btn.className = "px-4 py-2 text-sm font-bold text-secondary border-b-2 border-transparent hover:text-secondary hover:text-secondary cursor-pointer";
            content.classList.add('hidden');
        }
    });
}

/**
 * Triggers the confirmation modal before saving settings (watched folders).
 */
function initiateSettingsSave() {
    const count = homeFolders.filter(f => f.selected).length;
    
    openConfirmationModal(
        "Update Watched Folders?",
        // Improved confirmation message:
        `You are about to set <span class="font-bold text-slate-800">${count} folder${count !== 1 ? 's' : ''}</span> for continuous, real-time backup. Are you sure?`, 
        // This is the callback function that runs on CONFIRM:
        () => { 
            showSystemNotification(
                'info', 
                'Backup Settings Saved', 
                `${count} folder${count !== 1 ? 's have' : ' has'} been set for real-time backup.`
            );
            // Optionally add other save logic here (e.g., calling a backend save function)
        } 
    );
}


// =====================================================================
// --- GENERAL SETTINGS LOGIC ---
// =====================================================================

function toggleGeneralSetting(settingKey) {
    switch(settingKey) {
        case 'startup':
            generalSettings.autoStartup = document.getElementById('chk-auto-startup').checked;
            
            // Launch daemon script to start backup immediately now and on startup
            // Note: We don't need a file_path parameter for starting the daemon
            fetch('/api/daemon/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    auto_startup: generalSettings.autoStartup 
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showSystemNotification('success', 'Time Machine Settings', 
                        generalSettings.autoStartup ? 
                        'Time Machine will start automatically on system startup' : 
                        'Time Machine automatic startup disabled');
                } else {
                    console.error('Failed to update daemon startup settings:', data.error);
                    // Revert the checkbox on error
                    document.getElementById('chk-auto-startup').checked = !generalSettings.autoStartup;
                    generalSettings.autoStartup = !generalSettings.autoStartup;
                    showSystemNotification('error', 'Time Machine Settings', 
                        'Failed to update startup settings: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(error => {
                console.error('Network error:', error);
                // Revert the checkbox on error
                document.getElementById('chk-auto-startup').checked = !generalSettings.autoStartup;
                generalSettings.autoStartup = !generalSettings.autoStartup;
                showSystemNotification('error', 'Network Error', 
                    'Could not connect to server. Please check your connection.');
            });
            break;
            
        case 'updates':
            generalSettings.autoUpdates = document.getElementById('chk-auto-updates').checked;
            // Save to localStorage or backend
            // saveGeneralSettings();
            break;
            
        case 'notifications':
            generalSettings.showNotifications = document.getElementById('chk-show-notifications').checked;
            // Save to localStorage or backend
            // saveGeneralSettings();
            break;
    }
    console.log('General settings updated:', generalSettings);
}

// Add this function to save general settings
function saveGeneralSettings() {
    const saveBtn = document.querySelector('button[onclick="saveGeneralSettings()"]');
    if (!saveBtn) return;
    
    const originalText = saveBtn.innerHTML;
    saveBtn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin"></i> Saving...';
    saveBtn.disabled = true;
    
    setTimeout(() => {
        try {
            // Save to localStorage
            localStorage.setItem('timeMachine_generalSettings', JSON.stringify(generalSettings));
            
            showSystemNotification('success', 'Settings Saved', 'General preferences have been saved successfully.');
            console.log('General settings saved:', generalSettings);
        } catch (error) {
            showSystemNotification('error', 'Save Failed', 'Could not save settings. Please try again.');
        } finally {
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = false;
        }
    }, 800);
}

// Add this function to load saved settings
function loadGeneralSettings() {
    try {
        const saved = localStorage.getItem('timeMachine_generalSettings');
        if (saved) {
            const parsed = JSON.parse(saved);
            generalSettings = { ...generalSettings, ...parsed };
            
            // Update checkboxes if they exist
            const startupCheckbox = document.getElementById('chk-auto-startup');
            const updatesCheckbox = document.getElementById('chk-auto-updates');
            const notificationsCheckbox = document.getElementById('chk-show-notifications');
            
            if (startupCheckbox) startupCheckbox.checked = generalSettings.autoStartup;
            if (updatesCheckbox) updatesCheckbox.checked = generalSettings.autoUpdates;
            if (notificationsCheckbox) notificationsCheckbox.checked = generalSettings.showNotifications;
        }
    } catch (error) {
        console.log('No saved general settings found, using defaults.');
    }
}

function renderSettings() {
    const container = document.getElementById('folder-selection-list');
    if (!container) return;

    // Show loading
    container.innerHTML = '<div class="p-4 text-center text-slate-500">Scanning home folders...</div>';

    fetch('/api/backup-folders')
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                container.innerHTML = `<div class="p-4 text-red-500">${data.error}</div>`;
                return;
            }

            homeFolders = data.folders; // Update global array
            renderFolderList();        // Render the UI based on new data
            updateSummaryText();       // Update the count
            loadGeneralSettings();     // Load general settings
        })
        .catch(err => {
            container.innerHTML = '<div class="p-4 text-red-500">Failed to load folders from server.</div>';
        });
}


// **********************************************
// 2. REQUIRED SUPPORT FUNCTIONS (Implement or verify existence)
// **********************************************

// Required to update in-memory state when a checkbox is clicked
function toggleFolder(index) {
    if (homeFolders[index]) {
        homeFolders[index].selected = !homeFolders[index].selected;
        updateSummaryText();
    }
}

// Required to send the selection to the backend
function initiateSettingsSave() {
    // Filter only the paths that have 'selected: true'
    const selectedPaths = homeFolders.filter(f => f.selected).map(f => f.path);
    
    fetch('/api/backup-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: selectedPaths })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            // Assuming showSystemNotification exists
            showSystemNotification('success', 'Saved', 'Backup configuration updated.');
        } else {
            showSystemNotification('error', 'Error', data.error);
        }
    })
    .catch(err => {
        showSystemNotification('error', 'Error', 'Network request failed.');
    });
}

// Backup
// function updateSummaryText() {
//     const count = homeFolders.filter(f => f.selected).length;
//     const el = document.getElementById('backup-summary-text');
//     if(el) el.innerText = `${count} folder(s) selected`;
// }

function updateSummaryText() {
    const count = homeFolders.filter(f => f.selected).length;
    const el = document.getElementById('backup-summary-text');
    if(el) el.innerText = `${count} folders selected for monitoring`;
}

function toggleAllFolders(state) {
    if (!Array.isArray(homeFolders)) return;

    // 1. Loop through the global array and update the state
    homeFolders.forEach(folder => {
        folder.selected = state;
    });

    // 2. Re-render the list to update the visual state of the checkboxes
    renderFolderList();

    // 3. Update the visible count
    updateSummaryText();
}


// =====================================================================
// --- SETTINGS (Pure Gray Style) ---
// =====================================================================
// Backup
// function renderFolderList() {
//     const container = document.getElementById('folder-selection-list');
//     if (!container) return;

//     container.innerHTML = ''; // Clear previous content

//     if (homeFolders.length === 0) {
//         container.innerHTML = '<div class="p-4 text-center">No folders found.</div>';
//         return;
//     }

//     // Render every folder found in Home
//     homeFolders.forEach((folder, index) => {
//         const isChecked = folder.selected ? 'checked' : '';
        
//         // This is your existing HTML template:
//         container.innerHTML += `
//         <div class="flex items-center justify-between p-4">
//             <div class="flex items-center gap-4">
//                 <div class="w-10 h-10 btn-normal rounded-lg text-hyperlink text-xl flex items-center justify-center">
//                     <i class="bi ${folder.icon}"></i>
//                 </div>
//                 <div>
//                     <h5 class="font-bold text-main text-sm">${folder.name}</h5>
//                     <p class="text-xs text-slate-400 font-mono">${folder.path}</p>
//                 </div>
//             </div>
//             <label class="relative inline-flex items-center cursor-pointer">
//                 <input type="checkbox" class="sr-only peer" onchange="toggleFolder(${index})" ${isChecked}>
//                 <div class="checkbox-normal"></div>
//             </label>
//         </div>`;
//     });
// }

function renderFolderList() {
    const container = document.getElementById('folder-selection-list');
    if (!container) return;
    container.innerHTML = '';
    
    if (homeFolders.length === 0) {
        return;
    }

    homeFolders.forEach((folder, idx) => {
        container.innerHTML += `
            <div class="flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-lg bg-gray-100 dark:bg-white/10 text-main flex items-center justify-center">
                        <i class="bi ${folder.icon || 'bi-folder'}"></i>
                    </div>
                    <div>
                        <h5 class="text-sm font-bold text-main">${folder.name}</h5>
                        <p class="text-xs text-muted font-mono">${folder.path}</p>
                    </div>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" class="sr-only peer" ${folder.selected ? 'checked' : ''} onchange="toggleFolder(${idx})">
                    <div class="checkbox-normal"></div>
                </label>
            </div>
        `;
    });
    updateSummaryText();
}

// =====================================================================
// --- 7. MODALS & CONFIRMATIONS ---
// =====================================================================

function openProModal() { document.getElementById('pro-modal').classList.remove('hidden'); }
function closeProModal() { document.getElementById('pro-modal').classList.add('hidden'); }

let pendingAction = null;
function openConfirmationModal(title, desc, callback) {
    const modal = document.getElementById('confirmation-modal');
    const titleEl = document.getElementById('modal-title');
    const descEl = document.getElementById('modal-desc');
    if (modal && titleEl && descEl) {
        titleEl.innerText = title;
        descEl.innerHTML = desc;
        pendingAction = callback;
        modal.classList.remove('hidden');
    }
}
function closeConfirmModal() { document.getElementById('confirmation-modal').classList.add('hidden'); pendingAction = null; }
function confirmAction() { if (pendingAction) pendingAction(); closeConfirmModal(); }


// =====================================================================
// --- 8. CUSTOM SYSTEM NOTIFICATIONS (Toast Logic) ---
// =====================================================================

/**
 * Shows a custom, non-blocking notification toast at the bottom center.
 * @param {string} type - The type of notification ('success', 'error', 'info').
 * @param {string} title - The main title of the notification.
 * @param {string} message - The detailed message.
 * @param {number} duration - How long to show the notification (in ms). Default is 6000.
 */
function showSystemNotification(type, title, message, duration = 6000) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    let iconClass = '';
    let colorClass = '';

    switch (type) {
        case 'success':
            iconClass = 'bi-check-circle-fill';
            colorClass = 'bg-green-600 text-white';
            break;
        case 'error':
            iconClass = 'bi-x-octagon-fill';
            colorClass = 'bg-red-500 text-white';
            break;
        case 'info':
        default:
            iconClass = 'bi-info-circle-fill';
            colorClass = 'bg-blue-600 text-white';
            break;
    }

    const toast = document.createElement('div');
    // Animate from top-center
    toast.className = `w-80 p-4 rounded-xl shadow-lg flex items-start gap-3 transition-all transform duration-300 pointer-events-auto opacity-0 -translate-y-full ${colorClass}`;
    
    // Structure for the notification content
    toast.innerHTML = `
        <i class="bi ${iconClass} text-xl flex-shrink-0"></i>
        <div class="flex-grow">
            <h5 class="font-bold text-sm">${title}</h5>
            <p class="text-xs opacity-90">${message}</p>
        </div>
    `;

    // 1. Append to container
    container.appendChild(toast);

    // 2. Force reflow and then animate in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.remove('opacity-0', '-translate-y-full'); 
            toast.classList.add('opacity-100', 'translate-y-0');     
        });
    });

    // 3. Auto-hide after duration
    setTimeout(() => {
        // Animate out (Slide UP)
        toast.classList.remove('opacity-100', 'translate-y-0');   
        toast.classList.add('opacity-0', '-translate-y-full');    

        // Remove from DOM after animation completes (300ms)
        setTimeout(() => {
            if (container.contains(toast)) {
                container.removeChild(toast);
            }
        }, 300);
    }, duration);
}


// =====================================================================
// --- THEME LOGIC ---
// =====================================================================
// Backup
// function toggleTheme(event) {
//     const isDark = event.target.checked;
    
//     // 1. Set the class on the html element
//     document.documentElement.classList.toggle('dark', isDark);
    
//     // 2. Save the user's explicit choice
//     localStorage.setItem('theme', isDark ? 'dark' : 'light');
// }

function toggleTheme(e) {
    const isDark = e.target.checked;
    document.documentElement.classList.toggle('dark', isDark);
    
    const icon = document.getElementById('theme-icon');
    if(isDark) {
        icon.className = 'bi bi-sun-fill text-yellow-400';
    } else {
        icon.className = 'bi bi-moon-stars-fill text-brand-500';
    }
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

// Backup
// function initializeTheme() {
//     const savedTheme = localStorage.getItem('theme');
    
//     // Check saved preference first, then fall back to system preference
//     let isDark = savedTheme === 'dark' || 
//                  (savedTheme === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
    
//     // Apply the theme class to the root <html> element
//     document.documentElement.classList.toggle('dark', isDark);

//     // Update the toggle switch UI state (important if the user has a saved preference)
//     const themeToggle = document.getElementById('theme-toggle');
//     if (themeToggle) {
//         themeToggle.checked = isDark;
//     }
// }

function initializeTheme() {
    const saved = localStorage.getItem('theme');
    const isDark = saved === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    document.getElementById('theme-toggle').checked = isDark;
    
    const icon = document.getElementById('theme-icon');
    if(isDark) {
        icon.className = 'bi bi-sun-fill text-yellow-400';
    } else {
        icon.className = 'bi bi-moon-stars-fill text-brand-500';
    }
}

// =====================================================================
// --- PRO PLAN MODAL PURCHASE ---
// =====================================================================

/**
 * Opens the Pro Plan upgrade modal
 */
function openProPlanModal() {
    const modal = document.getElementById('pro-plan-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        // Add entrance animation
        setTimeout(() => {
            modal.style.opacity = '1';
        }, 10);
    }
}

/**
 * Closes the Pro Plan upgrade modal
 */
function closeProPlanModal() {
    const modal = document.getElementById('pro-plan-modal');
    if (modal) {
        modal.style.opacity = '0';
        setTimeout(() => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }, 300);
    }
}

/**
 * Handles the Pro Plan purchase process
 */
function purchaseProPlan() {
    const button = document.querySelector('#pro-plan-modal button[onclick="purchaseProPlan()"]');
    const originalText = button.innerHTML;
    
    // Show loading state
    button.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin mr-2"></i> Processing...';
    button.disabled = true;
    
    // Simulate purchase process
    setTimeout(() => {
        // Update user plan to Pro
        userPlan = 'pro';
        
        // Update ALL UI elements
        updateProUI();
        
        // Show success state
        button.innerHTML = '<i class="bi bi-check-lg mr-2"></i> Purchase Successful!';
        button.classList.remove('from-brand-600', 'to-purple-600');
        button.classList.add('bg-green-500', 'text-white');
        
        // Close modal after success
        setTimeout(() => {
            closeProPlanModal();
            showSystemNotification('success', 'Welcome to Pro!', 'Your Pro Plan features are now active.');
        }, 1500);
    }, 2000);
}

/**
 * Updates the UI to reflect Pro Plan status
 */
function updateUserToPro() {
    // Update the user profile section
    // const userPlanElement = document.querySelector('.text-brand-600.dark\\:text-brand-400');
    // if (userPlanElement) {
    //     userPlanElement.innerHTML = '<i class="bi bi-star-fill text-yellow-400"></i> Pro Plan';
    // }
    
    // Update any other UI elements that should change for Pro users
    const proElements = document.querySelectorAll('.pro-feature-locked');
    proElements.forEach(el => {
        el.classList.remove('pro-feature-locked');
        el.classList.add('pro-feature-unlocked');
    });
}

/**
 * Example function to show Pro features that are locked
 */
function showProFeatureLocked(featureName) {
    showSystemNotification('info', 'Pro Feature', `${featureName} is available in the Pro Plan.`);
    openProPlanModal();
}

// =====================================================================
// --- DASHBOARD STATUS UPDATES ---
// =====================================================================

/**
 * Updates the dashboard status card based on user plan
 */
function updateDashboardStatus() {
    // Elements may not exist in current HTML structure, so check before updating
    const statusBadge = document.getElementById('user-plan-badge');
    const protectionStatus = document.getElementById('protection-status');
    
    // If these elements don't exist, function cannot proceed
    if (!statusBadge || !protectionStatus) {
        // Silently return - these elements may not be in the HTML
        return;
    }

    if (userPlan === 'pro') {
        // Pro user styling
        statusBadge.textContent = 'Pro';
        statusBadge.className = 'text-xl font-mono font-bold text-purple-200';
        protectionStatus.textContent = 'Advanced protection with unlimited version history & cloud sync.';
        protectionStatus.className = 'text-purple-100 text-sm mt-1';
        
    } else {
        // Basic user styling
        statusBadge.textContent = 'Basic';
        statusBadge.className = 'text-xl font-mono font-bold text-green-200';
        protectionStatus.textContent = 'Real-time monitoring is active across 4 watched folders.';
        protectionStatus.className = 'text-green-100 text-sm mt-1';
    }
}


// =============================================
// DOM ELEMENTS
// =============================================
class Elements {
    constructor() {
        this.backupLocation = document.getElementById('backupLocation');
        // this.sourceLocation = document.getElementById('sourceLocation');

        // this.backupProgress = document.getElementById('backupProgress');
        this.backupUsage = document.getElementById('backup-usage');
        this.backupUsagePercent = document.getElementById('backup-usage-percent');
        this.backupLocationPath = document.getElementById('backup-location-path');

        // this.homeUsage = document.getElementById('homeUsage');
        
        // this.deviceUsed = document.getElementById('deviceUsed');
        // this.deviceFree = document.getElementById('deviceFree');
        // this.deviceTotal = document.getElementById('deviceTotal');

        this.devicesContainer = document.getElementById('device-list-container');
        // this.selectedDevicePath = document.getElementById('selectedDevicePath');
        // this.selectedDeviceStats = document.getElementById('selectedDeviceStats');
        // this.selectedDeviceInfo = document.getElementById('selectedDeviceInfo');
        // this.confirmSelectionBtn = document.getElementById('confirmSelectionBtn');
        
        // this.devicesName = document.getElementById('devicesName');
        // this.deviceMountPoint = document.getElementById('deviceMountPoint');
        // this.devicesFilesystem = document.getElementById('devicesFilesystem');
        // this.devicesModel = document.getElementById('devicesModel');
        // this.devicesUsageBar = document.getElementById('devicesUsageBar');

        this.filesImagesCount = document.getElementById('files-images-count');
        this.filesVideosCount = document.getElementById('files-videos-count');
        this.filesDocumentsCount = document.getElementById('files-documents-count');
        this.filesOtherCount = document.getElementById('files-others-count');

        this.filesImagesSize = document.getElementById('files-images-size');
        this.filesVideosSize = document.getElementById('files-videos-size');
        this.filesDocumentsSize = document.getElementById('files-documents-size');
        this.filesOtherSize = document.getElementById('files-others-size');

        // this.logContainer = document.getElementById('logContainer');
        // this.leftSidebar = document.getElementById('leftSidebar');
        // this.mainTitle = document.getElementById('mainTitle');

        this.fileSearchInput = document.getElementById('file-search-input');
        // this.deviceInfoSection = document.getElementById('deviceInfoSection');
        // this.rightSidebar = document.getElementById('rightSidebar');

    }
}

const elements = new Elements();


// =============================================
// APPLICATION STATE
// =============================================
class AppState {
    constructor() {
        this.backup = {
            running: true,
        };
        this.intervals = {
            backup: null,
            device: null,
            storage: null
        };
        this.selectedDevice = null;
    }
}

const appState = new AppState();


// =============================================
// UTILITY FUNCTIONS
// =============================================
class Utils {
    static formatBytes(bytes, decimals = 2) {
            // FIX: Safely convert input to a number and check for invalid/non-positive values.
            const safeBytes = Number(bytes);

            if (isNaN(safeBytes) || safeBytes <= 0) return '0 Bytes';
            
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            
            // Use safeBytes for calculation
            const i = Math.floor(Math.log(safeBytes) / Math.log(k));
            const effectiveIndex = Math.min(i, sizes.length - 1);

            return parseFloat((safeBytes / Math.pow(k, effectiveIndex)).toFixed(decimals)) + ' ' + sizes[effectiveIndex];
        };

    static getDeviceIcon(device) {
        if (!device) return 'bi-usb-c';
        return getFileIconDetails(device.filesystem).iconClass;  // Return correct icon class
    };

    static getDeviceIconClass(device) {
        if (!device || !device.total || device.total === 0) return 'bg-gray-100 text-gray-600';
        const freePercent = (device.total - device.used) / device.total;
        if (freePercent < 0.2) return 'bg-red-100 text-red-600';
        if (freePercent < 0.5) return 'bg-yellow-100 text-yellow-600';
        return 'bg-green-100 text-green-600';
    };
    
    static getUsageColorClass(percent) {
        if (percent > 90) return 'bg-red-500';
        if (percent > 70) return 'bg-yellow-500';
        return 'bg-green-500';
    }

    static handleResponse(response) {
        if (response.status === 204) {  // Handle no-content responses
            return null;
        }
        
        // First parse the JSON
        return response.json().then(data => {
            // Then check for success flag if the endpoint uses it
            if (data.hasOwnProperty('success') && !data.success) {
                const errorMsg = data.error || 'Request failed';
                console.error('API error:', errorMsg); // Log the error for debugging
                throw new Error(errorMsg);
            }
            return data;
        }).catch(error => {
            console.error('Response parsing error:', error);
            throw error;
        });
    }

    static getFileThumbnail(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const thumbnails = {
            pdf: { bg: 'bg-red-50', icon: 'fa-file-pdf', color: 'text-red-600' },
            doc: { bg: 'bg-blue-50', icon: 'fa-file-word', color: 'text-blue-600' },
            docx: { bg: 'bg-blue-50', icon: 'fa-file-word', color: 'text-blue-600' },
            xls: { bg: 'bg-green-50', icon: 'fa-file-excel', color: 'text-green-600' },
            xlsx: { bg: 'bg-green-50', icon: 'fa-file-excel', color: 'text-green-600' },
            jpg: { bg: 'bg-purple-50', icon: 'fa-file-image', color: 'text-purple-600' },
            jpeg: { bg: 'bg-purple-50', icon: 'fa-file-image', color: 'text-purple-600' },
            gif: { bg: 'bg-purple-50', icon: 'fa-file-image', color: 'text-purple-600' },
            png: { bg: 'bg-purple-50', icon: 'fa-file-image', color: 'text-purple-600' },
            png: { bg: 'bg-purple-50', icon: 'fa-file-image', color: 'text-purple-600' },
            default: { bg: 'bg-gray-50', icon: 'fa-file', color: 'text-gray-600' }
        };
        
        return thumbnails[ext] || thumbnails.default;
    }
};


// =============================================
// EXTENSION MANAGER
// ============================================
/**
 * Determines the icon and color class based on the file extension.
 * @param {string} filename The name of the file.
 * @returns {object} An object containing the iconClass and iconColor.
 */
function getFileIconDetails(filename) {
    if (typeof filename !== 'string' || !filename) {
        return { iconClass: 'bi bi-file-earmark-text-fill', iconColor: 'text-gray-500', thumbnail: null };
    }
    const ext = filename.split('.').pop().toLowerCase();
    let iconClass = 'bi bi-file-earmark-text-fill';
    let iconColor = 'text-gray-500'; // Default grey color
    let thumbnail = null;

    if (ext === 'txt') {
        iconClass = 'bi bi-file-earmark-text-fill';
        iconColor = 'text-green-500';
    } else if (ext === 'blend') {
        iconClass = 'bi bi-box-fill-fill';
        iconColor = 'text-orange-500';
    }
    else if (['md', 'txt', 'log', 'ini', 'config', 'cfg', 'conf', 'sh', 'py', 'js', 'html', 'css'].includes(ext)) {
        iconClass = 'bi bi-file-code-fill';
        iconColor = 'text-indigo-500';
    } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext)) {

        iconClass = 'bi bi-file-earmark-image-fill';
        iconColor = 'text-purple-500';
        thumbnail = `/static/data/images/${ext}.png`; // Example thumbnail path
    } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        iconClass = 'bi bi-file-earmark-zip-fill';
        iconColor = 'text-blue-500';
    } else if (['mp4', 'avi', 'mov', 'mkv'].includes(ext)) {
        iconClass = 'bi bi-file-earmark-play-fill';
        iconColor = 'text-red-500';
    }  else if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) {
        iconClass = 'bi bi-file-earmark-music-fill';
        iconColor = 'text-blue-500';
    }
    else if (['usb', 'vnmw', 'sd', 'mmc', 'sd-card', 'hd', 'memory', 'ext4'].includes(ext)) {
        iconClass = 'bi bi-device-hdd-fill';
        iconColor = 'text-green-500';
    }
    return { iconClass, iconColor, thumbnail };
}


// =============================================
// TIME FORMATTING UTILITY
// =============================================
/**
 * Converts a Unix timestamp to a human-readable relative time string.
 * Examples: "just now", "2 minutes ago", "1 hour ago", "3 days ago"
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} Human-readable relative time
 */
function timeSince(timestamp) {
    // Handle both seconds and milliseconds
    const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp);
    const timestampMs = ts < 10000000000 ? ts * 1000 : ts; // Convert to ms if needed
    const now = Date.now();
    const secondsAgo = Math.floor((now - timestampMs) / 1000);

    if (secondsAgo < 0) return 'just now';
    if (secondsAgo === 0) return 'just now';
    if (secondsAgo < 60) return `${secondsAgo} second${secondsAgo !== 1 ? 's' : ''} ago`;
    
    const minutesAgo = Math.floor(secondsAgo / 60);
    if (minutesAgo < 60) return `${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago`;
    
    const hoursAgo = Math.floor(minutesAgo / 60);
    if (hoursAgo < 24) return `${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`;
    
    const daysAgo = Math.floor(hoursAgo / 24);
    if (daysAgo < 7) return `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago`;
    
    const weeksAgo = Math.floor(daysAgo / 7);
    if (weeksAgo < 4) return `${weeksAgo} week${weeksAgo !== 1 ? 's' : ''} ago`;
    
    const monthsAgo = Math.floor(daysAgo / 30);
    return `${monthsAgo} month${monthsAgo !== 1 ? 's' : ''} ago`;
}


// =============================================
// BACKUP FUNCTIONS
// =============================================
const BackupManager = {
    updateUsage: () => {
        fetch('/api/backup/usage')
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    BackupManager.updateUI(data);
                    // BackupManager.checkDaemonStatus();  // Check if daemon is running and update status
                    
                    // Refresh suggested files when backup data loads
                    // SuggestedFiles.load();
                    
                    // Search bar
                    // elemets.searchInput.disabled = false;  // Enable searchbar
                // } else {
                //     // User did not registered a backup device yet
                //     if (data.error.includes('Please select a backup device first')) {
                //         elements.backupLocation.innerHTML = `
                //             <span class="text-red-500">⚠️ Action Required</span>
                //         `;
                //         elements.backupUsage.innerHTML = `
                //             <div class="text-sm">
                //                 ${data.error}
                //                 <button onclick="Navigation.showSection('devices')" 
                //                         class="mt-2 text-indigo-600 hover:text-indigo-800 font-medium">
                //                     Go to Devices Section Now →
                //                 </button>
                //             </div>
                //         `;
                        
                //         elements.backupProgress.style.width = "0%";
                //         elements.backupProgress.className = 'h-2 rounded-full bg-yellow-500';
                //     }
                //     else if (data.error.includes('device is not available')) {
                //         BackupManager.updateUI(data);

                //         // Search bar
                //         this.fileSearchInput.disabled = true;  // Disable searchbar

                //         elements.backupLocation.innerHTML = `
                //             <span class="text-red-500">⚠️ Action Required</span>
                //         `;
                //         elements.backupUsage.innerHTML = `
                //             <div class="text-sm">
                //                 ${data.error}
                //             </div>
                //         `;
                        
                //         elements.backupProgress.style.width = "0%";
                //         elements.backupProgress.className = 'h-2 rounded-full bg-yellow-500';
                //     } else {
                //         // Handle other errors
                //         elements.backupLocation.innerHTML = `
                //             <span class="text-red-500">⚠️ Error</span>
                //         `;
                //         elements.backupUsage.innerHTML = `
                //             <div class="text-sm">
                //                 ${data.error}
                //             </div>
                //         `;
                //     }                        
                }
            })
            .catch(error => {
                console.error('Backup usage check failed:', error);
                // elements.backupUsage.textContent = 
                //     "Connection error. Please refresh the page.";
            });
    },

    updateUI: (data) => {
        if (data.success) {
            // const displayLocation = data.location.replace(/\\/g, '/').replace(/\/$/, '');
            // const pathParts = displayLocation.split('/').filter(part => part.trim() !== '');
            // const displayName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : displayLocation;
            
            // elements.backupLocation.textContent = displayLocation;
            // elements.sourceLocation.textContent = data.users_home_path;
            // elements.sourceLocation.textContent = data.users_home_path;

            // User's home usage (Right Side)
            // elements.homeUsage.textContent = `${data.home_human_used} used of ${data.home_human_total} (${data.home_percent_used}% used)`;

            // Backup device info (Center Position)
            // elements.devicesName.textContent = data.device_name || displayName; // Use device_name if available
            // elements.deviceMountPoint.textContent = displayLocation;
            // elements.backupProgress.style.width = `${data.percent_used}%`;
            elements.backupUsage.textContent = 
                `${data.human_used} Used / ${data.human_total} (${data.percent_used}% used)`;
            elements.backupUsagePercent.textContent = `${data.percent_used}%`;
            elements.backupLocationPath.textContent = `${data.location}`;

            // 1.2 TB Used / 800 GB Free
            // 32.1 GB used of 72.8 GB (44.1% used)

            // Source device info "Left Side" HOME
            // elements.deviceUsed.textContent = `${data.human_used} `;
            // elements.deviceFree.textContent = `${data.human_free}`;
            // elements.deviceTotal.textContent = `${data.human_total}`;

            // elements.backupProgress.className = 'h-2 rounded-full';
            // elements.backupProgress.classList.add(Utils.getUsageColorClass(data.percent_used));
            
            // Update the UI with the devices used space
            // elements.devicesUsageBar.style.width = `${data.percent_used}%`;
            // elements.devicesUsageBar.className = 'h-2 rounded-full';
            // elements.devicesUsageBar.classList.add(Utils.getUsageColorClass(data.percent_used));
            
            // Update device details in the UI
            // if (data.filesystem) {
            //     elements.devicesFilesystem.textContent = data.filesystem;
            // }
            // if (data.model) {
            //     elements.devicesModel.textContent = data.model;
            // }
            
            // Update image count from summary if available
            if (data.summary && data.summary.categories) {
                const imagesCategory = data.summary.categories.find(cat => cat.name === "Image");
                const documentsCategory = data.summary.categories.find(cat => cat.name === "Document");
                const videosCategory = data.summary.categories.find(cat => cat.name === "Video");
                const otherCategory = data.summary.categories.find(cat => cat.name === "Others");
                
                // Images
                if (imagesCategory) {
                    elements.filesImagesCount.textContent = `${imagesCategory.count.toLocaleString()} files`;
                    elements.filesImagesSize.textContent = `${imagesCategory.size_str}`;
                }
                // Videos                   
                if (videosCategory) {
                    elements.filesVideosCount.textContent = `${videosCategory.count.toLocaleString()} files`;
                    elements.filesVideosSize.textContent = `${videosCategory.size_str}`;
                }
                // Documents
                if (documentsCategory) {
                    elements.filesDocumentsCount.textContent = `${documentsCategory.count.toLocaleString()} files`;
                    elements.filesDocumentsSize.textContent = `${documentsCategory.size_str}`;
                }
                // Other files
                if (otherCategory) {
                    elements.filesOtherCount.textContent = `${otherCategory.count.toLocaleString()} files`;
                    elements.filesOtherSize.textContent = `${otherCategory.size_str}`;
                }
            }
        } else {
            console.log("asd");
            // elements.backupLocation.textContent = "Error";
            // elements.backupUsage.textContent = `Error: ${data.error || 'Unknown error'}`;
            // elements.backupProgress.style.width = '0%';
            // elements.backupProgress.className = 'h-2 rounded-full bg-gray-500';
        }
    },

    checkDaemonStatus: () => {
        // Check if daemon is running via WebSocket connection status
        if (window.backupStatusClient && window.backupStatusClient.ws) {
            const isConnected = window.backupStatusClient.ws.readyState === WebSocket.OPEN;
            const realTimeStatusLabel = document.getElementById('realTimeStatusLabel');
            
            if (realTimeStatusLabel) {
                if (isConnected) {
                    realTimeStatusLabel.className = 'bi bi-circle-fill text-green-500 mr-1 text-xs';
                    realTimeStatusLabel.title = 'Real-time backup active';
                } else {
                    realTimeStatusLabel.className = 'bi bi-circle-fill text-red-500 mr-1 text-xs';
                    realTimeStatusLabel.title = 'Real-time backup inactive';
                }
            }
        } else {
            // No WebSocket connection - daemon not running
            const realTimeStatusLabel = document.getElementById('realTimeStatusLabel');
            if (realTimeStatusLabel) {
                realTimeStatusLabel.className = 'bi bi-circle-fill text-red-500 mr-1 text-xs';
                realTimeStatusLabel.title = 'Real-time backup not running';
            }
        }
    },


    //////////////////////////////////////////////////////////////////////////
    // AUTOMATICALLY REALTIME CHECKBOX
    //////////////////////////////////////////////////////////////////////////
    toggle: () => {
        const realTimeCheckbox = document.getElementById('realTimeCheckbox');
        
        // 1. DISABLE INPUT immediately to prevent multiple clicks
        realTimeCheckbox.disabled = true;
        
        // Determine intended state based on current click
        const isChecked = realTimeCheckbox.checked;
        
        // Optimistic UI Update (Update visuals immediately)
        BackupManager.updateVisualStatus(isChecked);

        // 2. Send Request
        BackupManager.updateRealTimeBackupState(isChecked)
            .finally(() => {
                // 3. RE-ENABLE INPUT when request finishes
                realTimeCheckbox.disabled = false;
            });
    },
    
    updateVisualStatus: (isActive) => {
        appState.backup.running = isActive;
        const statusLabel = document.getElementById('realTimeStatusLabel');
        
        if (statusLabel) {
            if (isActive) {
                statusLabel.classList.replace('text-red-500', 'text-green-500');
                statusLabel.classList.replace('far', 'fas');
                statusLabel.title = "Real-time backup active";
            } else {
                statusLabel.classList.replace('text-green-500', 'text-red-500');
                statusLabel.classList.replace('fas', 'far');
                statusLabel.title = "Real-time backup inactive";
            }
        }
    },
    
    updateRealTimeBackupState: (isChecked) => {
        return fetch('/api/realtime-backup/daemon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isChecked }),
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                console.error("Error toggling daemon:", data.error);
                alert("Failed to toggle backup: " + data.error);
                
                // Revert UI on error
                document.getElementById('realTimeCheckbox').checked = !isChecked;
                BackupManager.updateVisualStatus(!isChecked);
            } else {
                console.log("Daemon status updated:", data.status);
            }
        })
        .catch(err => {
            console.error("Network error:", err);
            // Revert UI on error
            document.getElementById('realTimeCheckbox').checked = !isChecked;
            BackupManager.updateVisualStatus(!isChecked);
        });
    },
};


// =====================================================================
// --- DEVICE MANAGEMENT ---
// =====================================================================
const DeviceManager = {
    load: () => {
        const container = document.getElementById('device-list-container');
        if (!container) return;
        
        container.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-12 text-muted">
                <i class="bi bi-arrow-clockwise animate-spin text-2xl mb-2"></i>
                <p>Scanning sources...</p>
            </div>`;

        // Fetch both devices and config concurrently
        Promise.all([
            fetch('/api/storage/devices').then(res => res.json()),
            fetch('/api/config').then(res => res.json())
        ])
        .then(([devicesData, configData]) => {
            if (!devicesData.success || !devicesData.devices || devicesData.devices.length === 0) {
                DeviceManager.render([]); // Render empty state
                return;
            }

            const activePath = configData?.DEVICE_INFO?.path;
            
            // Add an 'isActive' property to each device
            const updatedDevices = devicesData.devices.map(device => {
                return {
                    ...device,
                    isActive: device.mount_point === activePath
                }
            });

            DeviceManager.render(updatedDevices);
        })
        .catch(error => {
            console.error("Failed to load devices or config:", error);
            DeviceManager.render([]); // Render empty state on error
        });
    },

    normalize: (device) => {
        // Safely handle numeric conversion
        const total = Number(device.total) || 0;
        const used = Number(device.used) || 0;
        const free = Number(device.free) || 0;
        
        // Calculate GB for display if the backend doesn't provide it formatted
        const totalGB = Math.round(total / (1024**3));
        const usedGB = Math.round(used / (1024**3));

        // Determine status based on mount point or other flags from backend
        // Adjust this logic based on how your backend identifies the active backup drive
        let status = 'Inactive';
        let color = 'text-slate-400';
        
        if (device.mount_point === '/' || device.mount_point === 'C:\\') {
            status = 'System';
            color = 'text-blue-300';
        }

        return {
            id: device.id || Math.random().toString(36).substr(2, 9),
            name: device.label || device.name || device.device || 'Unknown Device',
            mount_point: device.mount_point || '',
            filesystem: device.filesystem || 'Unknown',
            total: total,
            used: used,
            free: free,
            totalGB: totalGB,
            usedGB: usedGB,
            status: status,
            icon: (device.mount_point === '/' || device.mount_point === 'C:\\') ? 'bi-pc-display' : 'bi-usb-drive-fill',
            color: color,
            isActive: false // Will be set later based on config
        };
    },

    render: (devices) => {
        const container = document.getElementById('device-list-container');
        if (!container) return;
        container.innerHTML = '';

        if (devices.length === 0) {
            container.innerHTML = `
                <div class="col-span-full border-2 border-dashed border-main rounded-2xl p-10 text-center">
                    <i class="bi bi-hdd text-4xl text-muted mb-3 block"></i>
                    <h4 class="font-bold text-main">No Devices Found</h4>
                    <p class="text-sm text-muted">Connect a USB drive to get started.</p>
                </div>`;
            return;
        }

        // console.log("Rendering devices:", devices);
        
        devices.forEach(device => {
            const usedGB = Math.round((device.used || 0) / (1024**3));
            const totalGB = Math.round((device.total || 0) / (1024**3));
            const percent = totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0;
            const isSSD = device.is_ssd;  // Check if the device is SSD

            // Logic for active device
            const isActive = device.isActive;
            const statusColor = isActive ? 'text-emerald-500' : 'text-muted';
            const statusText = isActive ? 'Active' : 'Ready';
            const borderClass = isActive ? 'border-emerald-500 ring-1 ring-emerald-500' : 'border-main hover:border-brand-300';
            
            // Create a safe string for the onclick handler
            const deviceId = device.id || Math.random().toString(36).substr(2, 9);
            
            const card = `
            <div class="bg-card p-6 rounded-2xl border ${borderClass} group cursor-pointer transition-all duration-200" data-device-id="${deviceId}">
                <div class="flex items-start justify-between mb-4">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl bg-gray-50 dark:bg-white/5 flex items-center justify-center text-xl text-main">
                            ${isSSD 
                                ? '<i class="bi bi-device-ssd-fill"></i>' 
                                : '<i class="bi bi-hdd-fill"></i>'
                            }
                        </div>
                        <div>
                            <h4 class="font-bold text-main text-base">${device.label || device.name || 'Unnamed Drive'}</h4>
                            <div class="flex items-center gap-1.5 mt-0.5">
                                <span class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-gray-400'}"></span>
                                <span class="text-xs font-medium ${statusColor}">${statusText}</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="mb-4">
                    <div class="flex justify-between text-xs font-medium text-muted mb-2">
                        <span>${usedGB} GB Used</span>
                        <span>${totalGB} GB Total</span>
                    </div>
                    <div class="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                        <div class="h-full bg-brand-500 rounded-full" style="width: ${percent}%"></div>
                    </div>
                </div>

                ${isActive 
                    ? `<button disabled class="w-full py-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 text-xs font-bold flex items-center justify-center gap-2"><i class="bi bi-check-circle-fill"></i> Backup Location</button>`
                    : `<button onclick="handleDeviceSelection('${deviceId}')" class="w-full py-2 rounded-lg border border-main hover:bg-gray-50 dark:hover:bg-white/5 text-main text-xs font-bold transition cursor-pointer">Set as Backup</button>`
                }
            </div>`;
            container.innerHTML += card;
            
            // Store device data in a global map for lookup
            if (!window.deviceMap) window.deviceMap = {};
            window.deviceMap[deviceId] = device;
        });
    },

    createCard: (device) => {
        const card = document.createElement('div');
        
        // 1. Calculate Usage Percentage
        let percentUsed = 0;
        if (device.total > 0) {
            percentUsed = Math.round((device.used / device.total) * 100);
        } else if (device.totalGB > 0) {
            percentUsed = Math.round((device.usedGB / device.totalGB) * 100);
        }

        // Formatted strings
        const usedStr = Utils.formatBytes(device.used);
        const totalStr = Utils.formatBytes(device.total);
        
        // 2. Determine Visuals
        const progressColor = percentUsed > 90 ? 'bg-red-500' : 'bg-brand-600';
        const iconName = device.icon.replace('bi ', ''); // Clean icon class
        
        // 3. Check if device is active (use the isActive property we set)
        const isActive = device.isActive || device.status === 'Active';

        // 4. Setup Container Classes - Green border for active devices
        card.className = `device-card bg-white dark:bg-slate-800 p-6 rounded-xl border ${isActive ? 'border-green-500 ring-1 ring-green-500' : 'border-slate-200 dark:border-slate-700'} shadow-md hover:shadow-xl transition-all duration-200 flex flex-col h-full cursor-pointer group`;
        
        // 5. Set Data Attributes
        const devicesId = device.id;
        const devicesPath = device.mount_point;

        card.setAttribute('data-device-id', devicesId);
        card.setAttribute('data-device-path', devicesPath);

        // 6. Button Logic - Updated with checkmark icon and green styling
        let buttonHtml = '';
        if (isActive) {
            buttonHtml = `
                <button disabled class="w-full py-2.5 rounded-lg text-xs font-bold bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800 cursor-default flex items-center justify-center gap-2">
                    <i class="bi bi-check-circle-fill"></i> Currently Active
                </button>`;
        } else {
            buttonHtml = `
                <button onclick="DeviceManager.selectDevice(${JSON.stringify(device).replace(/"/g, '&quot;')})" class="w-full py-2.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-brand-700 dark:text-slate-200 hover:bg-brand-50 dark:hover:bg-blue-300 hover:border-brand-200 transition shadow-sm flex items-center justify-center gap-2">
                    Use as Backup Device
                </button>`;
        }

        // 7. Render HTML
        card.innerHTML = `
            <div class="flex items-start justify-between mb-6">
                <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-xl text-muted group-hover:text-brand-600 transition-colors">
                        <i class="bi ${iconName}"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-main text-lg truncate max-w-[180px]" title="${device.name}">
                            ${device.name}
                        </h4>
                        <span class="text-xs font-medium ${isActive ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-slate-100 dark:bg-slate-700 text-secondary dark:text-slate-300'} px-2 py-0.5 rounded-full inline-flex items-center gap-1 mt-1">
                            <i class="bi ${isActive ? 'bi-check-circle-fill' : 'bi-hdd-network'} text-[10px]"></i> ${isActive ? 'Active' : (device.filesystem || 'Drive')}
                        </span>
                    </div>
                </div>
            </div>

            <div class="mb-6 flex-1">
                <div class="flex justify-between text-xs text-muted mb-2 font-medium">
                    <span>Used: ${usedStr}</span>
                    <span>Total: ${totalStr}</span>
                </div>
                <div class="progress-bar-container h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                    <div class="progress-bar-fill ${progressColor} h-full rounded-full transition-all duration-500" style="width: ${percentUsed}%"></div>
                </div>
            </div>

            <div class="pt-4 border-t border-slate-100 dark:border-slate-700 mt-auto">
                ${buttonHtml}
            </div>
        `;
        
        return card;
    },

    showNoDevices: () => {
        const container = document.getElementById('device-list-container');
        if (container) {
            container.innerHTML = `
                <div class="col-span-3 text-center py-10 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                    <i class="bi bi-hdd-fill text-slate-300 dark:text-secondary text-4xl mb-2 block"></i>
                    <div class="text-muted font-medium">No storage devices found</div>
                    <div class="text-sm text-slate-400 dark:text-slate-500 mt-1">Connect a USB drive and click Refresh</div>
                </div>
            `;
        }
    },

    showError: (error) => {
        const container = document.getElementById('device-list-container');
        if (container) {
            container.innerHTML = `
                <div class="col-span-3 text-center py-10 border-2 border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 rounded-xl">
                    <i class="bi bi-exclamation-triangle text-red-400 text-3xl mb-2 block"></i>
                    <div class="text-red-600 dark:text-red-400 font-bold">Error loading devices</div>
                    <div class="text-sm text-red-500 dark:text-red-300 mt-1">${error.message || 'Connection failed'}</div>
                </div>
            `;
        }
    },

    selectDevice: async (device) => {
        console.log("Selecting device:", device);
        
        try {
            const response = await fetch('/api/backup/select-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    device_info: device
                })
            });

            const result = await response.json();

            if (result.success) {
                console.log('Device configured successfully:', result.path);
                showSystemNotification('success', 'Device Configured', `${device.name} is now your backup device.`);
                
                // Refresh the devices list to show the new active device
                DeviceManager.load();
                
                // Refresh usage stats
                if (typeof BackupManager !== 'NaN') {
                    BackupManager.updateUsage();
                }
            } else {
                throw new Error(result.error || 'Server rejected the selection.');
            }

        } catch (error) {
            console.error('Network error during device selection:', error);
            showSystemNotification('error', 'Configuration Failed', error.message || 'Could not connect to server.');
        }
    },

    setupSelection: () => {
        document.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', function() {
                console.log('Device clicked:', this.getAttribute('data-device-path'));
                console.log('Device info:', this.getAttribute('data-device-info'));
                
                document.querySelectorAll('.device-card').forEach(c => {
                    c.classList.remove('selected');
                });
                
                this.classList.add('selected');
                appState.selectedDevice = {
                    path: this.getAttribute('data-device-path'),
                    info: JSON.parse(this.getAttribute('data-device-info'))
                };
                
                console.log('Selected device state:', appState.selectedDevice);
                DeviceManager.updateSelectionUI();
            });
        });
    },
};

/**
 * Helper function to handle device selection safely
 */
function handleDeviceSelection(deviceId) {
    if (!window.deviceMap || !window.deviceMap[deviceId]) {
        console.error('Device not found:', deviceId);
        showSystemNotification('error', 'Device Error', 'Could not find device information.');
        return;
    }
    
    const device = window.deviceMap[deviceId];
    useThisBackupDevice(device);
}


// =============================================
// DEVICE SELECTION HANDLER
// =============================================

function useThisBackupDevice(device) {
    console.log("Device object for selection:", device);
    
    if (!device || !device.mount_point) {
        showSystemNotification('error', 'Invalid Device', 'Device information is incomplete.');
        return;
    }
    
    // Ensure all numeric values are properly formatted
    const deviceInfo = {
        ...device,
        total: parseInt(device.total || device.total_size || 0),
        used: parseInt(device.used || 0),
        free: parseInt(device.free || 0),
        is_ssd: Boolean(device.is_ssd)
    };
    
    openConfirmationModal(
        "Set Backup Device?",
        `Are you sure you want to set <span class="font-bold text-main">${device.label || device.name || 'this device'}</span> as your backup destination?`,
        async () => {
            try {
                const response = await fetch('/api/backup/select-device', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        device_info: deviceInfo  // Use the processed device info
                    })
                });

                const result = await response.json();

                if (result.success) {
                    console.log('Device configured successfully:', result.path);
                    
                    // Refresh the devices list
                    DeviceManager.load();
                    
                    // Refresh usage stats
                    BackupManager.updateUsage();

                    showSystemNotification('success', 'Device Configured', 
                        `${device.label || device.name} is now your backup device.`);

                    // Create necessary folders inside the choose backup device
                    try {
                        const creationResponse = await fetch('/api/base-folders-creation', {
                            method: 'GET'
                        });

                        const creation = await creationResponse.json();
                        console.log(creation);
                        if (creation.success) {
                            return;
                            // showSystemNotification('info', 'Time Machine', `Time Machine base folders created successfully!`);
                        } else {
                            showSystemNotification('error', 'Error', `Failed to create base folders: ${creation.error || 'Unknown error'}`);
                        }
                    } catch (error) {
                        console.error('Error during folder creation fetch:', error);
                    }

                } else {
                    throw new Error(result.error || 'Server rejected the selection.');
                }

            } catch (error) {
                console.error('Network error during device selection:', error);
                showSystemNotification('error', 'Configuration Failed', 
                    error.message || 'Could not connect to server.');
            }
        }
    );
}


// =====================================================================
// --- CONFIG CHECK FOR ACTIVE DEVICE ---
// =====================================================================

/**
 * Checks if a device is the currently active backup device by comparing with config
 */
async function isDeviceActive(device) {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        // Check if DEVICE_INFO section exists and path matches
        if (config.DEVICE_INFO && config.DEVICE_INFO.path) {
            const activePath = config.DEVICE_INFO.path;
            return activePath === device.mount_point;
        }
        return false;
    } catch (error) {
        console.error('Error checking device status:', error);
        return false;
    }
}

/**
 * Updates device status based on config and re-renders devices
 */
async function updateDeviceStatuses() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        const activePath = config.DEVICE_INFO?.path;
        
        // Update deviceData with active status
        deviceData.forEach(device => {
            device.isActive = device.mount_point === activePath;
        });
        
        // Re-render devices with updated status
        DeviceManager.render(deviceData);
    } catch (error) {
        console.error('Error updating device statuses:', error);
    }
}


// =============================================
// SIZE FORMATTER UTILITY
// =============================================
function humanFileSize(size) {
  const i = size == 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
  return (
    +(size / Math.pow(1024, i)).toFixed(2) * 1 +
    " " +
    ["B", "kB", "MB", "GB", "TB"][i]
  );
}


// =============================================
// ACTIVITY FEED MANAGER
// =============================================
const ActivityFeedManager = {
    feedContainer: null,
    storageKey: 'timemachine_activity_feed',
    maxStoredItems: 50, // Store more items than displayed

    init() {
        // Target the <tbody> element of the activity feed table
        this.feedContainer = document.querySelector('#live-activities-feed');
        if (!this.feedContainer) {
            console.error("Activity feed container not found (#live-activities-feed).");
            return;
        }
        
        // Load and display persisted activities
        this.loadFromStorage();
    },

    // Save activities to localStorage
    saveToStorage(activities) {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(activities));
        } catch (e) {
            console.warn('[ActivityFeed] Could not save to localStorage:', e);
        }
    },

    // Load activities from localStorage
    loadFromStorage() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                const activities = JSON.parse(stored);
                activities.forEach(activity => {
                    this._addRowToFeed(activity);
                });
                // console.log(`[ActivityFeed] Loaded ${activities.length} persisted activities from storage`);
            }
        } catch (e) {
            console.warn('[ActivityFeed] Could not load from localStorage:', e);
        }
    },

    // Get all activities currently in feed
    getAllActivities() {
        const activities = [];
        const rows = this.feedContainer.querySelectorAll('tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 5) {
                const fileNameEl = cells[0].querySelector('i')?.nextSibling;
                const fileName = fileNameEl?.textContent?.trim() || 'Unknown';
                const statusEl = cells[1].querySelector('span');
                const statusText = statusEl?.textContent?.trim() || 'Unknown';
                const sizeText = cells[2].textContent?.trim() || '0 B';
                const timeText = cells[4].textContent?.trim() || 'Unknown';
                
                activities.push({
                    fileName,
                    status: statusText,
                    size: sizeText,
                    time: timeText
                });
            }
        });
        return activities;
    },

    _createRowHtml(activity) {
        if (!activity) return '';
        
        // The Python messages use 'title', 'description', 'size', 'timestamp'
        const { title, description, size, timestamp } = activity;
        
        // *** FIX 1: Provide a safe fallback for description (prevents .split() error) ***
        const safeDescription = description || ""; 
        
        // *** FIX 2: Provide a safe fallback for title (prevents .includes() error) ***
        const safeTitle = title || ""; 
        
        // 1. Extract File Name
        // Use the safeDescription variable
        const fileName = safeDescription.split('/').pop(); 
        const fileData = getFileIconDetails(fileName);
        
        // 2. Map Action/Color based on the message content (title/type)
        let actionLabel = "Processing";
        let actionColorClass = "bg-slate-100 text-slate-700 dark:bg-slate-700/50 text-main";

        // *** Use the safeTitle variable for all checks ***
        if (safeTitle.includes('Backed Up') || safeTitle.includes('Hardlinked')) {
            actionLabel = 'Backed Up';
            actionColorClass = "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
        } else if (safeTitle.includes('Modified') || safeTitle.includes('Restoring')) {
            actionLabel = 'Modified';
            actionColorClass = "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
        } else if (safeTitle.includes('Moving') || safeTitle.includes('Renamed')) {
            actionLabel = 'Moved';
            actionColorClass = "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
        } else if (safeTitle.includes('Deleted')) {
            actionLabel = 'Deleted';
            actionColorClass = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
        }

        // 3. Format Size and Time
        // const formattedSize = window.formatBytes ? window.formatBytes(size) : `${size} B`; 
        const formattedTime = timeSince(timestamp);

        // 4. Return the full table row HTML with View Snapshots button
        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition">
                <td class="px-6 py-3 flex items-center gap-3">
                    <i class="bi ${fileData.iconClass} ${fileData.iconColor} text-main"></i> 
                    ${fileName}
                </td>
                <td class="px-6 py-3">
                    <span class="px-2 py-0.5 ${actionColorClass} rounded text-xs font-bold">${actionLabel}</span>
                </td>
                <td class="px-6 py-3 text-muted">${humanFileSize(size)}</td>
                <td class="px-6 py-3">
                    <button class="text-hyperlink hover:text-hyperlink dark:hover:text-blue-300 text-xs font-medium transition hover:underline cursor-pointer" onclick="if (window.isDeviceConnected) { ActivityFeedManager.viewSnapshots('${fileName}') }">View Snapshots</button>
                </td>
                <td class="px-6 py-3 text-right text-muted font-medium text-xs">${formattedTime}</td>
            </tr>
        `;
    },

    // Add row to feed (internal method)
    _addRowToFeed(activity) {
        if (!this.feedContainer) return;
        const newRowHtml = this._createRowHtml(activity);
        this.feedContainer.insertAdjacentHTML('afterbegin', newRowHtml);
        
        // Trim old entries
        while (this.feedContainer.children.length > MAX_FEED_ITEMS) {
            this.feedContainer.removeChild(this.feedContainer.lastChild);
        }
    },

    // Clear the Transfers feed and persisted storage
    clearFeed() {
        if (!this.feedContainer) return;
        // Remove all rows
        this.feedContainer.innerHTML = '';
        // Remove persisted storage
        try { localStorage.removeItem(this.storageKey); } catch (e) { /* ignore */ }
        // Notify user
        if (typeof showSystemNotification === 'function') {
            showSystemNotification('info', 'Feed Cleared', 'Transfers feed has been cleared.');
        }
    },

    // Public method to add a new message to the feed
    handleMessage(message) {
        if (!this.feedContainer) return;

        // Handle backup progress updates separately
        if (message.type === 'backup_progress') {
            this._handleBackupProgress(message);
            return;
        }

        // Add to feed display
        this._addRowToFeed(message);
        
        // Load existing activities from storage
        let allActivities = [];
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                allActivities = JSON.parse(stored);
            }
        } catch (e) {
            console.warn('[ActivityFeed] Could not parse stored activities:', e);
        }
        
        // Add new message at the beginning
        allActivities.unshift(message);
        
        // Keep only maxStoredItems
        allActivities = allActivities.slice(0, this.maxStoredItems);
        
        // Save to localStorage
        this.saveToStorage(allActivities);
    },

    // Handle backup progress updates
    _handleBackupProgress(message) {
        const { progress, status, eta, current_file, files_completed, total_files, bytes_processed, total_bytes } = message;
        
        // Find or create backup progress container
        let progressContainer = document.getElementById('backup-progress-container');
        if (!progressContainer) {
            progressContainer = document.createElement('div');
            progressContainer.id = 'backup-progress-container';
            progressContainer.className = 'lg:col-span-2 bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-800 dark:to-slate-800/50 rounded-2xl border border-slate-200 hover:shadow-md transition duration-200 dark:border-slate-700 shadow-sm p-6 relative overflow-hidden';
            progressContainer.innerHTML = '<div class="absolute top-0 right-0 w-32 h-32 bg-brand-500/5 rounded-full blur-3xl -z-0"></div>';
            
            // Insert at the top of the main content area
            // Insert into the first grid (after the first grid's first child - the status card)
            const firstGrid = document.querySelector('#view-overview .grid-cols-1.lg\\:grid-cols-3');
            const mainContent = document.querySelector('main .flex-1');
            if (firstGrid) {
                // Insert after the status card at position 0
                firstGrid.insertBefore(progressContainer, firstGrid.children[0]);
            } else if (mainContent) {
                mainContent.insertBefore(progressContainer, mainContent.firstChild);
            }
        }
        
        // Calculate formatted sizes
        const processedMB = (bytes_processed / (1024 * 1024)).toFixed(1);
        const totalMB = (total_bytes / (1024 * 1024)).toFixed(1);
        const progressPercent = Math.round((progress || 0) * 100);
        
        // Get status color
        let statusColor = 'text-blue-600 dark:text-blue-400';
        let statusBgColor = 'bg-blue-50 dark:bg-blue-900/20';
        if (status === 'completed') {
            statusColor = 'text-emerald-600 dark:text-emerald-400';
            statusBgColor = 'bg-emerald-50 dark:bg-emerald-900/20';
        } else if (status === 'failed') {
            statusColor = 'text-red-600 dark:text-red-400';
            statusBgColor = 'bg-red-50 dark:bg-red-900/20';
        }
        
        // Update progress container
        progressContainer.innerHTML = `
            <div class="relative z-10 space-y-5">
                <!-- Header -->
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 ${statusBgColor} rounded-lg flex items-center justify-center flex-shrink-0">
                            <i class="bi bi-cloud-check-fill ${statusColor}"></i>
                        </div>
                        <div>
                            <h3 class="font-bold text-main text-lg">Backup Progress</h3>
                            <p class="text-xs text-muted capitalize">${status || 'In Progress'}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <span class="text-2xl font-bold text-main">${progressPercent}%</span>
                        <p class="text-xs text-muted">Complete</p>
                    </div>
                </div>
                
                <!-- Main Progress Bar -->
                <div>
                    <div class="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-4 overflow-hidden shadow-inner">
                        <div class="bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700 h-full transition-all duration-500 ease-out rounded-full shadow-lg" style="width: ${progressPercent}%">
                            <div class="h-full bg-white/20 animate-pulse"></div>
                        </div>
                    </div>
                </div>
                
                <!-- Status Info Grid -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div class="bg-white dark:bg-slate-700/50 rounded-lg p-3 border border-slate-200 dark:border-slate-600">
                        <p class="text-secondary text-main text-xs font-medium mb-1">Files</p>
                        <p class="text-main font-bold text-lg">${files_completed}<span class="text-slate-500 text-sm">/${total_files}</span></p>
                    </div>
                    <div class="bg-white dark:bg-slate-700/50 rounded-lg p-3 border border-slate-200 dark:border-slate-600">
                        <p class="text-secondary text-main text-xs font-medium mb-1">Data</p>
                        <p class="text-main font-bold text-lg">${processedMB}<span class="text-slate-500 text-sm">/${totalMB} MB</span></p>
                    </div>
                    <div class="bg-white dark:bg-slate-700/50 rounded-lg p-3 border border-slate-200 dark:border-slate-600">
                        <p class="text-secondary text-main text-xs font-medium mb-1">Speed</p>
                        <p class="text-main font-bold text-lg">
                            ${bytes_processed > 0 ? (bytes_processed / (1024 * 1024 * 10)).toFixed(1) : '0'}<span class="text-slate-500 text-sm"> MB/s</span>
                        </p>
                    </div>
                    <div class="bg-white dark:bg-slate-700/50 rounded-lg p-3 border border-slate-200 dark:border-slate-600">
                        <p class="text-secondary text-main text-xs font-medium mb-1">ETA</p>
                        <p class="text-main font-bold text-lg">${eta || '--'}</p>
                    </div>
                </div>
                
                <!-- Current File -->
                ${current_file ? `
                    <div class="bg-white dark:bg-slate-700/50 rounded-lg p-3 border border-slate-200 dark:border-slate-600">
                        <p class="text-secondary text-main text-xs font-medium mb-1">
                            <i class="bi bi-file-earmark mr-1"></i>Current File
                        </p>
                        <p class="text-sm dark:text-slate-300 truncate font-medium">${current_file}</p>
                    </div>
                ` : ''}
            </div>
        `;

        // Insert a Stop Backup button when backup is running
        try {
            const header = progressContainer.querySelector('.flex.items-center.justify-between');
            // ensure we only add the button for running backups
            if (status && status === 'running') {
                if (!progressContainer.querySelector('#stopBackupBtn')) {
                    const stopBtn = document.createElement('button');
                    stopBtn.id = 'stopBackupBtn';
                    stopBtn.className = 'ml-4 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50';
                    stopBtn.innerHTML = '<i class="bi bi-stop-fill text-red-500"></i> Stop Backup';

                    stopBtn.onclick = async function () {
                        try {
                            stopBtn.disabled = true;
                            stopBtn.innerHTML = '<i class="bi bi-arrow-clockwise animate-spin mr-2"></i> Stopping...';

                            // Call backend endpoint to request daemon stop
                            const resp = await fetch('/api/backup/cancel', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ mode: 'graceful' })
                            });

                            if (resp.ok) {
                                if (typeof showSystemNotification === 'function') showSystemNotification('info', 'Stop Requested', 'Daemon stop requested.');
                            } else {
                                let text = 'Failed to request stop.';
                                try { const j = await resp.json(); if (j && j.msg) text = j.msg; } catch (e) {}
                                if (typeof showSystemNotification === 'function') showSystemNotification('error', 'Stop Failed', text);
                            }
                        } catch (e) {
                            if (typeof showSystemNotification === 'function') showSystemNotification('error', 'Stop Failed', e.message || String(e));
                        } finally {
                            // Keep the button disabled to avoid repeated clicks
                            stopBtn.disabled = true;
                        }
                    };

                    // Prefer appending to the header controls; fallback to right side of container
                    if (header) {
                        header.appendChild(stopBtn);
                    } else {
                        progressContainer.querySelector('.relative.z-10')?.appendChild(stopBtn);
                    }
                }
            } else {
                // Remove stop button when not running
                const existing = progressContainer.querySelector('#stopBackupBtn');
                if (existing) existing.remove();
            }
        } catch (e) {
            console.warn('[BackupProgress] Could not insert Stop button:', e);
        }

        // If the daemon reports the current file being processed, also add it to the Transfers feed
        try {
            if (current_file) {
                // Map progress status to human-friendly file activity titles
                let activityTitle = 'Backed Up';
                if (status === 'failed' || status === 'error') {
                    activityTitle = 'Error';
                } else if (status === 'running' || status === 'in_progress' || status === NaN) {
                    // Progress updates sent after a file backup in the example daemon indicate the file was backed up
                    activityTitle = 'Backed Up';
                } else if (status === 'completed') {
                    activityTitle = 'Backed Up';
                }

                const activity = {
                    // fields expected by _createRowHtml: title, description, size, timestamp
                    title: activityTitle,
                    description: current_file,
                    size: bytes_processed || 0,
                    timestamp: Date.now()
                };

                // Add to visible feed
                this._addRowToFeed(activity);

                // Persist to storage (same logic as handleMessage)
                try {
                    let allActivities = [];
                    const stored = localStorage.getItem(this.storageKey);
                    if (stored) allActivities = JSON.parse(stored);
                    allActivities.unshift(activity);
                    allActivities = allActivities.slice(0, this.maxStoredItems);
                    this.saveToStorage(allActivities);
                } catch (e) {
                    console.warn('[ActivityFeed] Could not persist backup_progress activity:', e);
                }
            }
        } catch (e) {
            console.warn('[ActivityFeed] Error while adding current_file to feed:', e);
        }
    },

    // Navigate to files view and search for the file
    viewSnapshots(fileName) {
        // Switch to files view
        nav('files');
        
        // If no connection to backup device, disable search field

        // Set the search input value and trigger search
        const searchInput = document.getElementById('file-search-input');
        if (searchInput) {
            searchInput.value = fileName;
            searchInput.dispatchEvent(new Event('keyup'));
        }
    }
};


// =====================================================================
// --- DOM
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
    App.init();
    
    // Initialize Activity Feed Manager
    ActivityFeedManager.init();

    // Connect WebSocket for live updates
    if (window.backupStatusClient) {
        window.backupStatusClient.connect();
    }

    // Initialize file system - load real backup files from server
    initializeFileSystem();  // Load files early
    initializeTheme();  // Set theme early

    nav(currentTabId);  // Default to overview tab
    checkBackupConnection();
    updateGreetingAndClock();
    setInterval(updateGreetingAndClock, 1000);
    renderSettings();
    updateProUI();
});


// =============================================
// INITIALIZATION
// =============================================
const App = {
    init: () => {
        appState.intervals = {};

        // Get username
        getUsersName();
        setInterval(checkBackupConnection, 3000);  // Initial check

        // // Initialize ActivityManager FIRST to load persisted activities
        BackupManager.updateUsage();
        DeviceManager.load();

        // Interval to update UI
        appState.intervals.storage = setInterval(BackupManager.updateUsage, 5000);
    },
};
