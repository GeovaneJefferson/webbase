// TODO 
// 1. version-pills-container-wrapper, add "Getting version..." label while version being searched
// 2. Bug when user change backup device and search for a file, "Select Backup" show weird/wrong version,
//  maybe from the previous choose backup device.
// 3. Make the appimage use Ubuntu Sans downloaded/local fonts.

// =============================================
// CONSTANTS
// =============================================

const MAX_LOG_ITEMS = 8;


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
// DOM ELEMENTS
// =============================================
class Elements {
    constructor() {
        this.backupLocation = document.getElementById('backupLocation');
        this.sourceLocation = document.getElementById('sourceLocation');

        this.backupProgress = document.getElementById('backupProgress');
        this.backupUsage = document.getElementById('backupUsage');

        this.homeUsage = document.getElementById('homeUsage');
        
        this.deviceUsed = document.getElementById('deviceUsed');
        this.deviceFree = document.getElementById('deviceFree');
        this.deviceTotal = document.getElementById('deviceTotal');

        this.devicesContainer = document.getElementById('devicesContainer');
        this.selectedDevicePath = document.getElementById('selectedDevicePath');
        this.selectedDeviceStats = document.getElementById('selectedDeviceStats');
        this.selectedDeviceInfo = document.getElementById('selectedDeviceInfo');
        this.confirmSelectionBtn = document.getElementById('confirmSelectionBtn');
        
        this.devicesName = document.getElementById('devicesName');
        this.deviceMountPoint = document.getElementById('deviceMountPoint');
        this.devicesFilesystem = document.getElementById('devicesFilesystem');
        this.devicesModel = document.getElementById('devicesModel');
        this.devicesUsageBar = document.getElementById('devicesUsageBar');

        this.imagesCount = document.getElementById('imagesCount');
        this.documentsCount = document.getElementById('documentsCount');
        this.videosCount = document.getElementById('videosCount');
        this.otherCount = document.getElementById('otherCount');

        this.imagesSize = document.getElementById('imagesSize');
        this.documentsSize = document.getElementById('documentsSize');
        this.videosSize = document.getElementById('videosSize');
        this.otherSize = document.getElementById('otherSize');

        this.logContainer = document.getElementById('logContainer');
        this.leftSidebar = document.getElementById('leftSidebar');
        this.mainTitle = document.getElementById('mainTitle');

        this.searchInput = document.getElementById('searchInput');
        this.deviceInfoSection = document.getElementById('deviceInfoSection');
        this.rightSidebar = document.getElementById('rightSidebar');

    }
}

const elements = new Elements();


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
// WEBSOCKET CLIENT
// =============================================
class BackupStatusClient {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.heartbeatInterval = null;
        this.pongTimeout = null; // <-- Timer for pong response timeout
        this.PING_INTERVAL = 30000; // 30 seconds
        this.PONG_TIMEOUT_DURATION = 5000; // 5 seconds extra to receive pong
        this.init();
    }

    init() {
        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        
        console.log('Connecting to WebSocket:', wsUrl);
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.updateConnectionStatus(true);
            this.startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (error) {
            }
        };

        this.ws.onclose = () => {
            this.updateConnectionStatus(false);
            this.stopHeartbeat();
            this.clearPongTimeout();
            this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
            this.updateConnectionStatus(false);
            this.ws.close();
        };
    }

    // This is the local handleMessage, is used to "filter" the information
    // Send curated info the UI messager handler (handleMessage)
    handleMessage(data) {
        // Handle PONG to reset timeout ---
        if (data.type === 'pong') {
            this.clearPongTimeout();
            return; 
        }
        
        // Route all activity-related messages to UIMessageHandler
        if (data.type === 'scanning'  || data.type === 'analyzing' || 
            data.type === 'progress' || data.type === 'completed' || 
            data.type === 'warning' || data.type === 'info') {
            
            console.log('WebSocket message received:', data); // Debug log
            UIMessageHandler.handleMessage(data);
            
            // TO DELETE
            // // Clear analyzing/progress when backup completes
            // if (data.type === 'completed') {
            //     ActivityManager.clearAnalyzingActivity();
            //     ActivityManager.clearProgressActivity();
            // }
        }
    }

    // Clear pong in timeout
    clearPongTimeout() {
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    // Recent Activities bubble; Backup device status. Connected or Disconnected.
    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('realTimeStatusLabel');
        if (statusElement) {
            if (connected) {
                statusElement.className = 'bi bi-circle-fill text-green-500 mr-1 text-xs';
                statusElement.title = 'Connected to backup daemon';
            } else {
                statusElement.className = 'bi bi-circle-fill text-red-500 mr-1 text-xs';
                statusElement.title = 'Disconnected from backup daemon';
            }
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * this.reconnectAttempts, 10000);
            setTimeout(() => this.connect(), delay);
        } else {
            console.error('❌ Max reconnection attempts reached');
            this.updateConnectionStatus(false);
        }
    }

    sendPing() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            this.startPongTimeout(); // <-- Start timeout after sending ping
        }
    }

    startHeartbeat() {
        // Clear existing interval
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        // Send ping every 30 seconds to keep connection alive
        this.heartbeatInterval = setInterval(() => this.sendPing(), 30000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    startPongTimeout() {
        this.clearPongTimeout(); // Clear any previous timeout
        this.pongTimeout = setTimeout(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                console.warn('❌ Heartbeat failed. Server pong timeout reached.');
                // FORCING CLOSURE triggers onclose(), which attempts reconnect
                this.ws.close(); 
            }
        }, this.PONG_TIMEOUT_DURATION); // Wait 5 seconds for pong
    }

    // Method to send commands to daemon (if needed)
    sendCommand(command, data = {}) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const message = {
                type: 'command',
                command: command,
                ...data,
                timestamp: Date.now()
            };
            this.ws.send(JSON.stringify(message));
            console.log('📤 Sent command to daemon:', message);
        } else {
            console.error('❌ WebSocket not connected, cannot send command');
        }
    }
}


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
        iconClass = 'bi bi-box-fill';
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
// DIFF MANAGER
// ============================================
const DiffManager = {
    currentFile: null,
    versions: [],
    currentVersionIndex: 0,
    ignoreWhitespace: false,
    diffData: null,
    selectedChanges: new Set(),


    init: function() {
        this.setupModalControls();
        this.setupEventListeners();
    },

    setupModalControls: function() {
        document.getElementById('closeDiffModal').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('ignoreWhitespaceToggle').addEventListener('click', () => {
            this.toggleIgnoreWhitespace();
        });

        document.getElementById('versionSlider').addEventListener('input', (e) => {
            this.onSliderChange(e.target.value);
        });

        document.getElementById('prevVersionBtn').addEventListener('click', () => {
            this.showPreviousVersion();
        });

        document.getElementById('nextVersionBtn').addEventListener('click', () => {
            this.showNextVersion();
        });

        document.getElementById('restoreFileBtn').addEventListener('click', () => {
            this.restoreFile();
        });
    },

    setupEventListeners: function() {
        // Click handler for merging individual changes
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('diff-line-added') || 
                e.target.classList.contains('diff-line-removed')) {
                this.mergeSingleChange(e.target);
            }
        });
    },

    showDiff: function(fileItem) {
        const fileName = fileItem.querySelector('h3').textContent;
        
        // Find the file object from latestSearchResults
        let fileObj = null;
        if (window.latestSearchResults) {
            fileObj = window.latestSearchResults.find(f => f.name === fileName);
        }
        
        if (!fileObj) {
            console.warn('File object not found for diff view:', fileName);
            return;
        }

        this.currentFile = {
            name: fileName,
            path: fileObj.path || fileName,
            currentContent: fileObj.versions?.home?.content || '',
            versions: fileObj.versions || []
        };

        this.showLoadingState();
        document.getElementById('diffModal').classList.remove('hidden');
        document.getElementById('diffModalTitle').textContent = `Time Machine: ${this.currentFile.name}`;
        
        // Render the diff view with available versions
        this.renderDiffView();
    },

    // Update renderDiffView to handle the case where versions might be empty
    renderDiffView: function() {
        if (!this.currentFile.versions || this.currentFile.versions.length === 0) {
            console.warn('No versions available for diff view');
            return;
        }

        this.currentVersionIndex = 0;
        this.getFileBackupVersions();
        this.showVersion(this.currentVersionIndex);

        document.getElementById('currentFileName').textContent = this.currentFile.name;
        document.getElementById('versionInfo').textContent = `Showing version 1 of ${Object.keys(this.currentFile.versions).length}`;
    },

    // Renders all the version pills in the versionPillsContainer
    getFileBackupVersions: function() {
        if (!versionPillsContainer) return; 
        versionPillsContainer.innerHTML = ''; 

        const versions = this.currentFile.versions;
        const versionKeys = Object.keys(versions).filter(key => key !== 'home');
        
        if (versionKeys.length === 0) {
            versionPillsContainer.innerHTML = '<div class="text-gray-500 text-sm p-2">No backup versions available</div>';
            return;
        }

        versionKeys.forEach((versionKey, index) => {
            const version = versions[versionKey];
            const isActive = index === 0;
            const pill = document.createElement('div');
            
            pill.className = `version-pill text-xs font-medium px-3 py-1 rounded-full cursor-pointer transition-colors duration-200 ${isActive ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`;
            
            // Format the date for the pill display
            pill.textContent = version.time || versionKey;
            pill.setAttribute('data-index', index);
            pill.setAttribute('data-version-key', versionKey);

            pill.addEventListener('click', () => {
                const clickedVersionKey = pill.getAttribute('data-version-key');
                this.showVersionByKey(clickedVersionKey);
                
                // Update active state
                document.querySelectorAll('.version-pill').forEach(p => {
                    p.classList.remove('bg-indigo-600', 'text-white');
                    p.classList.add('bg-gray-100', 'text-gray-700');
                });
                pill.classList.add('bg-indigo-600', 'text-white');
            });
            
            versionPillsContainer.appendChild(pill);
        });

        if (versionKeys.length > 0) {
            const firstVersionKey = versionKeys[0];
            const mainVersion = versions[firstVersionKey];
            
            document.querySelector('.version-pill[data-version-key="' + firstVersionKey + '"]').classList.add('bg-indigo-600', 'text-white');
            this.updateDiffViewDetails(mainVersion, mainVersion);
        }
    },

    showVersionByKey: function(versionKey) {
        const version = this.currentFile.versions[versionKey];
        if (!version) return;
        
        const dateStr = version.time || versionKey;
        
        document.getElementById('versionDate').textContent = dateStr;
        this.updateFileVersionDetails(version);
        
        this.performDiff(this.currentFile.currentContent, version.content || '');
    },

    // Updates the human-readable details, including the size
    updateFileVersionDetails: function(version) {
        // Update the 'Modified' date in the details section (optional, but good practice)
        const dateElement = document.getElementById('versionModified');
        if (dateElement) {
             dateElement.textContent = version.date.toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false 
            });
        }
    },

    showVersion: function(versionIndex) {
        if (versionIndex < 0 || versionIndex >= this.versions.length) return;
        
        this.currentVersionIndex = versionIndex;
        const version = this.versions[versionIndex];

        const dateStr = version.date.toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        document.getElementById('versionDate').textContent = dateStr;
        
        // Use the new reusable function to update all version details (including size)
        this.updateFileVersionDetails(version);

        // Update the visual selection of the pills
        document.querySelectorAll('.version-pill').forEach(p => {
             const index = parseInt(p.getAttribute('data-index'));
             p.classList.toggle('bg-indigo-600', index === versionIndex);
             p.classList.toggle('text-white', index === versionIndex);
             p.classList.toggle('bg-gray-100', index !== versionIndex);
             p.classList.toggle('text-gray-700', index !== versionIndex);
        });
        
        this.performDiff(this.currentFile.currentContent, version.content);
    },

    showLoadingState: function() {
        currentFileContentElement.textContent = 'Loading current file...';
        backupFileContentElement.textContent = 'Loading backup file...';
        document.getElementById('versionDate').textContent = 'Loading versions...';
        document.getElementById('versionStats').textContent = '';
    },

    closeModal: function() {
        document.getElementById('diffModal').classList.add('hidden');
        this.selectedChanges.clear();
    },

    onSliderChange: function(sliderValue) {
        if (this.versions.length === 0) return;

        // Calculate the version index based on the slider value
        const versionIndex = Math.round((1 - sliderValue / 100) * (this.versions.length - 1));
        this.showVersion(versionIndex);
    },

    performDiff: function(currentContent, backupContent) {
        if (this.ignoreWhitespace) {
            currentContent = this.normalizeWhitespace(currentContent);
            backupContent = this.normalizeWhitespace(backupContent);
        }

        // Use the correct global variable name (JsDiff)
        this.diffData = JsDiff.diffLines(currentContent, backupContent);
        this.renderDiff(this.diffData, currentContent, backupContent);
    },

    renderDiff: function(diff, currentContent, backupContent) {
        // const currentLines = currentContent.split('\n');
        // const backupLines = backupContent.split('\n');
        
        let currentLineNumber = 1;
        let backupLineNumber = 1;
        let currentHtml = '';
        let backupHtml = '';
        let lineNumbersHtml = '';
        
        document.querySelectorAll('.diff-line-number-column').forEach(el => {
            el.innerHTML = '';
        });

        diff.forEach(part => {
            const lines = part.value.split('\n');
            const isAddition = part.added;
            const isRemoval = part.removed;
            
            const effectiveLines = lines.length > 1 ? lines.slice(0, -1) : lines;
            
            if (isAddition) {
                effectiveLines.forEach(line => {
                    currentHtml += `<div class="diff-line diff-line-added" data-line="${currentLineNumber}" data-type="added">${line}</div>`;
                    backupHtml += `<div class="diff-line diff-line-empty" data-line="${backupLineNumber}"> </div>`;
                    lineNumbersHtml += `<div class="diff-line-number" data-line="${currentLineNumber}">${currentLineNumber}</div>`;
                    currentLineNumber++;
                });
            } else if (isRemoval) {
                effectiveLines.forEach(line => {
                    currentHtml += `<div class="diff-line diff-line-empty" data-line="${currentLineNumber}"> </div>`;
                    backupHtml += `<div class="diff-line diff-line-removed" data-line="${backupLineNumber}" data-type="removed">${line}</div>`;
                    lineNumbersHtml += `<div class="diff-line-number" data-line="${currentLineNumber}">${currentLineNumber}</div>`;
                    backupLineNumber++;
                });
            } else {
                effectiveLines.forEach(line => {
                    currentHtml += `<div class="diff-line diff-line-unchanged" data-line="${currentLineNumber}">${line}</div>`;
                    backupHtml += `<div class="diff-line diff-line-unchanged" data-line="${backupLineNumber}">${line}</div>`;
                    lineNumbersHtml += `<div class="diff-line-number" data-line="${currentLineNumber}">${currentLineNumber}</div>`;
                    currentLineNumber++;
                    backupLineNumber++;
                });
            }
        });

        currentFileContentElement.innerHTML = currentHtml;
        backupFileContentElement.innerHTML = backupHtml;
        document.querySelectorAll('.diff-line-number-column').forEach(el => {
            el.innerHTML = lineNumbersHtml;
        });
    },

    mergeSingleChange: function(lineElement) {
        const lineNumber = parseInt(lineElement.getAttribute('data-line'));
        const changeType = lineElement.getAttribute('data-type');
        const version = this.versions[this.currentVersionIndex];
        
        let currentLines = this.currentFile.currentContent.split('\n');
        const backupLines = version.content.split('\n');
        
        if (changeType === 'added') {
            // Remove the added line
            currentLines.splice(lineNumber - 1, 1);
        } else if (changeType === 'removed') {
            // Add the removed line
            currentLines.splice(lineNumber - 1, 0, backupLines[lineNumber - 1]);
        }

        this.currentFile.currentContent = currentLines.join('\n');
        this.showVersion(this.currentVersionIndex);
        this.showToast('Change merged successfully');
    },

    restoreFile: function() {
        // Add safety checks before accessing versions
        if (!this.versions || this.versions.length === 0 || this.currentVersionIndex === null || this.currentVersionIndex === undefined) {
            console.warn("No versions available or no version selected");
            return;
        }
        
        const version = this.versions[this.currentVersionIndex];
        if (!version || !version.path) {
            console.warn("Selected version is invalid or missing path");
            return;
        }

        if (confirm(`Restore this file to the version from ${version.date.toLocaleString()}?`)) {
            // Call the global restoreFile function
            restoreFile(version.path);
            
            // Update local content
            this.currentFile.currentContent = version.content;
            this.showVersion(this.currentVersionIndex);
            
            // Close the diff modal
            this.closeModal();
            
            // Navigate to overview page
            Navigation.showSection('overview');
            
            // Add restore notification to activity feed ONLY
            this.addRestoreNotification(version);
        }
    },

    // Add this new function to handle the restore notification
    addRestoreNotification: function(version) {
        const fileName = version.path.split('/').pop();
        const timestamp = new Date().toISOString();
        
        // Create restore activity message
        const restoreActivity = {
            type: 'restore',
            title: 'File Restored',
            description: `"${fileName}" has been restored from backup`,
            timestamp: timestamp,
            fileName: fileName,
            versionTime: version.time || version.date.toLocaleString()
        };
        
        // Add to ActivityManager for persistence and display in activityFeed ONLY
        ActivityManager.addPersistedActivity(restoreActivity);
    },

    normalizeWhitespace: function(content) {
        if (!content) return '';
        return content.replace(/\s+/g, ' ').trim();
    },

    toggleIgnoreWhitespace: function() {
        this.ignoreWhitespace = !this.ignoreWhitespace;
        
        const toggleBtn = document.getElementById('ignoreWhitespaceToggle');
        const icon = toggleBtn.querySelector('i');
        
        if (this.ignoreWhitespace) {
            toggleBtn.classList.add('bg-indigo-100', 'text-indigo-700', 'border-indigo-300');
            toggleBtn.classList.remove('bg-gray-100', 'text-gray-700', 'border-gray-300');
            icon.className = 'bi bi-check-lg mr-1';
        } else {
            toggleBtn.classList.remove('bg-indigo-100', 'text-indigo-700', 'border-indigo-300');
            toggleBtn.classList.add('bg-gray-100', 'text-gray-700', 'border-gray-300');
            icon.className = 'bi bi-dash-lg mr-1';
        }
        
        // Re-render diff with new whitespace setting
        if (this.currentVersionIndex !== null && this.versions.length > 0) {
            const version = this.versions[this.currentVersionIndex];
            this.performDiff(this.currentFile.currentContent, version.content);
        }
        
        this.showToast(`Whitespace ${this.ignoreWhitespace ? 'ignored' : 'included'} in diff`);
    },

    showPreviousVersion: function() {
        if (this.currentVersionIndex < this.versions.length - 1) {
            this.showVersion(this.currentVersionIndex + 1);
            this.updateSliderPosition();
        }
    },

    showNextVersion: function() {
        if (this.currentVersionIndex > 0) {
            this.showVersion(this.currentVersionIndex - 1);
            this.updateSliderPosition();
        }
    },
};


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
                    BackupManager.checkDaemonStatus();  // Check if daemon is running and update status
                    
                    // Refresh suggested files when backup data loads
                    SuggestedFiles.load();
                    
                    // Search bar
                    this.searchInput.disabled = false;  // Enable searchbar
                } else {
                    // User did not registered a backup device yet
                    if (data.error.includes('Please select a backup device first')) {
                        elements.backupLocation.innerHTML = `
                            <span class="text-red-500">⚠️ Action Required</span>
                        `;
                        elements.backupUsage.innerHTML = `
                            <div class="text-sm">
                                ${data.error}
                                <button onclick="Navigation.showSection('devices')" 
                                        class="mt-2 text-indigo-600 hover:text-indigo-800 font-medium">
                                    Go to Devices Section Now →
                                </button>
                            </div>
                        `;
                        
                        elements.backupProgress.style.width = "0%";
                        elements.backupProgress.className = 'h-2 rounded-full bg-yellow-500';
                    }
                    else if (data.error.includes('device is not available')) {
                        BackupManager.updateUI(data);

                        // Search bar
                        this.searchInput.disabled = true;  // Disable searchbar

                        elements.backupLocation.innerHTML = `
                            <span class="text-red-500">⚠️ Action Required</span>
                        `;
                        elements.backupUsage.innerHTML = `
                            <div class="text-sm">
                                ${data.error}
                            </div>
                        `;
                        
                        elements.backupProgress.style.width = "0%";
                        elements.backupProgress.className = 'h-2 rounded-full bg-yellow-500';
                    } else {
                        // Handle other errors
                        elements.backupLocation.innerHTML = `
                            <span class="text-red-500">⚠️ Error</span>
                        `;
                        elements.backupUsage.innerHTML = `
                            <div class="text-sm">
                                ${data.error}
                            </div>
                        `;
                    }                        
                }
            })
            .catch(error => {
                console.error('Backup usage check failed:', error);
                elements.backupUsage.textContent = 
                    "Connection error. Please refresh the page.";
            });
    },

    updateUI: (data) => {
        if (data.success) {
            const displayLocation = data.location.replace(/\\/g, '/').replace(/\/$/, '');
            const pathParts = displayLocation.split('/').filter(part => part.trim() !== '');
            const displayName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : displayLocation;
            
            elements.backupLocation.textContent = displayLocation;
            // elements.sourceLocation.textContent = data.users_home_path;
            elements.sourceLocation.textContent = data.users_home_path;

            // User's home usage (Right Side)
            elements.homeUsage.textContent = `${data.home_human_used} used of ${data.home_human_total} (${data.home_percent_used}% used)`;

            // Backup device info (Center Position)
            elements.devicesName.textContent = data.device_name || displayName; // Use device_name if available
            elements.deviceMountPoint.textContent = displayLocation;
            elements.backupProgress.style.width = `${data.percent_used}%`;
            elements.backupUsage.textContent = 
                `${data.human_used} used of ${data.human_total} (${data.percent_used}% used)`;

            // Source device info "Left Side" HOME
            elements.deviceUsed.textContent = `${data.human_used} `;
            elements.deviceFree.textContent = `${data.human_free}`;
            elements.deviceTotal.textContent = `${data.human_total}`;

            elements.backupProgress.className = 'h-2 rounded-full';
            elements.backupProgress.classList.add(Utils.getUsageColorClass(data.percent_used));
            
            // Update the UI with the devices used space
            elements.devicesUsageBar.style.width = `${data.percent_used}%`;
            elements.devicesUsageBar.className = 'h-2 rounded-full';
            elements.devicesUsageBar.classList.add(Utils.getUsageColorClass(data.percent_used));
            
            // Update device details in the UI
            if (data.filesystem) {
                elements.devicesFilesystem.textContent = data.filesystem;
            }
            if (data.model) {
                elements.devicesModel.textContent = data.model;
            }
            
            // Update image count from summary if available
            if (data.summary && data.summary.categories) {
                const imagesCategory = data.summary.categories.find(cat => cat.name === "Image");
                const documentsCategory = data.summary.categories.find(cat => cat.name === "Document");
                const videosCategory = data.summary.categories.find(cat => cat.name === "Video");
                const otherCategory = data.summary.categories.find(cat => cat.name === "Others");
                
                // Images
                if (imagesCategory) {
                    elements.imagesCount.textContent = `${imagesCategory.count.toLocaleString()} files`;
                    elements.imagesSize.textContent = `${imagesCategory.size_str}`;
                }
                // Documents
                if (documentsCategory) {
                    elements.documentsCount.textContent = `${documentsCategory.count.toLocaleString()} files`;
                    elements.documentsSize.textContent = `${documentsCategory.size_str}`;
                }
                // Videos                   
                if (videosCategory) {
                    elements.videosCount.textContent = `${videosCategory.count.toLocaleString()} files`;
                    elements.videosSize.textContent = `${videosCategory.size_str}`;
                }
                // Other files
                if (otherCategory) {
                    elements.otherCount.textContent = `${otherCategory.count.toLocaleString()} files`;
                    elements.otherSize.textContent = `${otherCategory.size_str}`;
                }
            }
        } else {
            elements.backupLocation.textContent = "Error";
            elements.backupUsage.textContent = `Error: ${data.error || 'Unknown error'}`;
            elements.backupProgress.style.width = '0%';
            elements.backupProgress.className = 'h-2 rounded-full bg-gray-500';
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


// =============================================
// DEVICE MANAGEMENT
// =============================================
const DeviceManager = {
    load: () => {
        elements.devicesContainer.innerHTML = '<div class="text-gray-500 py-4">Scanning for devices...</div>';
        
        fetch('/api/storage/devices')
            .then(Utils.handleResponse)
            .then(data => {
                if (!data.devices || data.devices.length === 0) {
                    DeviceManager.showNoDevices();
                    return;
                }
                DeviceManager.render(data.devices);
            })
            .catch(error => {
                DeviceManager.showError(error);
            });
    },

    render: (devices) => {
        elements.devicesContainer.innerHTML = '';
        
        devices.forEach(device => {
            const normalized = DeviceManager.normalize(device);
            const card = DeviceManager.createCard(normalized);
            elements.devicesContainer.appendChild(card);
        });
        
        DeviceManager.setupSelection();
    },

    normalize: (device) => ({
        name: device.name || 'N/A',
        mount_point: device.mount_point || 'N/A',
        filesystem: device.filesystem || 'N/A',
        serial_number: device.serial_number || 'N/A',
        model: device.model || 'N/A',
        total: device.total || 0,
        used: device.used || 0,
        free: device.free || 0,
        human_total: device.human_total || '0 B',
        human_used: device.human_used || '0 B',
        human_free: device.human_free || '0 B'
    }),

    createCard: (device) => {
        const card = document.createElement('div');
        const percentUsed = device.total > 0 ? 
            Math.round((device.used / device.total) * 100) : 0;
        
        card.className = 'device-card bg-white p-4 rounded-lg border border-gray-200 shadow-xs cursor-pointer hover:border-indigo-300 transition-colors duration-200';
        card.setAttribute('data-device-path', device.mount_point);
        card.setAttribute('data-device-info', JSON.stringify(device));
        
        card.innerHTML = `
            <div class="flex items-start">
                <div class="${Utils.getDeviceIconClass(device)} p-3 rounded-lg mr-3">
                    <i class="${Utils.getDeviceIcon(device)}"></i>
                </div>
                <div class="flex-1">
                    <div class="font-medium truncate">${DeviceManager.getName(device)}</div>
                    <div class="text-sm text-gray-500 mt-1">${Utils.formatBytes(device.free)} free of ${Utils.formatBytes(device.total)}</div>
                    <div class="flex items-center mt-2 text-xs text-gray-500">
                        <i class="bi bi-geo-alt-fill mr-1"></i>
                        <span class="truncate">${device.mount_point}</span>
                    </div>
                </div>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2 mt-3">
                <div class="h-2 rounded-full ${Utils.getUsageColorClass(percentUsed)}" 
                    style="width: ${percentUsed}%"></div>
            </div>
            <div class="flex justify-between text-xs text-gray-500 mt-1">
                <span>${percentUsed}% used</span>
                <span>${device.filesystem || 'Unknown FS'}</span>
            </div>
        `;
        return card;
    },

    getName: (device) => {
        if (device.label) return device.label;
        if (device.mount_point?.match(/^[A-Z]:\\?$/)) {
            return `Local Disk (${device.mount_point.substring(0, 1)})`;
        }
        if (device.mount_point) {
            const parts = device.mount_point.split('/').filter(p => p.trim() !== '');
            if (parts.length > 0) return parts[parts.length - 1];
        }
        if (device.device) {
            return device.device.split('/').pop();
        }
        return 'Untitled Device';
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

    updateSelectionUI: () => {
        const { path, info } = appState.selectedDevice;
        const percentUsed = Math.round((info.used / info.total) * 100);
        
        elements.selectedDevicePath.textContent = path;
        elements.selectedDeviceStats.innerHTML = `
            ${Utils.formatBytes(info.free)} free of ${Utils.formatBytes(info.total)} •
            ${percentUsed}% used •
            ${info.filesystem || 'Unknown FS'}
        `;
        elements.selectedDeviceInfo.classList.remove('hidden');
    },

    // Save the selected device configuration
    confirmSelection: () => {
        if (!appState.selectedDevice) {
            alert('Please select a device first');
            return;
        }

        fetch('/api/backup/select-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: appState.selectedDevice.path,
                device_info: appState.selectedDevice.info
            })
        })
        .then(response => {
            if (!response.ok) throw new Error('Failed to save configuration');
            return response.json();
        })
        .then(data => {
            if (data.success) {
                // Now that we have a path, update usage
                return BackupManager.updateUsage();
            } else {
                throw new Error(data.error || 'Failed to save device');
            }
        })
        .catch(error => {
            console.error('Device selection failed:', error);
            // Show error to user
        });
    },

    showNoDevices: () => {
        elements.devicesContainer.innerHTML = `
            <div class="text-center py-8">
                <i class="bi bi-hdd-fill text-gray-300 text-4xl mb-2"></i>
                <div class="text-gray-500">No storage devices found</div>
                <div class="text-sm text-gray-400 mt-1">Connect a USB drive or external storage and click Refresh</div>
            </div>
        `;
    },

    showError: (error) => {
        elements.devicesContainer.innerHTML = `
            <div class="text-center py-8 text-red-500">
                <i class="bi bi-exclamation-triangle-fill text-xl mb-2"></i>
                <div>Error loading devices</div>
                <div class="text-sm text-gray-500 mt-1">${error.message}</div>
            </div>
        `;
    },

    showSelectionSuccess: () => {
        const btn = document.getElementById('confirmSelectionBtn');
        btn.innerHTML = '<i class="bi bi-check mr-2"></i> Selected!';
        btn.classList.replace('bg-indigo-600', 'bg-green-500');
        
        setTimeout(() => {
            btn.innerHTML = '<i class="bi bi-check mr-2"></i> Confirm Selection';
            btn.classList.replace('bg-green-500', 'bg-indigo-600');
            Navigation.showSection('overview');
        }, 2000);
    },

    // loadCurrent: () => {
    //     fetch('/api/backup/current-device')
    //         .then(Utils.handleResponse)
    //         .then(data => {
    //             if (typeof data === 'object' && data && data.success && data.device_path) {
    //                 const currentDeviceCard = document.querySelector(
    //                     `.device-card[data-device-path="${data.device_path}"]`
    //                 );
    //                 if (currentDeviceCard) currentDeviceCard.click();
    //             }
    //         });
    // }
};

// =============================================
// NAVIGATION
// =============================================
const Navigation = {
    setup: () => {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => 
                Navigation.showSection(item.getAttribute('data-section'))
            );
        });
        
        document.querySelectorAll('.px-4.py-2.text-sm.font-medium').forEach(tab => {
            tab.addEventListener('click', () => 
                Navigation.showSection(tab.getAttribute('data-section'))
            );
        });
    },

    showSection: (section) => {
        // Update active nav item
        document.querySelectorAll('.nav-item').forEach(navItem => {
            const isActive = navItem.getAttribute('data-section') === section;
            navItem.classList.toggle('active', isActive);            
            navItem.classList.toggle('bg-indigo-600', isActive); // Background color when active
            navItem.classList.toggle('text-white', isActive);  // Text color when active
            const icon = navItem.querySelector('i');
            icon.classList.toggle('text-white', isActive);  // Icon color when active
            icon.classList.toggle('text-gray-700', !isActive);    // Icon color when inactive
            const text = navItem.querySelector('span');
            text.classList.toggle('text-white', isActive);  // Text color when active
            text.classList.toggle('text-gray-700', !isActive);    // Text color when inactive
        });
        
        // Update active tab
        document.querySelectorAll('.px-4.py-2.text-sm.font-medium').forEach(tab => {
            tab.classList.toggle('tab-active', tab.getAttribute('data-section') === section);
        });
        
        // Update content section
        document.querySelectorAll('.content-section').forEach(sectionEl => {
            sectionEl.classList.toggle('active', sectionEl.id === `${section}-section`);
        });
        
        // Update main title
        const activeNavItem = document.querySelector(`.nav-item[data-section="${section}"] span`);
        if (activeNavItem) {
            elements.mainTitle.textContent = activeNavItem.textContent;
        }

        // Show/hide right sidebar based on section
        if (this.rightSidebar) {
            this.rightSidebar.classList.toggle('hidden', section !== 'overview');
        }
    }
};

// =============================================
// UI CONTROLS
// =============================================
const UIControls = {
    setup: () => {
        // Device management
        document.getElementById('refreshDevicesBtn').addEventListener('click', DeviceManager.load);
        
        // Section-specific handlers
        document.querySelector('[data-section="devices"]').addEventListener('click', DeviceManager.load);

        // Add this line to attach the event listener to realTimeCheckbox
        document.getElementById('realTimeCheckbox').addEventListener('change', BackupManager.toggle);

        // Diff Manager
        document.querySelectorAll('.action-btn.bg-yellow-50').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                DiffManager.showDiff(btn.closest('.file-item'));
            });
        });
        
        // Example: Button to trigger script execution (you may need to add this button in your HTML)
        // const runScriptButton = document.getElementById('runScriptButton'); // Replace with your button's ID
        // if (runScriptButton)
        //     runScriptButton.addEventListener('click', BackupManager.runMyScript);
    },

    setupToggles: () => {
        const watchedFoldersToggle = document.getElementById('watchedFoldersToggle');
        const watchedFoldersContent = document.getElementById('watchedFoldersContent');
        const watchedFoldersToggleIcon = document.getElementById('watchedFoldersToggleIcon');

        if (watchedFoldersToggle && watchedFoldersContent && watchedFoldersToggleIcon) {
            // Force styles to ensure clickability
            watchedFoldersToggle.style.cursor = 'pointer';
            watchedFoldersToggle.style.userSelect = 'none';
            
            // Add click listener with more aggressive event handling
            watchedFoldersToggle.addEventListener('click', function(event) {
                event.preventDefault();
                event.stopImmediatePropagation();
                
                const isHidden = watchedFoldersContent.classList.contains('hidden');
                
                // Toggle with force
                if (isHidden) {
                    watchedFoldersContent.classList.remove('hidden');
                    watchedFoldersToggleIcon.classList.remove('bi-chevron-up');
                    watchedFoldersToggleIcon.classList.add('bi-chevron-down');
                } else {
                    watchedFoldersContent.classList.add('hidden');
                    watchedFoldersToggleIcon.classList.remove('bi-chevron-down');
                    watchedFoldersToggleIcon.classList.add('bi-chevron-up');
                }
            });
        } 
    }
};

// =============================================
// FOLDER MANAGEMENT
// =============================================
const FolderManager = {
    loadWatchedFolders: () => {
        fetch('/api/watched-folders')
            .then(response => response.json())
            .then(data => {
                const tableBody = document.getElementById('watchedFoldersTable');
                tableBody.innerHTML = '';
                
                // Convert response to array if it's an object with folders property
                const folders = Array.isArray(data) ? data : (data.folders || []);
                
                // Now safely use forEach
                if (folders.length === 0) {
                    tableBody.innerHTML = `
                        <tr>
                            <td colspan="5" class="px-6 py-4 text-center text-gray-500">
                                No folders found in home directory
                            </td>
                        </tr>
                    `;
                    return;
                }

                folders.forEach(folder => {
                    const row = document.createElement('tr');
                    const excludedCount = folder.excluded_subfolders.length;
                    const lastActivity = new Date(folder.last_activity);
                    
                    // Different styling for Active/Inactive folders
                    const statusClass = folder.status === 'Active' ? 
                        'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800';
                    const iconColor = folder.status === 'Active' ? 
                        'text-indigo-500' : 'text-gray-500';
                    
                    // In the loadWatchedFolders function, update the button:
                    row.innerHTML = `
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium ${folder.to_backup ? 'text-gray-500' : 'text-gray-900'}">
                            <i class="bi bi-folder-fill mr-2 ${iconColor}"></i>
                            ${folder.name}
                            ${folder.to_backup ? '<span class="text-xs text-red-500 ml-2">(Excluded)</span>' : ''}
                        </td>
                        <td class="px-4 py-2 whitespace-nowrap">
                            <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusClass}">
                                ${folder.status}
                            </span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm ${folder.to_backup ? 'text-gray-400' : 'text-gray-500'}">
                            ${lastActivity.toLocaleTimeString()} ${lastActivity.toLocaleDateString()}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            ${excludedCount > 0 ? `
                                <button onclick="FolderManager.showExclusions(${JSON.stringify(folder.excluded_subfolders).replace(/"/g, '&quot;')})" 
                                        class="text-indigo-600 hover:text-indigo-900 mr-3"
                                        title="Open Location">
                                    <i class="bi bi-info-circle"></i>
                                </button>
                            ` : ''}
                            <!-- Use folder.to_backup directly for the action -->
                            <button onclick="FolderManager.folderInclusionExclusion('${folder.path}', ${folder.to_backup})"
                                    class="${folder.to_backup ? 'text-green-600 hover:text-green-900' : 'text-yellow-600 hover:text-yellow-900'} mr-3"
                                    title="${folder.to_backup ? 'Include in backup' : 'Exclude from backup'}">
                                <i class="bi ${folder.to_backup ? 'bi-plus-circle-fill' : 'bi-dash-circle-fill'}"></i>
                                ${folder.to_backup ? ' Include' : ' Exclude'}
                            </button>
                        </td>
                    `;
                    tableBody.appendChild(row);
                });
            })
            .catch(error => {
                console.error('Error loading watched folders:', error);
                document.getElementById('watchedFoldersTable').innerHTML = `
                    <tr>
                        <td colspan="5" class="px-6 py-4 text-center text-red-500">
                            Error loading folders: ${error.message}
                        </td>
                    </tr>
                `;
            });
    },

    // Handle Inclusion/Exclusion watched folders 
    folderInclusionExclusion: (folderPath, toBeBackup) => {
        // Disable the button and show loading state
        const buttons = document.querySelectorAll(`button[onclick*="${folderPath}"]`);
        buttons.forEach(button => {
            button.disabled = true;
            button.innerHTML = '<i class="bi bi-hourglass-split"></i> Updating...';
        });

        fetch('/api/folders/handle_folder_include_exclude', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: folderPath,
                to_backup: toBeBackup
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Reload the folder list to reflect the changes
                FolderManager.loadWatchedFolders(); // Refresh the list
                
                // Show a success message
                console.log('Folder status updated successfully');
            } else {
                alert('Failed to update folder status: ' + (data.error || 'Unknown error'));
                // Re-enable buttons on error
                FolderManager.loadWatchedFolders();
            }
        })
        .catch(error => {
            alert('Error updating folder status: ' + error.message);
            // Re-enable buttons on error
            FolderManager.loadWatchedFolders();
        });
    },
    
    showExclusions: (button, folders) => {
        // Create or show modal
        let modal = document.getElementById('exclusionModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'exclusionModal';
            modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 hidden';
            modal.innerHTML = `
                <div class="bg-white rounded-lg p-6 max-w-md w-full">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="text-lg font-medium">Excluded Subfolders</h3>
                        <button onclick="document.getElementById('exclusionModal').classList.add('hidden')" 
                                class="text-gray-500 hover:text-gray-700">
                            <i class="bi bi-clock-fill"></i>
                        </button>
                    </div>
                    <div id="exclusionList" class="max-h-96 overflow-y-auto"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        const list = document.getElementById('exclusionList');
        list.innerHTML = `
            <div class="text-sm mb-2">These subfolders are excluded from backup:</div>
            <ul class="list-disc list-inside bg-gray-50 p-3 rounded-lg">
                ${folders.map(f => `
                    <li class="py-1 text-gray-700">
                        <i class="bi bi-folder-fill r-minus mr-2"></i>
                        ${f || '(root)'}
                    </li>
                `).join('')}
            </ul>
            <div class="mt-3 text-xs text-gray-500">
                To change exclusions, edit the settings.
            </div>
        `;
        
		modal.classList.remove('hidden');
    },

	showAddExclusion: function(folderPath) {
		let modal = document.getElementById('addExclusionModal');
		if (!modal) {
			modal = document.createElement('div');
			modal.id = 'addExclusionModal';
			modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 hidden';
			modal.innerHTML = `
				<div class="bg-white rounded-lg p-6 max-w-md w-full">
					<div class="flex justify-between items-center mb-4">
						<h3 class="text-lg font-medium">Add Exclusion</h3>
						<button onclick="document.getElementById('addExclusionModal').classList.add('hidden')" 
								class="text-gray-500 hover:text-gray-700">
							<i class="bi bi-clock-fill"></i>
						</button>
					</div>
					<div class="mb-4">
						<label for="exclusionPath" class="block text-sm font-medium text-gray-700">Subfolder to Exclude:</label>
						<input type="text" name="exclusionPath" id="exclusionPath" class="mt-1 focus:ring-indigo-500 focus:border-indigo-500 block w-full shadow-sm sm:text-sm border-gray-300 rounded-md">
					</div>
					<button onclick="FolderManager.addExclusion('${folderPath}')" class="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700">
						Add Exclusion
					</button>
				</div>
			`;
			document.body.appendChild(modal);
		}

		const input = document.getElementById('exclusionPath');
		input.value = ''; // Clear previous value
		modal.classList.remove('hidden');
	},

	addExclusion: function(parentFolderPath) {
		const exclusionPathInput = document.getElementById('exclusionPath');
		const exclusionPath = exclusionPathInput.value.trim();
	
		if (!exclusionPath) {
			alert('Please enter a subfolder path to exclude.');
			return;
		}
	
		let fullExclusionPath;
		if (exclusionPath.startsWith('/')) {
			// Absolute path
			fullExclusionPath = exclusionPath;
		} else {
			// Relative path - combine with the parent folder path
			fullExclusionPath = `${parentFolderPath}/${exclusionPath}`;
		}
	
		// Validate that the full exclusion path is actually within the parent folder
		if (!fullExclusionPath.startsWith(parentFolderPath)) {
			alert('The exclusion path must be within the main folder.');
			return;
		}
	
		fetch('/api/folders/add-exclusion', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				parent_path: parentFolderPath,
				exclusion_path: fullExclusionPath
			})
		})
		.then(response => response.json())
		.then(data => {
			if (data.success) {
				document.getElementById('addExclusionModal').classList.add('hidden'); // Close modal
				FolderManager.loadWatchedFolders(); // Refresh the list
				alert('Exclusion added successfully.');
			} else {
				alert('Failed to add exclusion: ' + (data.error || 'Unknown error'));
			}
		})
		.catch(error => {
			alert('Error adding exclusion: ' + error.message);
		});
    }    
};


// =============================================
// ACTIVITY MANAGER FOR DAEMON MESSAGES (PERSISTENT)
// =============================================
const ActivityManager = {
    activities: [],
    intervals: {},
    currentActivities: new Map(),
    messageCount: 0,
    
    init: function() {
        this.loadPersistedActivities(); // Load from localStorage
        this.clearAllIntervals();
        this.setupAutoCleanup();
        this.setupTimeUpdates(); // Auto-update timestamps
    },
    
    // Load activities from localStorage
    loadPersistedActivities: function() {
        try {
            const stored = localStorage.getItem('backupActivities');
            if (stored) {
                this.activities = JSON.parse(stored);
                this.renderPersistedActivities();
            }
        } catch (error) {
            console.error('Error loading persisted activities:', error);
            this.activities = [];
        }
    },
    
    // Save activities to localStorage
    savePersistedActivities: function() {
        try {
            // Only keep the most recent activities (respect MAX_LOG_ITEMS)
            const activitiesToSave = this.activities.slice(-MAX_LOG_ITEMS);
            localStorage.setItem('backupActivities', JSON.stringify(activitiesToSave));
        } catch (error) {
            console.error('Error saving activities:', error);
        }
    },
    
    // Render persisted activities on page load
    renderPersistedActivities: function() {
        const activityFeed = document.getElementById('activityFeed');
        if (!activityFeed) return;
        
        activityFeed.innerHTML = '';
        
        // Sort by timestamp (newest first) and limit to MAX_LOG_ITEMS
        const sortedActivities = [...this.activities]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, MAX_LOG_ITEMS);
        
        sortedActivities.forEach(activity => {
            const item = this.createActivityHTML(activity);
            activityFeed.appendChild(this.createElementFromHTML(item));
        });
        
        this.updateAllTimestamps(); // Initial timestamp update
    },
    
    // Create appropriate HTML based on activity type
    createActivityHTML: function(activity) {
        const timeAgo = this.formatTimeAgo(activity.timestamp);
        
        switch(activity.type) {
            case 'analyzing':
                return this.createAnalyzingHTML(activity);
            case 'progress':
                return this.createProgressHTML(activity);
            case 'completed':
                return this.createCompletedHTML(activity);
            case 'warning':
                return this.createWarningHTML(activity);
            case 'info':
                return this.createNewFolderHTML(activity);
            case 'restore':
                return this.createRestoreHTML(activity);
            default:
                return this.createGenericHTML(activity);
        }
    },
    
    // Get icon configuration based on activity type
    getIconConfig: function(type) {
        const configs = {
            'completed': { bg: 'bg-green-100', text: 'text-green-600', icon: 'bi bi-check-circle' },
            'warning': { bg: 'bg-yellow-100', text: 'text-yellow-600', icon: 'bi bi-exclamation-triangle-fill' },
            'info': { bg: 'bg-purple-100', text: 'text-purple-600', icon: 'bi bi-folder-fill' },
            'analyzing': { bg: 'bg-blue-100', text: 'text-blue-600', icon: 'bi bi-search' },
            'progress': { bg: 'bg-indigo-100', text: 'text-indigo-600', icon: 'bi bi-copy' },
            'default': { bg: 'bg-gray-100', text: 'text-gray-600', icon: 'bi bi-info-circle' }
        };
        
        return configs[type] || configs.default;
    },
    
    // Setup interval to update timestamps
    setupTimeUpdates: function() {
        // Update timestamps every minute
        this.intervals.timeUpdate = setInterval(() => {
            this.updateAllTimestamps();
        }, 60000); // Every minute
    },
    
    // Update all timestamp displays
    updateAllTimestamps: function() {
        document.querySelectorAll('[data-time-ago]').forEach(element => {
            const timestamp = element.getAttribute('data-time-ago');
            element.textContent = this.formatTimeAgo(timestamp);
        });
    },
    
    // Add activity with persistence
    addPersistedActivity: function(message) {
        // Create activity object
        const activity = {
            type: message.type,
            title: message.title,
            description: message.description,
            timestamp: message.timestamp || new Date().toISOString(),
            // Include any additional data needed for specific types
            ...(message.progress !== undefined && { progress: message.progress }),
            ...(message.processed !== undefined && { processed: message.processed }),
            ...(message.eta !== undefined && { eta: message.eta })
        };
        
        // Add to activities array
        this.activities.push(activity);
        
        // Limit the total number of stored activities
        if (this.activities.length > MAX_LOG_ITEMS * 2) { // Keep some buffer
            this.activities = this.activities.slice(-MAX_LOG_ITEMS);
        }
        
        // Save to localStorage
        this.savePersistedActivities();
        
        // Render immediately if this is a new activity
        if (!message.isPersisted) {
            this.renderNewActivity(activity);
        }
    },
    
    // Render a single new activity
    renderNewActivity: function(activity) {
        const activityFeed = document.getElementById('activityFeed');
        if (!activityFeed) return;
        
        const item = this.createActivityHTML(activity);
        activityFeed.insertBefore(
            this.createElementFromHTML(item), 
            activityFeed.firstChild
        );
        
        this.limitActivityFeed();
        this.updateAllTimestamps();
    },

    clearAllIntervals: function() {
        Object.values(this.intervals).forEach(interval => {
            if (interval) clearInterval(interval);
        });
        this.intervals = {};
    },

    setupAutoCleanup: function() {
        // Clean up old activities every hour
        this.intervals.cleanup = setInterval(() => {
            this.cleanupOldActivities();
        }, 3600000); // 1 hour
    },

    cleanupOldActivities: function() {
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)); // Keep for 1 week
        
        // Remove activities older than 1 week
        const initialCount = this.activities.length;
        this.activities = this.activities.filter(activity => 
            new Date(activity.timestamp) > oneWeekAgo
        );
        
        if (this.activities.length !== initialCount) {
            this.savePersistedActivities();
            this.renderPersistedActivities();
        }
    },

    // Analyzing Activities (non-persistent until complete)
    updateAnalyzingActivity: function(message) {
        let analyzingItem = document.querySelector('.activity-item[data-type="analyzing"]');
        
        if (!analyzingItem) {
            analyzingItem = this.createElementFromHTML(this.createAnalyzingHTML(message));
            document.getElementById('activityFeed').prepend(analyzingItem);
        } else {
            analyzingItem.querySelector('.analyzing-description').textContent = message.description;
            analyzingItem.querySelector('.analyzing-progress').style.width = message.progress + '%';
            analyzingItem.querySelector('.analyzing-count').textContent = message.processed + ' files processed';
        }
    },
    
    // Progress Activities (non-persistent until complete)
    updateBackupProgress: function(message) {
        let progressItem = document.querySelector('.activity-item[data-type="progress"]');
        
        if (!progressItem) {
            progressItem = this.createElementFromHTML(this.createProgressHTML(message));
            document.getElementById('activityFeed').prepend(progressItem);
        } else {
            progressItem.querySelector('.progress-description').textContent = message.description;
            progressItem.querySelector('.progress-bar').style.width = message.progress + '%';
            progressItem.querySelector('.progress-status').textContent = message.progress + '% completed';
            progressItem.querySelector('.progress-eta').textContent = message.eta;
        }
    },

    // Completion activity (persistent)
    addCompletedActivity: function(message) {
        this.addPersistedActivity({
            type: 'completed',
            title: message.title,
            description: message.description,
            timestamp: message.timestamp || new Date().toISOString()
        });
    },

    // Warning activity (persistent)
    addWarningActivity: function(message) {
        this.addPersistedActivity({
            type: 'warning',
            title: message.title,
            description: message.description,
            timestamp: message.timestamp || new Date().toISOString()
        });
    },

    // New folder activity (persistent)
    addNewFolderActivity: function(message) {
        this.addPersistedActivity({
            type: 'info',
            title: message.title,
            description: message.description,
            timestamp: message.timestamp || new Date().toISOString()
        });
    },

    // Render all activities
    createElementFromHTML: function(htmlString) {
        const div = document.createElement('div');
        div.innerHTML = htmlString.trim();
        return div.firstChild;
    },
    
    // Generic activity HTML for persisted items
    createGenericHTML: function(activity) {
        const timeAgo = this.formatTimeAgo(activity.timestamp);
        
        return `
            <div class="flex items-start activity-item" data-timestamp="${activity.timestamp}">
                <div class="${iconConfig.bg} ${iconConfig.text} p-2 rounded-full mr-3">
                    <i class="${iconConfig.icon} text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${activity.title}</div>
                    <div class="text-xs text-gray-500 mt-1">${activity.description}</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createAnalyzingHTML: function(message) {
        const timeAgo = this.formatTimeAgo(message.timestamp);
        return `
            <div class="flex items-start activity-item" data-type="analyzing" data-timestamp="${message.timestamp}">
                <div class="bg-blue-100 text-blue-600 p-2 rounded-full mr-3">
                    <i class="bi bi-search text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${message.title}</div>
                    <div class="text-xs text-gray-500 mt-1 analyzing-description">${message.description}</div>
                    <div class="w-full bg-gray-200 rounded-full h-1 mt-2">
                        <div class="bg-blue-500 h-1 rounded-full analyzing-progress" style="width: ${message.progress}%"></div>
                    </div>
                    <div class="text-xs text-gray-400 mt-1 analyzing-count">${message.processed} files processed</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createProgressHTML: function(message) {
        const timeAgo = this.formatTimeAgo(message.timestamp);
        return `
            <div class="flex items-start activity-item" data-type="progress" data-timestamp="${message.timestamp}">
                <div class="bg-indigo-100 text-indigo-600 p-2 rounded-full mr-3">
                    <i class="bi bi-copy text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${message.title}</div>
                    <div class="text-xs text-gray-500 mt-1 truncate progress-description">${message.description}</div>
                    <div class="w-full bg-gray-200 rounded-full h-1 mt-2">
                        <div class="bg-indigo-500 h-1 rounded-full progress-bar" style="width: ${message.progress}%"></div>
                    </div>
                    <div class="flex justify-between text-xs text-gray-400 mt-1">
                        <span class="progress-status">${message.progress}% completed</span>
                        <span class="progress-eta">${message.eta}</span>
                    </div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createCompletedHTML: function(message) {
        const timeAgo = this.formatTimeAgo(message.timestamp);
        return `
            <div class="flex items-start activity-item" data-timestamp="${message.timestamp}">
                <div class="bg-green-100 text-green-600 p-2 rounded-full mr-3">
                    <i class="bi bi-check-circle text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${message.title}</div>
                    <div class="text-xs text-gray-500 mt-1">${message.description}</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createWarningHTML: function(message) {
        const timeAgo = this.formatTimeAgo(message.timestamp);
        return `
            <div class="flex items-start activity-item" data-timestamp="${message.timestamp}">
                <div class="bg-yellow-100 text-yellow-600 p-2 rounded-full mr-3">
                    <i class="bi bi-exclamation-triangle-fill text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${message.title}</div>
                    <div class="text-xs text-gray-500 mt-1">${message.description}</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createNewFolderHTML: function(message) {
        const timeAgo = this.formatTimeAgo(message.timestamp);
        return `
            <div class="flex items-start activity-item" data-timestamp="${message.timestamp}">
                <div class="bg-purple-100 text-purple-600 p-2 rounded-full mr-3">
                    <i class="bi bi-folder-fill text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${message.title}</div>
                    <div class="text-xs text-gray-500 mt-1">${message.description}</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    createRestoreHTML: function(activity) {
        const timeAgo = this.formatTimeAgo(activity.timestamp);
        return `
            <div class="flex items-start activity-item" data-timestamp="${activity.timestamp}">
                <div class="bg-green-100 text-green-600 p-2 rounded-full mr-3">
                    <i class="bi bi-arrow-clockwise text-sm"></i>
                </div>
                <div class="flex-1">
                    <div class="text-sm font-medium">${activity.title}</div>
                    <div class="text-xs text-gray-500 mt-1">${activity.description}</div>
                    <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
                </div>
            </div>
        `;
    },

    // Format time ago with auto-updating capability
    formatTimeAgo: function(timestamp) {
        try {
            const now = new Date();
            const messageTime = new Date(timestamp);
            
            if (isNaN(messageTime.getTime())) {
                return 'Just now';
            }
            
            const diffMs = now - messageTime;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffHours / 24);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
            if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            
            // For days only - no dates!
            return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            
        } catch (error) {
            return 'Just now';
        }
    },

    // Update connection status
    updateConnectionStatus: function(connected) {
        const statusElement = document.getElementById('connectionStatus');
        if (statusElement) {
            if (connected) {
                statusElement.innerHTML = '<span class="text-green-300 mr-2">●</span><span>Connected</span>';
            } else {
                statusElement.innerHTML = '<span class="text-red-300 mr-2">●</span><span>Disconnected</span>';
            }
        }
    },

    // Update last update
    updateLastUpdate: function() {
        const lastUpdateElement = document.getElementById('lastUpdate');
        if (lastUpdateElement) {
            lastUpdateElement.textContent = new Date().toLocaleTimeString();
        }
    },

    // Limit number of notification under Recents Activities
    limitActivityFeed: function() {
        const activityFeed = document.getElementById('activityFeed');
        if (!activityFeed) return;

        // The last child is the OLDEST log entry because we use prepend()
        while (activityFeed.children.length > MAX_LOG_ITEMS) {
            activityFeed.removeChild(activityFeed.lastChild);
        }
    },
    
    clearAnalyzingActivity: function() {
        const analyzingItem = document.querySelector('.activity-item[data-type="analyzing"]');
        if (analyzingItem) {
            analyzingItem.remove();
        }
    },
    
    clearProgressActivity: function() {
        const progressItem = document.querySelector('.activity-item[data-type="progress"]');
        if (progressItem) {
            progressItem.remove();
        }
    },
    
    clearAllActiveActivities: function() {
        this.clearAnalyzingActivity();
        this.clearProgressActivity();
    },

    // Clear all persisted activities (for debugging or user action)
    clearAllPersistedActivities: function() {
        this.activities = [];
        localStorage.removeItem('backupActivities');
        const activityFeed = document.getElementById('activityFeed');
        if (activityFeed) {
            activityFeed.innerHTML = '<div class="text-gray-500 py-4 text-center">No recent activities</div>';
        }
    },

    // Get activity count
    getActivityCount: function() {
        return this.activities.length;
    },

    // Export activities (for debugging)
    exportActivities: function() {
        return JSON.stringify(this.activities, null, 2);
    }
};

// Clear all notification
document.getElementById('clearActivityBtn').addEventListener('click', () => {
    ActivityManager.clearAllPersistedActivities();
});


// =============================================
// PRO ACCESS
// =============================================
const ProAccessManager = {
    showDialog: function() {
    const proModal = document.getElementById('pro-modal');
        const closeModalBtn = document.getElementById('close-modal-btn');
        const modalContent = document.getElementById('modal-content-container');

        const openModal = () => {
            // Show modal overlay
            proModal.classList.remove('opacity-0', 'pointer-events-none');
            proModal.classList.add('opacity-100');
            // Animate content in
            modalContent.classList.remove('scale-95');
            modalContent.classList.add('scale-100');
        };

        const closeModal = () => {
            // Animate content out
            modalContent.classList.remove('scale-100');
            modalContent.classList.add('scale-95');
            // Hide modal overlay after transition (300ms)
            setTimeout(() => {
                proModal.classList.remove('opacity-100');
                proModal.classList.add('opacity-0', 'pointer-events-none');
            }, 300);
        };

        // Event Listeners
        if (ctaButton) {
            ctaButton.addEventListener('click', openModal);
        }
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', closeModal);
        }
        
        // Close when clicking on the overlay background
        if (proModal) {
            proModal.addEventListener('click', (e) => {
                if (e.target === proModal) {
                    closeModal();
                }
            });
        }

        // Close when pressing the ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && proModal.classList.contains('opacity-100')) {
                closeModal();
            }
        });
    }};


// =============================================
// DEVICE SELECTION HANDLER
// =============================================
const DeviceSelection = {
    // Stores the element reference for the currently highlighted device
    _currentSelectedElement: null, 

    init: () => {
        // Listener for selecting a device from the list
        elements.devicesContainer.addEventListener(
            'click', DeviceSelection.handleDeviceClick);

        // Listener for the confirmation button (the save action)
        elements.confirmSelectionBtn.addEventListener(
            'click', DeviceSelection.handleConfirmSelection);
        
        // Disable the button initially
        DeviceSelection.toggleConfirmButton(false);
    },

    // Helper to control the button state and appearance
    toggleConfirmButton: (enable) => {
        elements.confirmSelectionBtn.disabled = !enable;
        if (enable) {
            elements.confirmSelectionBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            elements.confirmSelectionBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
    },

    // Handles the temporary selection of a device
    handleDeviceClick: (event) => {
        // Assuming your device list items have a class 'device-item' and a data-device-info attribute
        const deviceItem = event.target.closest('.device-card'); 
        if (!deviceItem) return;

        // 1. Clear previous selection state (visual)
        if (DeviceSelection._currentSelectedElement) {
            DeviceSelection._currentSelectedElement.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-50');
        }

        // 2. Highlight the newly selected device (visual)
        deviceItem.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-50');
        DeviceSelection._currentSelectedElement = deviceItem;

        // 3. Store the device info in AppState (data)
        try {
            // Assuming the full device info is stored in a data attribute
            const infoString = deviceItem.getAttribute('data-device-info');
            const info = JSON.parse(infoString);
            appState.selectedDevice = info; // Store the full device object
            
            // Update the temporary selection UI details
            // (You might have other UI elements to update here)
            elements.selectedDevicePath.textContent = info.mount_point;
            
            // 4. Enable the confirmation button
            DeviceSelection.toggleConfirmButton(true);
            
        } catch (e) {
            console.error("Error setting device info:", e);
            appState.selectedDevice = null; // Clear state on error
            DeviceSelection.toggleConfirmButton(false);
        }
    },

    // In DeviceSelection.handleConfirmSelection, after the device is successfully selected:
    handleConfirmSelection: async () => {
        const selectedDevice = appState.selectedDevice;
        if (!selectedDevice) {
            console.warn("No device selected to confirm.");
            return;
        }

        DeviceSelection.toggleConfirmButton(false);
        elements.confirmSelectionBtn.textContent = 'Saving...';
        
        try {
            const response = await fetch('/api/backup/select-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_info: selectedDevice }) 
            });

            const result = await response.json();

            if (result.success) {
                console.log('Device configured successfully:', result.path);
                
                // Clear search cache for new backup location
                await fetch('/api/refresh-search-index', { method: 'POST' });
                
                // Refresh suggested files for new backup location
                SuggestedFiles.load();
                
                // Clear any cached search results on frontend
                window.latestSearchResults = null;
                
                // Change navigation view to Overview
                Navigation.showSection('overview'); 
                
                // Clear the temporary state
                appState.selectedDevice = null;
                
                console.log('Search cache and suggested files refreshed for new backup device');
                
            } else {
                console.error('Failed to select device:', result.error);
            }
        } catch (e) {
            console.error('Network error during device selection:', e);
        } finally {
            elements.confirmSelectionBtn.textContent = 'Confirm Selection';
        }
    },
};


// =============================================
// FILE SECTION
// =============================================
// --- DOM Elements & State ---
const currentFileContentElement = document.getElementById('currentFileContent');
const backupFileContentElement = document.getElementById('backupFileContent');
const currentHeaderSpan = document.getElementById('currentVersionTime');
const backupHeaderSpan = document.getElementById('backupVersionTime');
const versionPillsContainer = document.getElementById('version-pills-container');
const fileListContainer = document.getElementById('file-list-container');
const currentFileNameDisplay = document.getElementById('currentFileNameDisplay');
const demoMessageBox = document.getElementById('demo-message');
const backupVersionActionsContainer = document.getElementById('backupVersionActions');
const openFile = document.getElementById('openFileBtn');
const openLocation = document.getElementById('openLocationBtn');
const ctaButton = document.getElementById('ctaButton');

// --- Global State ---
// Global state to track currently selected file and version
let currentFileKey = '';
let currentBackupVersionKey = null; // Will be set to the latest non-current version

/**
 * Handles the click on the action menu items (restore, open, etc.).
 * @param {string} action The action to perform ('restore', 'open', 'open-location').
 * @param {string} versionKey The key of the version to act upon.
 */
function handleVersionAction(action, versionKey) {
    let fileObj = null;
    if (window.latestSearchResults) {
        fileObj = window.latestSearchResults.find(f => f.name === currentFileKey);
    }
    if (!fileObj || !fileObj.versions) return;

    const version = fileObj.versions[versionKey];
    if (!version || !version.path) {
        console.error(`Version or path not found for key: ${versionKey}`);
        return;
    }

    const filePath = version.path;

    switch (action) {
        case 'restore':
            restoreFile(filePath);
            break;
        case 'open':
            openFileInDefaultApp(filePath); // Use openPathInExplorer for files too
            break;
        case 'open-location':
            openPathInExplorer(filePath.substring(0, filePath.lastIndexOf('/')));
            break;
    }
}


/**
 * Handles selecting a new file from the sidebar.
 * @param {string} fileName - The key of the file to select.
 */
async function selectFile(fileName) {
    let fileObj = null;
    if (window.latestSearchResults) {
        fileObj = window.latestSearchResults.find(f => f.name === fileName);
    }
    const filePath = fileObj && fileObj.path ? fileObj.path : fileName;

    currentFileKey = fileName;
    currentFileNameDisplay.textContent = fileName;
    currentBackupVersionKey = null;

    // Fetch versions from backend
    const versionsArray = await fetchFileVersions(filePath);

    // Convert array to object for compatibility with existing code
    const versionsObj = {};
    versionsArray.forEach((v, idx) => {
        versionsObj[v.key || `v${idx+1}`] = v;
    });
    fileObj.versions = versionsObj;

    // Get backup versions for this file
    getFileBackupVersions(fileObj);

    // Auto-select the first available version (will handle .main_backup only case)
    autoSelectLatestBackupVersion(); // No parameter = auto-select logic
}

/**
 * Renders the list of version pills for the selected file.
 * Each pill represents a backup/version (e.g., "Yesterday 11:00 AM (V1)").
 */
function getFileBackupVersions(fileObj) {
    versionPillsContainer.innerHTML = ''; // Clear previous pills
    if (!fileObj || !fileObj.versions) return;

    // Convert versions object to array for sorting
    const versionsArr = Object.entries(fileObj.versions).map(([key, v]) => ({ key, ...v }));

    // Sort by time descending (latest first)
    versionsArr.sort((a, b) => {
        // Handle both string and number time formats
        let aTime = typeof a.time === 'number' ? a.time : parseVersionTime(a.time);
        let bTime = typeof b.time === 'number' ? b.time : parseVersionTime(b.time);
        return bTime - aTime;
    });

    versionsArr.forEach(version => {
        // Skip Current Version.
        if (version.key === 'home') return;

        let formattedTime = version.time;
        if (typeof version.time === 'number') {
            const date = new Date(version.time * 1000);
            formattedTime = date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } else if (typeof version.time === 'string') {
            const match = version.time.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2})-(\d{2})$/);
            if (match) {
                const [_, day, month, year, hour, minute] = match;
                const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);
                formattedTime = date.toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
            }
        }
        const pillHtml = `
            <span data-version="${version.key}" class="version-pill px-3 py-1 text-xs font-medium rounded-full cursor-pointer shadow-sm whitespace-nowrap bg-gray-200 text-gray-700 hover:bg-gray-300">
                <i class="bi bi-clock-fill mr-1"></i> ${formattedTime}
            </span>
        `;
        versionPillsContainer.insertAdjacentHTML('beforeend', pillHtml);
    });
}

// Helper to parse "DD-MM-YYYY HH-mm" string to timestamp (seconds)
function parseVersionTime(str) {
    const match = str.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2})-(\d{2})$/);
    if (match) {
        const [_, day, month, year, hour, minute] = match;
        return new Date(`${year}-${month}-${day}T${hour}:${minute}:00`).getTime() / 1000;
    }
    return 0;
}

/**
 * Renders metadata view for binary files.
 * @param {object} metadata - Metadata object from backend.
 */
function renderMetadataView(metadata) {
    console.log('Rendering metadata view:', metadata);
    const { iconClass, iconColor } = getFileIconDetails(metadata.path || metadata.name);
    const fileName = metadata.path ? metadata.path.split('/').pop() : 'Unknown file';
    
    // Format size properly
    let sizeDisplay = 'Unknown size';
    if (metadata.size) {
        if (typeof metadata.size === 'string' && metadata.size.includes('bytes')) {
            // Convert "191304234 bytes" to formatted size
            const sizeBytes = parseInt(metadata.size);
            sizeDisplay = !isNaN(sizeBytes) ? Utils.formatBytes(sizeBytes) : metadata.size;
        } else {
            sizeDisplay = Utils.formatBytes(metadata.size);
        }
    }

    return `
        <div class="p-6 h-full flex flex-col items-center justify-center text-center text-gray-600 bg-white rounded-xl">
            <i class="${iconClass} text-5xl ${iconColor} mb-4"></i>
            <p class="text-lg font-semibold mb-2">${fileName}</p>
            <p class="text-sm mb-4">This is a binary file. Textual content comparison is not available.</p>
            <div class="mt-4 p-3 bg-gray-50 rounded-lg w-full max-w-sm">
                ${metadata.path ? `<p class="text-xs font-medium text-gray-700 truncate">Path: ${metadata.path}</p>` : ''}
                ${metadata.mtime ? `<p class="text-xs font-medium text-gray-700">Modified: ${metadata.mtime}</p>` : ''}
                <p class="text-xs font-medium text-gray-700">Size: ${sizeDisplay}</p>
                ${metadata.type ? `<p class="text-xs mt-1 italic">Type: ${metadata.type}</p>` : ''}
            </div>
        </div>
    `;
}

// <p class="text-xs font-medium text-gray-700">Modified: ${metadata.mtime || ''}</p>
// <p class="text-xs ffont-medium text-gray-700">Size: ${metadata.size || ''}</p>  
// <p class="text-xs font-medium text-gray-700">Size: ${Utils.formatBytes(metadata.size || 0)}</p>
// ${metadata.type ? `<p class="text-xs mt-1 italic">Type: ${metadata.type}</p>` : ''}
// ${metadata.metadata ? `<p class="text-xs mt-1 italic">${metadata.metadata}</p>` : ''}


function styleDiffContent(content, isBackup = false) {
    if (!content) return '';
    
    const lines = content.split('\n');
    return lines.map(line => {
        const escapedLine = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div class="diff-line ${isBackup ? 'diff-line-backup' : 'diff-line-current'}">${escapedLine}</div>`;
    }).join('');
}



/**
 * Switches the content displayed in the backup (right) pane for comparison.
 * The current (left) pane always shows the latest version of the selected file.
 * @param {string} versionKey - The version key (e.g., 'v2', 'v1').
 */
function autoSelectLatestBackupVersion(versionKey) {
    // Find the file object from latestSearchResults
    let fileObj = null;
    if (window.latestSearchResults) {
        fileObj = window.latestSearchResults.find(f => f.name === currentFileKey);
    }
    if (!fileObj || !fileObj.versions) return;

    // If no versionKey provided, auto-select the first available backup version
    if (!versionKey) {
        const availableVersions = Object.keys(fileObj.versions);
        
        // Try to find a non-home version first (backup versions)
        const backupVersion = availableVersions.find(key => key !== 'home');
        
        // If no backup version found but we have home version, use that
        if (!backupVersion && availableVersions.length > 0) {
            versionKey = availableVersions[0]; // Use home version as fallback
        } else {
            versionKey = backupVersion;
        }
        
        // If still no versionKey, return
        if (!versionKey) return;
    }

    const selectedVersion = fileObj.versions[versionKey];
    if (!selectedVersion) return;

    currentBackupVersionKey = versionKey;

    // 1. Update the display times
    currentHeaderSpan.textContent = 'Current Version';
    backupHeaderSpan.textContent = selectedVersion.time || 'Main Backup';

    // 2. Handle Content Display (Diff or Metadata)
    if (fileObj.type === 'text') {
        // For text files, show content comparison
        currentFileContentElement.innerHTML = styleDiffContent(
            fileObj.versions.home?.content || 'No current version content', 
            false
        ); 
        backupFileContentElement.innerHTML = styleDiffContent(
            selectedVersion.content || 'No backup version content', 
            true
        );
    } else {
        // For binary files, show metadata view
        currentFileContentElement.innerHTML = renderMetadataView(
            fileObj.versions.home || { path: currentFileKey, size: 0 }
        );
        backupFileContentElement.innerHTML = renderMetadataView(selectedVersion);
    }

    // 3. Update active pill CSS (Visual only)
    document.querySelectorAll('.version-pill').forEach(pill => {
        pill.classList.remove('bg-indigo-600', 'text-white', 'shadow-md');
        pill.classList.add('bg-gray-200', 'text-gray-700', 'hover:bg-gray-300');
    });

    const activePill = document.querySelector(`.version-pill[data-version="${versionKey}"]`);
    if (activePill) {
        activePill.classList.remove('bg-gray-200', 'text-gray-700', 'hover:bg-gray-300');
        activePill.classList.add('bg-indigo-600', 'text-white', 'shadow-md');
    } else {
        // If no pill exists (like for 'home' version), create a visual indicator
        console.log(`No pill found for version: ${versionKey}`);
    }
}


/**
 * /**
 * Fetches file versions from the backend.
 * @param {string} filePath - The path of the file to fetch versions for.
 * @returns {Promise<Array>} A promise that resolves to an array of version objects.
 */
async function fetchFileVersions(filePath) {
    try {
        console.log('Fetching versions for:', filePath);
        
        const response = await fetch(`/api/file-versions?file_path=${encodeURIComponent(filePath)}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to fetch file versions');
        }
        
        console.log('Found versions:', data.versions);
        return data.versions || [];
        
    } catch (error) {
        console.error('Error fetching file versions:', error);
        showNotification('Could not load file versions: ' + error.message, 'error');
        return [];
    }
}


// =============================================
// PAGE LOADED
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    // Initialize main app
    App.init();
    
    // Initialize ActivityManager
    ActivityManager.init();
    
    // Initialize WebSocket client
    window.backupStatusClient = new BackupStatusClient();
    
    // Create a debounced version of fetchAndRenderFiles
    // Adjust the delay (e.g., 500ms) as needed for your application's responsiveness
    const debouncedPerformSearch = debounce(performSearch, 500); 

    if (elements.searchInput) {
        elements.searchInput.addEventListener('input', (event) => {
            // Call the debounced function instead of the original directly
            debouncedPerformSearch(event.target.value);
            Navigation.showSection('files');
        });
    }

    // Files section event listeners
    // 1. File Selection Listener
    fileListContainer.addEventListener('click', (event) => {
        const fileItem = event.target.closest('.file-item');
        if (fileItem) {
            const fileName = fileItem.getAttribute('data-file');
            selectFile(fileName);
        }
    });
    
    // 2. Version Pills Listener: Switch diff content
    versionPillsContainer.addEventListener('click', (event) => {
        const pill = event.target.closest('.version-pill');
        if (pill) {
            const versionKey = pill.getAttribute('data-version');
            autoSelectLatestBackupVersion(versionKey); 
        }
    });

    // 3. Backup Version Actions Listener
    backupVersionActionsContainer.addEventListener('click', (event) => {
        const actionButton = event.target.closest('.action-btn');
        if (actionButton && currentBackupVersionKey) {
            const action = actionButton.getAttribute('data-action');
            // All actions are now handled by the central function
            handleVersionAction(action, currentBackupVersionKey);
        }
    });

    // 4. Open File Button Listener
    openFile.addEventListener('click', () => {
        // Get the full file path from the current file object
        let fileObj = null;
        if (window.latestSearchResults) {
            fileObj = window.latestSearchResults.find(f => f.name === currentFileKey);
        }
        const filePath = fileObj && fileObj.path ? fileObj.path : currentFileKey;
        openFileWithDefaultApp(filePath);
    });

    // // 4. Navigation listener for sidebar links
    // navLinks.forEach(link => {
    //     link.addEventListener('click', (e) => {
    //         e.preventDefault();
    //         const view = link.getAttribute('data-view');
    //         switchMainView(view);
    //     });
    // });
});
// Global WebSocket instance for other components to use
let globalSocket = null;

// Establish WebSocket connection
function initializeWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    try {
        globalSocket = new WebSocket(wsUrl);
        
        // Get ready to ge messages from daemon
        globalSocket.addEventListener('message', (event) => {
            UIMessageHandler.handleMessage(event.data);
        });

        globalSocket.addEventListener('error', (error) => {
            console.error('❌ Global WebSocket error:', error);
        });
        
    } catch (error) {
        console.error('❌ Failed to initialize WebSocket:', error);
        // Retry after 10 seconds
        setTimeout(initializeWebSocket, 10000);
    }
}

// Start the global WebSocket connection
// initializeWebSocket();

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    App.cleanup();
    if (globalSocket) {
        globalSocket.close();
    }
    if (window.backupStatusClient) {
        window.backupStatusClient.stopHeartbeat();
    }
});


// =============================================
// SUGGESTED FILES
// =============================================
const SuggestedFiles = {
    load: () => {
        fetch('/api/suggested-files')
            .then(response => response.json())
            .then(data => {
                const suggestedFilesContainer = document.getElementById('suggested-files-container');

                if (!suggestedFilesContainer) {
                    console.error('Error: Element with ID "suggested-files-container" not found in web.html.');
                    return;
                }

                // Clear previous results
                suggestedFilesContainer.innerHTML = '';

                if (data.success && data.suggested_items_to_display && data.suggested_items_to_display.length > 0) {
                    data.suggested_items_to_display.forEach(item => {
                        const fileItemDiv = document.createElement('div');
                        fileItemDiv.className = 'flex items-center p-3 bg-gray-50 rounded-lg shadow-sm mb-4';

                        fileItemDiv.innerHTML = `
                            <i class="bi bi-file-code-fill text-blue-500 text-lg mr-3"></i>
                            <div class="flex-1">
                                <div class="text-sm font-medium text-gray-800">${item.basename}</div>
                                <div class="text-xs text-gray-500">${item.original_path}</div>
                            </div>
                            <button class="text-indigo-600 hover:text-indigo-800 text-sm font-medium" data-filepath="${item.original_path}">Search</button>
                        `;

                       // Attach click event to the "Search" button to add file path to search bar and automatically search for it
                        const searchButton = fileItemDiv.querySelector('button');
                        searchButton.addEventListener('click', (event) => {
                            const fileName = item.basename;
                            // const filePath = event.target.getAttribute('data-filepath');
                            if (elements.searchInput) {
                                elements.searchInput.value = fileName;
                                performSearch(fileName);  // Perform search
                                Navigation.showSection('files');  // Switch to files section
                            }
                        });
                        suggestedFilesContainer.appendChild(fileItemDiv);
                    });
                } else {
                    suggestedFilesContainer.innerHTML = '<p class="text-gray-500 p-3">No Suggested files.</p>';
                }
            })
            .catch(error => {
                console.error('Error fetching search results:', error);
                const suggestedFilesContainer = document.getElementById('suggested-files-container');
                if (suggestedFilesContainer) {
                    suggestedFilesContainer.innerHTML = '<p class="text-red-500 p-3">An error occurred while loading files.</p>';
                }
            });
    },

    setup: () => {
        SuggestedFiles.load();
        setInterval(SuggestedFiles.load, 60000);  // Refresh every 1 minute
    }
};

// =============================================
// UI MESSAGE HANDLER (UPDATED FOR DAEMON ACTIVITIES)
// =============================================
const UIMessageHandler = {
    handleMessage(data) {
        try {
            // Handle both string data (from WebSocket) and already parsed objects
            const message = typeof data === 'string' ? JSON.parse(data) : data;

            console.log('Processing message:', message); // Debug log

            switch(message.type) {
                case 'analyzing':
                    ActivityManager.updateAnalyzingActivity({
                        title: message.title || 'Analyzing Files',
                        description: message.description || 'Scanning for changes...',
                        progress: message.progress || 0,
                        processed: message.processed || 0,
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;
                    
                case 'progress':
                    ActivityManager.updateBackupProgress({
                        title: message.title || 'Backup in Progress',
                        description: message.description || 'Copying files...',
                        progress: message.progress || 0,
                        eta: message.eta || 'Calculating...',
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;
                    
                    case 'scan_completed':
                    // CLEAR ACTIVE STATES FIRST
                    ActivityManager.clearAnalyzingActivity();
                    
                    ActivityManager.addPersistedActivity({
                        type: 'info',
                        title: message.title || 'Scan Completed',
                        description: message.description || 'File scan finished',
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;

                case 'completed':
                    // CLEAR ACTIVE STATES FIRST
                    ActivityManager.clearProgressActivity();
                    ActivityManager.clearAnalyzingActivity();
                    
                    // Add completed activity with proper structure
                    ActivityManager.addCompletedActivity({
                        title: message.title || 'Backup Completed',
                        description: message.description || 'All files backed up successfully',
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;
                    
                case 'warning':
                    ActivityManager.addWarningActivity({
                        title: message.title || 'Warning',
                        description: message.description || 'A warning occurred during backup',
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;
                    
                case 'info':
                    ActivityManager.addNewFolderActivity({
                        title: message.title || 'New Activity',
                        description: message.description || 'Backup activity detected',
                        timestamp: message.timestamp || new Date().toISOString()
                    });
                    break;
                    
                default:
                    console.log('Unhandled message type:', message.type);
            }
        } catch (e) {
            console.error('❌ Error processing WebSocket message:', e);
            console.log('Raw message that caused error:', data);
        }
    }
};


// =============================================
// LOGS MANAGEMENT
// =============================================
const LogManager = {
    load: () => {
        elements.logContainer.innerHTML = '<div class="text-gray-500">Loading logs...</div>';
        
        fetch('/api/logs')
            .then(Utils.handleResponse)
            .then(data => {
                if (!data.success) {
                    throw new Error(data.error || 'Unknown error loading logs');
                }
                
                elements.logContainer.innerHTML = '';
                
                if (data.logs && data.logs.length > 0) {
                    data.logs.forEach(entry => {
                        const logElement = document.createElement('div');
                        logElement.className = 'py-1 border-b border-gray-100 last:border-b-0';
                        
                        // Color code by log level
                        let logClass = 'text-gray-800';
                        if (entry.level === 'INFO') logClass = 'text-blue-600';
                        if (entry.level === 'WARNING') logClass = 'text-yellow-600';
                        if (entry.level === 'ERROR') logClass = 'text-red-600';
                        
                        logElement.innerHTML = `
                            <span class="text-gray-500">${entry.timestamp}</span>
                            <span class="${logClass}">${entry.message}</span>
                            ${entry.error ? `<div class="text-red-500 text-xs">Parse error: ${entry.error}</div>` : ''}
                        `;
                        elements.logContainer.appendChild(logElement);
                    });
                } else {
                    elements.logContainer.innerHTML = '<div class="text-gray-500">No log entries found</div>';
                }
                
                // Auto-scroll to bottom
                elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
            })
            .catch(error => {
                elements.logContainer.innerHTML = `<div class="text-red-500">Error loading logs: ${error.message}</div>`;
            });
    },

    setup: () => {
        const refreshBtn = document.getElementById('refreshLogsBtn');
        const exportBtn = document.getElementById('exportLogsBtn');
        const clearBtn = document.getElementById('clearLogsBtn');

        refreshBtn.addEventListener('click', LogManager.load);

        exportBtn.addEventListener('click', () => {
            const logContent = Array.from(elements.logContainer.children)
                .map(el => el.textContent)
                .join('\n');
            
            const blob = new Blob([logContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'timemachine_logs.txt';
            a.click();
            URL.revokeObjectURL(url);
        });

        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all logs?')) {
                fetch('/api/logs/clear', { method: 'POST' })
                    .then(response => {
                        if (response.ok) {
                            LogManager.load();
                        } else {
                            alert('Failed to clear logs');
                        }
                    });
            }
        });
    }
};

// =============================================
// SEARCH FUNCTIONALITY
// =============================================
// Function to format Unix timestamp to human-readable date (e.g., "Today, 9:15 AM" or "Jul 18, 2025, 9:15 AM")
function formatTimestamp(timestamp) {
    const date = new Date(timestamp * 1000); // Convert Unix timestamp (seconds) to milliseconds
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset time for comparison

    const fileDate = new Date(date);
    fileDate.setHours(0, 0, 0, 0);

    const timeOptions = { hour: 'numeric', minute: 'numeric', hour12: true };
    const timeString = date.toLocaleTimeString('en-US', timeOptions);

    if (fileDate.getTime() === today.getTime()) {
        return `Today, ${timeString}`;
    } else {
        const dateOptions = { year: 'numeric', month: 'short', day: 'numeric' };
        const dateString = date.toLocaleDateString('en-US', dateOptions);
        return `${dateString}, ${timeString}`;
    }
}

let searchTimeout;
const SEARCH_DEBOUNCE_DELAY = 500; // milliseconds

/**
 * Fetches search results from the backend and renders them into the file list container.
 * @param {string} query The search query string.
 */
function performSearch(query) {
    if (!query || query.trim() === '') {
        // Don't search empty queries
        if (fileListContainer) {
            fileListContainer.innerHTML = '<p class="text-gray-500 p-3">Enter a search term to find files.</p>';
        }
        return;
    }
    
    console.log('Query being sent to API:', query); 
    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(response => response.json())
        .then(data => {
            if (!fileListContainer) {
                console.error('Error: Element with ID "file-list-container" not found in web.html.');
                return;
            }

            // Store latest search results globally for later use (e.g., selectFile)
            window.latestSearchResults = data.files || [];

            // Clear previous results
            fileListContainer.innerHTML = '';

            // Console log results for debugging
            console.log('Search results received from API:', data.files);

            // Track added files to prevent duplicates
            const addedFiles = new Set();

            // Populate with new results
            if (data.files && data.files.length > 0) {
                data.files.forEach(file => {
                    if (addedFiles.has(file.name)) return; // Skip if already added
                    addedFiles.add(file.name);

                    // Get icon details based on file type/extension
                    const { iconClass, iconColor } = getFileIconDetails(file.name);

                    // Count versions (default to 1 if not provided)
                    const versionCount = file.versions ? file.versions.length : (file.version_count || 1);
                    
                    // Mark active if needed (example: first file)
                    const isActive = data.files[0] && file.name === data.files[0].name ? 'active' : '';

                    const fileItemDiv = document.createElement('div');
                    fileItemDiv.className = `file-item flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors border-transparent hover:hover:border-indigo-500 ${isActive}`;
                    fileItemDiv.setAttribute('data-file', file.name);
                    fileItemDiv.setAttribute('data-filepath', file.path || file.name); // Store full path

                    fileItemDiv.innerHTML = `
                        <div class="flex items-center">
                            <i class="${iconClass} ${iconColor} mr-3"></i>
                            <span class="text-sm font-medium truncate">${file.name}</span>
                        </div>
                        <span class="text-xs text-gray-400">${versionCount} version${versionCount > 1 ? 's' : ''}</span>
                    `;
                    fileListContainer.appendChild(fileItemDiv);
                });
            } else {
                fileListContainer.innerHTML = '<p class="text-gray-500 p-3">No files found for this query.</p>';
            }
        })
        .catch(error => {
            console.error('Error fetching search results:', error);
            if (fileListContainer) {
                fileListContainer.innerHTML = '<p class="text-red-500 p-3">An error occurred while loading files.</p>';
            }
        });
}

function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// Event listener for the search input
// Elements.searchInput.addEventListener('input', (event) => {
//     clearTimeout(searchTimeout); // Clear previous timeout
//     const query = event.target.value;
//     searchTimeout = setTimeout(() => {
//         performSearch(query);
//     }, SEARCH_DEBOUNCE_DELAY);
// });

/**
 * Sends a request to the backend to open the specified file with the system's default application.
 * @param {string} filePath The full path to the file to open.
 */
function openFileInDefaultApp(filePath) {
    if (!filePath) {
        console.warn("No file path provided to openFileInDefaultApp.");
        return;
    }

    // Make an API call to a NEW backend endpoint for opening files
    fetch('/api/open-file', { // Changed endpoint here
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        body: JSON.stringify({ file_path: filePath }) // Changed key name for clarity
    })
    .then(Utils.handleResponse) // Re-use your existing response handler
    .then(data => {
        if (data && data.success) {
            console.log(`Successfully requested to open file: ${filePath}`);
            /*alert('File opened successfully!');*/ // Simple alert for demonstration
        } else {
            const errorMsg = data ? data.error : 'Unknown error';
            console.error(`Failed to open file ${filePath}: ${errorMsg}`);
            /*alert(`Failed to open file: ${errorMsg}`);*/
        }
    })
    .catch(error => {
        console.error('Network error or API error when trying to open file:', error);
        alert(`Error connecting to server to open file: ${error.message}`);
    });
}

/**
 * Sends a request to the backend to open the specified path in the system's file explorer.
 * @param {string} path The file or directory path to open.
 */
function openPathInExplorer(path) {
    if (!path) {
        console.warn("No path provided to openPathInExplorer.");
        return;
    }

    // Make an API call to your backend
    fetch('/api/open-location', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: path })
    })
    .then(Utils.handleResponse) // Re-use your existing response handler
    .then(data => {
        if (data && data.success) {
            console.log(`Open file location: ${path}`);
            /*alert('Location opened successfully!');*/ // Simple alert for demonstration
        } else {
            const errorMsg = data ? data.error : 'Unknown error';
            console.error(`Failed to open path ${path}: ${errorMsg}`);
            /*alert(`Failed to open location: ${errorMsg}`);*/
        }
    })
    .catch(error => {
        console.error('Network error or API error when trying to open path:', error);
        alert(`Error connecting to server to open location: ${error.message}`);
    });
}

/**
 * Sends a request to the backend to open the specified file with the system's default application.
 * @param {string} filePath The full path to the file to open.
 */
function openFileWithDefaultApp(filePath) {
    if (!filePath) {
        console.warn("No file path provided to openFileWithDefaultApp.");
        return;
    }

    fetch('/api/open-file', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: filePath })
    })
    .then(Utils.handleResponse)
    .then(data => {
        if (data && data.success) {
            console.log(`Successfully requested to open file: ${filePath}`);
        } else {
            const errorMsg = data ? data.error : 'Unknown error';
            console.error(`Failed to open file ${filePath}: ${errorMsg}`);
        }
    })
    .catch(error => {
        console.error('Network error or API error when trying to open file:', error);
        alert(`Error connecting to server to open file: ${error.message}`);
    });
}

/**
 * Initiates the diff process for the specified file path.
 * This function finds the corresponding file item element and passes it to DiffManager.showDiff.
 * @param {string} filePath The path of the file to show the diff for.
 */
function showDiff(filePath) {
    if (!filePath) {
        console.warn("No file path provided to showDiff.");
        return;
    }

    // Find the file-item element that corresponds to this filePath.
    // This assumes your file-item elements have a data-filepath attribute.
    const fileItemElement = document.querySelector(`.file-item[data-filepath="${filePath}"]`);

    if (fileItemElement) {
        if (typeof DiffManager !== 'undefined' && typeof DiffManager.showDiff === 'function') {
            console.log(`Requesting diff for: ${filePath}`);
            DiffManager.showDiff(fileItemElement); // Pass the found element
        } else {
            console.error("DiffManager.showDiff is not defined or not a function.");
            alert("Diff functionality not available.");
        }
    } else {
        console.error(`Could not find .file-item element for path: ${filePath}`);
        alert("Cannot perform diff: File item not found on page.");
    }
}

/**
 * Sends a request to the backend to restore the specified file.
 * @param {string} path The file path to restore.
 * @param {boolean} restoreFile Flag indicating this is a restore operation.
 */
function restoreFile(path, restoreFile) {
    if (!path) {
        console.warn("No path provided to restore.");
        return;
    }

    // Make an API call to your backend
    fetch('/api/restore-file', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: path })
    })
    .then(Utils.handleResponse)
    .then(data => {
        if (data && data.success) {
            Navigation.showSection('overview');  // Change to Overview page
            console.log(`Successfully requested to restore file: ${path}`);
        } else {
            const errorMsg = data ? data.error : 'Unknown error';
            console.error(`Failed to restore file ${path}: ${errorMsg}`);
        }
    })
    .catch(error => {
        console.error('Network error or API error when trying to restore file:', error);
    });
}

// =============================================
// INITIALIZATION
// =============================================
const App = {
    init: () => {
        appState.intervals = {};
        
        Navigation.setup();
        UIControls.setup();
        LogManager.setup();
        UIControls.setupToggles();
        DiffManager.setupModalControls();
        
        // Initialize ActivityManager FIRST to load persisted activities
        ActivityManager.init();
        
        // Then load other data
        BackupManager.updateUsage();
        DeviceManager.load();
        LogManager.load();
        FolderManager.loadWatchedFolders();  
        ProAccessManager.showDialog(); 
        SuggestedFiles.setup(); 
        
        // Interval to update UI
        appState.intervals.storage = setInterval(BackupManager.updateUsage, 2000);

        DiffManager.init();
        DeviceSelection.init();
    },

    cleanup: () => {
        if (AppState && appState.intervals) {
            Object.values(appState.intervals).forEach(interval => {
                if (interval) clearInterval(interval);
            });
        }
        // Also clear ActivityManager intervals
        ActivityManager.clearAllIntervals();
    },
};

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());


// Establish WebSocket connection
const socket = new WebSocket('ws://localhost:5000/ws'); // Replace with your WebSocket URL

socket.addEventListener('open', (event) => {
    console.log('WebSocket connection established.');
});

socket.addEventListener('close', (event) => {
    console.log('WebSocket connection closed.');
});

// Clean up on page unload
window.addEventListener('beforeunload', App.cleanup);