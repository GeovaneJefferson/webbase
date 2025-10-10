// =============================================
// APPLICATION STATE
// =============================================
class AppState {
    constructor() {
        this.backup = {
            running: true,
            progress: 65,
            processedFiles: 342,
            totalFiles: 526
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
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    };

    static getDeviceIcon(device) {
        if (!device) return 'fas fa-usb';
        if (device.device?.includes('nvme')) return 'fas fa-solid fa-memory';
        if (device.device?.includes('sd') || device.device?.includes('hd')) return 'fas fa-hdd';
        if (device.device?.includes('mmc')) return 'fas fa-sd-card';
        return 'fas fa-usb';
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
        this.currentFile = {
            name: fileItem.querySelector('h3').textContent,
            path: fileItem.querySelector('.text-xs.text-gray-400 span:last-child').textContent.replace('Modified: ', ''),
            currentContent: '',
            versions: []
        };

        this.showLoadingState();
        document.getElementById('diffModal').classList.remove('hidden');
        document.getElementById('diffModalTitle').textContent = `Time Machine: ${this.currentFile.name}`;

        // Simulate fetching versions
        setTimeout(() => {
            const now = new Date();
            const baseContent = `// Sample file content\n\nfunction example() {\n    return "This is the ${this.currentFile.name}";\n}\n\n// Additional code\nconst config = {\n    version: "1.0",\n    settings: {\n        debug: true\n    }\n};\n`;
            
            this.versions = [
                {
                    id: 1,
                    date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 30),
                    content: baseContent.replace('"1.0"', '"1.2"').replace('debug: true', 'debug: false') + '\n// Added new feature\n',
                    changes: 3
                },
                {
                    id: 2,
                    date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 15),
                    content: baseContent.replace('"1.0"', '"1.1"') + '\n// Minor update\n',
                    changes: 2
                },
                {
                    id: 3,
                    date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0),
                    content: baseContent,
                    changes: 0
                }
            ];

            this.versions.sort((a, b) => b.date - a.date);
            this.currentFile.currentContent = this.versions[0].content;
            this.renderDiffView();
        }, 500);
    },

    renderDiffView: function() {
        if (this.versions.length === 0) return;

        this.currentVersionIndex = 0;
        this.showVersion(this.currentVersionIndex);

        document.getElementById('currentFileName').textContent = this.currentFile.name;
        document.getElementById('versionInfo').textContent = `Showing version 1 of ${this.versions.length}`;
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
        document.getElementById('versionStats').textContent = `${version.changes} changes`;

        this.performDiff(this.currentFile.currentContent, version.content);
    },

    showLoadingState: function() {
        document.getElementById('currentFileContent').textContent = 'Loading current file...';
        document.getElementById('backupFileContent').textContent = 'Loading backup file...';
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
        const currentLines = currentContent.split('\n');
        const backupLines = backupContent.split('\n');
        
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

        document.getElementById('currentFileContent').innerHTML = currentHtml;
        document.getElementById('backupFileContent').innerHTML = backupHtml;
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
        if (confirm(`Restore this file to the version from ${this.versions[this.currentVersionIndex].date.toLocaleString()}?`)) {
            this.currentFile.currentContent = this.versions[this.currentVersionIndex].content;
            this.showVersion(this.currentVersionIndex);
            this.showToast('File restored successfully');
        }
    },

    // ... (keep other existing methods like toggleIgnoreWhitespace, onSliderChange, etc.)
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
                } else {
                    // Show friendly error in UI
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
                    
                    // Visual indicator
                    elements.backupProgress.style.width = "0%";
                    elements.backupProgress.className = 'h-2 rounded-full bg-yellow-500';
                    
                    // Only show alert for first occurrence
                    if (!AppState.backup.errorShown) {
                        alert(`Setup Required:\n\n${data.error}`);        
                        AppState.backup.errorShown = true;
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
            elements.backupLocation.textContent = displayLocation;
            sourceLocation.textContent = data.users_home_path;  // Users $USER

            // User's home(Hdd/Ssd) usage
            homeUsage.textContent = `${data.home_human_used} used of ${data.home_human_total} (${data.home_percent_used}% used)`;
            // homeUsage.className = 'h-2 rounded-full';
            // homeUsage.classList.add(Utils.getUsageColorClass(data.home_percent_used));
 
            // Backup device info
            deviceMountPoint.textContent = displayLocation;
            elements.backupProgress.style.width = `${data.percent_used}%`;
            elements.backupUsage.textContent = 
                `${data.human_used} used of ${data.human_total} (${data.percent_used}% used)`;
 
            elements.deviceUsed.textContent = `${data.home_human_used}`;
            elements.deviceFree.textContent = `${data.home_human_free}`;
            elements.deviceTotal.textContent = `${data.home_human_total}`;
 
            elements.backupProgress.className = 'h-2 rounded-full';
            elements.backupProgress.classList.add(Utils.getUsageColorClass(data.percent_used));
            
            // Update the UI with the devices used space
            devicesUsageBar.style.width = `${data.percent_used}%`;  // Used space bar
            devicesUsageBar.className = 'h-2 rounded-full';  // Reset class
            devicesUsageBar.classList.add(Utils.getUsageColorClass(data.percent_used));  // Determines color
            
            // Update image count from summary if available
            if (data.summary && data.summary.categories) {
                const imagesCategory = data.summary.categories.find(cat => cat.name === "Image");
                const documentsCategory = data.summary.categories.find(cat => cat.name === "Document");
                const videosCategory = data.summary.categories.find(cat => cat.name === "Video");
                const otherCategory = data.summary.categories.find(cat => cat.name === "Others");
                
                // Debug
                console.log(elements.imagesCount.textContent);
            
                // Images
                if (imagesCategory)
                    imagesCount.textContent = `${imagesCategory.count.toLocaleString()} files`;
                    imagesSize.textContent = `${imagesCategory.size_str}`;
                // Documents
                if (documentsCategory)
                    documentsCount.textContent = `${documentsCategory.count.toLocaleString()} files`;
                    documentsSize.textContent = `${documentsCategory.size_str}`;
                // Videos                   
                if (videosCategory)
                    videosCount.textContent = `${videosCategory.count.toLocaleString()} files`;
                    videosSize.textContent = `${videosCategory.size_str}`;
                // Other files
                if (otherCategory)
                    otherCount.textContent = `${otherCategory.count.toLocaleString()} files`;
                    otherSize.textContent = `${otherCategory.size_str.toLocaleString()} files`;
            }
        } else {
            elements.backupLocation.textContent = "Error";
            elements.backupUsage.textContent = `Error: ${data.error || 'Unknown error'}`;
            elements.backupProgress.style.width = '0%';
            elements.backupProgress.className = 'h-2 rounded-full bg-gray-500';
        }
    },

    updateStatus: () => {
        if (AppState.backup.running) {
            AppState.backup.progress += 1;
            AppState.backup.processedFiles = Math.floor(
                AppState.backup.totalFiles * (AppState.backup.progress/100)
            );
            
            if (AppState.backup.progress > 100) {
                AppState.backup.progress = 100;
                AppState.backup.processedFiles = AppState.backup.totalFiles;
                elements.backupStatusText.textContent = "Backup completed successfully";
                elements.progressBar.classList.replace('bg-indigo-600', 'bg-green-500');
                elements.etaTime.textContent = "Completed";
                elements.currentFile.textContent = "All files processed";
                clearInterval(AppState.intervals.backup);
            } else {
                elements.progressBar.style.width = AppState.backup.progress + '%';
                elements.processedFiles.textContent = 
                    `Processing: ${AppState.backup.processedFiles} of ${AppState.backup.totalFiles} files`;
                elements.etaTime.textContent = 
                    `ETA: ${Math.floor((100 - AppState.backup.progress) * 0.2)} minutes`;
                
                if (AppState.backup.progress % 5 === 0) {
                    const files = [
                        "C:\\Users\\Documents\\Projects\\Budget_2023.xlsx",
                        "C:\\Users\\Documents\\Reports\\Q3_Report.docx",
                        "C:\\Users\\Documents\\Presentations\\Product_Launch.pptx"
                    ];
                    elements.currentFile.textContent = 
                        files[Math.floor(Math.random() * files.length)];
                }
            }
        }
    },

    //////////////////////////////////////////////////////////////////////////
    // AUTOMATICALLY REALTIME CHECKBOX
    //////////////////////////////////////////////////////////////////////////
    toggle: () => {
        AppState.backup.running = !AppState.backup.running;
        
        const realTimeCheckbox = document.getElementById('realTimeCheckbox');  // settings section        
        const statusLabel = document.getElementById('realTimeStatusLabel');

        if (AppState.backup.running) {
            if (realTimeCheckbox) {
                realTimeCheckbox.checked = true;
            }
            AppState.intervals.backup = setInterval(BackupManager.updateStatus, 1000);
        } else {
            if (realTimeCheckbox) {
                realTimeCheckbox.checked = false;
            }            
            clearInterval(AppState.intervals.backup);
        }
        
        // Update real-time status label and Icon color
        if (realTimeCheckbox.checked) {
            console.log("Real-time backup is now active");
            // Change label and icon to active state
            // statusLabel.innerHTML = "Real-time backup active";
            statusLabel.classList.replace('text-red-500', 'text-green-500');
            statusLabel.classList.add('fas', 'fa-circle');
            statusLabel.classList.remove('far', 'fa-circle');
        } else {
            // Change label and icon to inactive state
            // statusLabel.innerHTML = "Real-time backup inactive";
            statusLabel.classList.replace('text-green-500', 'text-red-500');
            statusLabel.classList.add('far', 'fa-circle');
            statusLabel.classList.remove('fas', 'fa-circle');
        }   
        BackupManager.updateRealTimeBackupState(realTimeCheckbox.checked);
    },

    // Send request to backend to toggle real-time backup
    updateRealTimeBackupState: (isChecked) => {
        fetch('/api/realtime-backup/daemon', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ is_active: isChecked }),
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                console.error("Error toggling real-time backup:", data.error);
                alert("Error toggling real-time backup: " + data.error);
            }
            // You could add further UI feedback here (e.g. success message)
        });
    }, 
    //////////////////////////////////////////////////////////////////////////

    stop: () => {
        clearInterval(AppState.intervals.backup);
        elements.backupStatusText.textContent = "Backup stopped by user";
        elements.progressBar.classList.replace('bg-indigo-600', 'bg-red-500');
        elements.etaTime.textContent = "Stopped";
        document.getElementById('pauseBackupBtn').innerHTML = 
            '<i class="fas fa-play mr-2"></i><span>Start Backup</span>';
        AppState.backup.running = false;
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
                        <i class="fas fa-map-marker-alt mr-1"></i>
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
                AppState.selectedDevice = {
                    path: this.getAttribute('data-device-path'),
                    info: JSON.parse(this.getAttribute('data-device-info'))
                };
                
                console.log('Selected device state:', AppState.selectedDevice);
                DeviceManager.updateSelectionUI();
            });
        });
    },

    updateSelectionUI: () => {
        const { path, info } = AppState.selectedDevice;
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
        if (!AppState.selectedDevice) {
            alert('Please select a device first');
            return;
        }

        fetch('/api/backup/select-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: AppState.selectedDevice.path,
                device_info: AppState.selectedDevice.info
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
                <i class="fas fa-hdd text-gray-300 text-4xl mb-2"></i>
                <div class="text-gray-500">No storage devices found</div>
                <div class="text-sm text-gray-400 mt-1">Connect a USB drive or external storage and click Refresh</div>
            </div>
        `;
    },

    showError: (error) => {
        elements.devicesContainer.innerHTML = `
            <div class="text-center py-8 text-red-500">
                <i class="fas fa-exclamation-triangle text-xl mb-2"></i>
                <div>Error loading devices</div>
                <div class="text-sm text-gray-500 mt-1">${error.message}</div>
            </div>
        `;
    },

    showSelectionSuccess: () => {
        const btn = document.getElementById('confirmSelectionBtn');
        btn.innerHTML = '<i class="fas fa-check mr-2"></i> Selected!';
        btn.classList.replace('bg-indigo-600', 'bg-green-500');
        
        setTimeout(() => {
            btn.innerHTML = '<i class="fas fa-check mr-2"></i> Confirm Selection';
            btn.classList.replace('bg-green-500', 'bg-indigo-600');
            Navigation.showSection('overview');
        }, 2000);
    },

    loadCurrent: () => {
        fetch('/api/backup/current-device')
            .then(Utils.handleResponse)
            .then(data => {
                if (typeof data === 'object' && data && data.success && data.device_path) {
                    const currentDeviceCard = document.querySelector(
                        `.device-card[data-device-path="${data.device_path}"]`
                    );
                    if (currentDeviceCard) currentDeviceCard.click();
                }
            });
    }
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
            const icon = navItem.querySelector('i');
            icon.classList.toggle('text-indigo-600', isActive);
            icon.classList.toggle('text-gray-600', !isActive);
            const text = navItem.querySelector('span');
            text.classList.toggle('text-indigo-600', isActive);
            text.classList.toggle('text-gray-600', !isActive);
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
        if (elements.rightSidebar) {
            elements.rightSidebar.classList.toggle('hidden', section !== 'overview');
        }
    }
};

// =============================================
// UI CONTROLS
// =============================================
const UIControls = {
    setup: () => {
         // Backup control buttons
        // document.getElementById('pauseBackupCheckbox').addEventListener('change', BackupManager.toggle);
        // document.getElementById('pauseBackupBtn2').addEventListener('click', BackupManager.toggle);  // TO DELETE
        // document.getElementById('stopBackupBtn').addEventListener('click', BackupManager.stop);  // TO DELETE
        
        // Search functionality
        // Elements.searchInput.addEventListener('input', (event) => {
        //     clearTimeout(searchTimeout); // Clear previous timeout
        //     const query = event.target.value;
        //     searchTimeout = setTimeout(() => {
        //         performSearch(query);
        //     }, SEARCH_DEBOUNCE_DELAY);
        // });
        // Device management
        document.getElementById('refreshDevicesBtn').addEventListener('click', DeviceManager.load);
        document.getElementById('confirmSelectionBtn').addEventListener('click', DeviceManager.confirmSelection);
        // document.getElementById('newFolderBtn').addEventListener('click', () => {
        //     alert('This would open a dialog to add a new folder to watch in a real application.');
        // });
        
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
            watchedFoldersToggle.addEventListener('click', () => {
                watchedFoldersContent.classList.toggle('hidden');
                watchedFoldersToggleIcon.classList.toggle('fa-chevron-down');
                watchedFoldersToggleIcon.classList.toggle('fa-chevron-up');
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
                
                if (data.length === 0) {
                    tableBody.innerHTML = `
                        <tr>
                            <td colspan="5" class="px-6 py-4 text-center text-gray-500">
                                No folders found in home directory
                            </td>
                        </tr>
                    `;
                    return;
                }
                
                data.forEach(folder => {
                    const row = document.createElement('tr');
                    const excludedCount = folder.excluded_subfolders.length;
                    const lastActivity = new Date(folder.last_activity);
                    
                    // Different styling for Active/Inactive folders
                    const statusClass = folder.status === 'Active' ? 
                        'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800';
                    const iconColor = folder.status === 'Active' ? 
                        'text-indigo-500' : 'text-gray-500';
                    
                    row.innerHTML = `
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium ${folder.is_excluded ? 'text-gray-500' : 'text-gray-900'}">
                            <i class="fas fa-folder mr-2 ${iconColor}"></i>
                            ${folder.name}
                        </td>
                        <td class="px-4 py-2 whitespace-nowrap">
                            <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${statusClass}">
                                ${folder.status}
                            </span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm ${folder.is_excluded ? 'text-gray-400' : 'text-gray-500'}">
                            ${lastActivity.toLocaleTimeString()} ${lastActivity.toLocaleDateString()}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            ${excludedCount > 0 ? `
                                <button onclick="FolderManager.showExclusions(${JSON.stringify(folder.excluded_subfolders)})" 
                                        class="text-indigo-600 hover:text-indigo-900 mr-3"
                                        title="Show excluded items">
                                    <i class="fas fa-info-circle"></i>
                                </button>
                            ` : ''}
                            <button onclick="FolderManager.folderInclusionExclusion('${folder.path}', ${!folder.is_excluded})"
                                    class="${folder.is_excluded ? 'text-green-600 hover:text-green-900' : 'text-yellow-600 hover:text-yellow-900'} mr-3"
                                    title="${folder.is_excluded ? 'Include in backup' : 'Exclude from backup'}">
                                <i class="fas ${folder.is_excluded ? 'fa-plus-circle' : 'fa-minus-circle'}"></i>
                            </button>
                            <button onclick="FolderManager.showAddExclusion('${folder.path}')" class="text-gray-600 hover:text-gray-900" title="Add specific exclusions">
                                <i class="fas fa-ellipsis-h"></i>
                            </button>
                        </td>
                    `;
                    tableBody.appendChild(row);
                });
                // DESTINATION COLUMN 2 place
                // <td class="px-4 py-2 whitespace-nowrap text-sm ${folder.is_excluded ? 'text-gray-400' : 'text-gray-500'}">
                //     ${folder.is_excluded ? 'Not backed up' : folder.destination}
                // </td>
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
    folderInclusionExclusion: (folderPath, is_excluded) => {
        fetch('/api/folders/handle_folder_include_exclude', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: folderPath,
                is_excluded: is_excluded
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                FolderManager.loadWatchedFolders(); // Refresh the list
            } else {
                alert('Failed to update folder status: ' + (data.error || 'Unknown error'));
            }
        })
        .catch(error => {
            alert('Error updating folder status: ' + error.message);
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
                            <i class="fas fa-times"></i>
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
                        <i class="fas fa-folder-minus mr-2"></i>
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
							<i class="fas fa-times"></i>
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
// ACTIVITY MANAGER
// =============================================
const ActivityManager = {
    activities: [],
    intervals: {},
    
    init: function() {
        // The simulated activities are commented out to allow for real data from the backend.
        // this.simulateFileAnalysis();
        // this.simulateBackupProgress();
        
        // Load recent activities from server
        this.loadRecentActivities();
    },
    
    simulateFileAnalysis: function() {
        const files = [
            "Documents/Work/",
            "Pictures/Vacation/",
            "Projects/ClientA/",
            "Downloads/",
            "Music/Collection/"
        ];
        let currentFile = 0;
        let progress = 0;
        
        this.intervals.analysis = setInterval(() => {
            progress += Math.random() * 10;
            if (progress > 100) {
                progress = 0;
                currentFile = (currentFile + 1) % files.length;
            }
            
            document.getElementById('analyzingStatus').textContent = `Scanning ${files[currentFile]}...`;
            document.getElementById('analyzingProgress').style.width = `${progress}%`;
            document.getElementById('analyzingCount').textContent = 
                `${Math.floor(progress * 3.2)} files processed`;
                
            // Add to activity log when folder completes
            if (progress === 0 && currentFile > 0) {
                this.addActivity({
                    icon: 'search',
                    color: 'blue',
                    title: 'Analysis complete',
                    message: `Finished scanning ${files[currentFile-1]}`,
                    timestamp: new Date()
                });
            }
        }, 800);
    },
    
    simulateBackupProgress: function() {
        const files = [
            "Documents/ProjectX/budget.xlsx",
            "Pictures/Vacation2023/beach.jpg",
            "Videos/tutorial.mp4",
            "Projects/NewClient/proposal.docx",
            "Music/NewAlbum/song1.mp3"
        ];
        let currentFile = 0;
        let progress = 45;
        
        this.intervals.backup = setInterval(() => {
            progress += Math.random() * 5;
            if (progress > 100) {
                progress = 0;
                currentFile = (currentFile + 1) % files.length;
                
                // Add completed backup to activity log
                this.addActivity({
                    icon: 'copy',
                    color: 'indigo',
                    title: 'File backed up',
                    message: files[currentFile === 0 ? files.length-1 : currentFile-1],
                    timestamp: new Date()
                });
            }
            
            document.getElementById('currentBackupFile').textContent = files[currentFile];
            document.getElementById('backupProgressBar').style.width = `${progress}%`;
            document.getElementById('backupStatus').textContent = `${Math.min(100, Math.floor(progress))}% completed`;
            document.getElementById('backupETA').textContent = `ETA: ${Math.floor((100 - progress) / 5)} min`;
        }, 1200);
    },
    
    loadRecentActivities: function() {
        // Simulate loading from server
        setTimeout(() => {
            const sampleActivities = [
                {
                    icon: 'check-circle',
                    color: 'green',
                    title: 'Backup completed',
                    message: 'Pictures/Vacation2023 folder',
                    timestamp: new Date(Date.now() - 120000)
                },
                {
                    icon: 'exclamation-triangle',
                    color: 'yellow',
                    title: 'Warning',
                    message: 'Large file detected: Videos/tutorial.mp4 (2.4GB)',
                    timestamp: new Date(Date.now() - 300000)
                },
                {
                    icon: 'folder-plus',
                    color: 'purple',
                    title: 'New folder added',
                    message: 'Projects/NewClient',
                    timestamp: new Date(Date.now() - 600000)
                }
            ];
            
            sampleActivities.forEach(activity => {
                this.addActivity(activity, false); // Add to beginning
            });
        }, 1500);
    },
    
    addActivity: function(activity, prepend = true) {
        const activityElement = this.createActivityElement(activity);
        const container = document.getElementById('activityFeed');
        
        if (prepend) {
            // Add new activity to top
            container.insertBefore(activityElement, container.firstChild);
            
            // Limit to 20 activities
            if (container.children.length > 20) {
                container.removeChild(container.lastChild);
            }
        } else {
            // Add to bottom (for initial load)
            container.appendChild(activityElement);
        }
        
        this.activities.push(activity);
    },

    updateAnalysisStatus: function(data) {
        const analyzingStatus = document.getElementById('analyzingStatus');
        const analyzingProgress = document.getElementById('analyzingProgress');
        const analyzingCount = document.getElementById('analyzingCount');

        if (analyzingStatus) analyzingStatus.textContent = data.status_text;
        if (analyzingProgress) analyzingProgress.style.width = `${data.progress_percent}%`;
        if (analyzingCount) analyzingCount.textContent = data.count_text;
    },
    
    createActivityElement: function(activity) {
        const element = document.createElement('div');
        element.className = 'flex items-start activity-item';
        
        const timeAgo = this.formatTimeAgo(activity.timestamp);
        
        element.innerHTML = `
            <div class="bg-${activity.color}-100 text-${activity.color}-600 p-2 rounded-full mr-3">
                <i class="fas fa-${activity.icon} text-sm"></i>
            </div>
            <div class="flex-1">
                <div class="text-sm font-medium">${activity.title}</div>
                <div class="text-xs text-gray-500 mt-1">${activity.message}</div>
                <div class="text-xs text-gray-400 mt-1">${timeAgo}</div>
            </div>
        `;
        
        return element;
    },
    
    formatTimeAgo: function(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        
        if (seconds < 60) return 'Just now';
        if (seconds < 3600) return `${Math.floor(seconds/60)} minutes ago`;
        if (seconds < 86400) return `${Math.floor(seconds/3600)} hours ago`;
        return `${Math.floor(seconds/86400)} days ago`;
    }
};

// =============================================
// FILE SECTION
// =============================================
// --- DOM Elements & State ---
const currentContentElement = document.getElementById('currentFileContent');
const backupContentElement = document.getElementById('backupFileContent');
const currentHeaderSpan = document.getElementById('currentVersionTime');
const backupHeaderSpan = document.getElementById('backupVersionTime');
const versionPillsContainer = document.getElementById('version-pills-container');
const fileListContainer = document.getElementById('file-list-container');
const currentFileNameDisplay = document.getElementById('currentFileNameDisplay');
const demoMessageBox = document.getElementById('demo-message');
const backupVersionActionsContainer = document.getElementById('backupVersionActions');
const openFile = document.getElementById('openFileBtn');
const openLocation = document.getElementById('openLocationBtn');

// Global state to track currently selected file and version
let currentFileKey = '';
let currentBackupVersionKey = null; // Will be set to the latest non-current version


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

    // Render version pills for this file
    renderVersionPills(fileObj);

    // Select the latest version by default (latest datetime)
    const versionsArr = Object.entries(fileObj.versions).map(([key, v]) => ({ key, ...v }));

    // Sort by time descending (latest first)
    versionsArr.sort((a, b) => {
        let aTime = typeof a.time === 'number' ? a.time : parseVersionTime(a.time);
        let bTime = typeof b.time === 'number' ? b.time : parseVersionTime(b.time);
        return bTime - aTime;
    });

    if (versionsArr.length > 0) {
        switchVersion(versionsArr[0].key); // Select the latest version by datetime
    }
    
    // Fetch file content from backend and display in currentFileContent
    fetch(`/api/file-content?file_path=${encodeURIComponent(filePath)}`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.content !== undefined) {
                currentContentElement.textContent = data.content;
            } else if (data.metadata) {
                currentContentElement.innerHTML = renderMetadataView(data.metadata);
            } else {
                currentContentElement.textContent = 'Unable to load file content.';
            }
        })
        .catch(error => {
            console.error('Error loading file content:', error);
            currentContentElement.textContent = 'Error loading file content.';
        });
}

/**
 * Renders the list of version pills for the selected file.
 * Each pill represents a backup/version (e.g., "Yesterday 11:00 AM (V1)").
 */
function renderVersionPills(fileObj) {
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
                <i class="fas fa-clock mr-1"></i> ${formattedTime}
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
    return `
        <div class="p-6 h-full flex flex-col items-center justify-center text-center text-gray-600 bg-white rounded-xl">
            <i class="fas fa-file-archive text-5xl text-indigo-400 mb-4"></i>
            <p class="text-lg font-semibold mb-2">${metadata.name || currentFileKey}</p>
            <p class="text-sm">This is a binary file (e.g., .blend, .svg, .zip). Textual content comparison is not available.</p>
            <div class="mt-4 p-3 bg-gray-50 rounded-lg w-full max-w-sm">
                <p class="text-xs font-medium text-gray-700">Modified: ${metadata.mtime || ''}</p>
                <p class="text-xs font-medium text-gray-700">Size: ${metadata.size || ''}</p>
                ${metadata.type ? `<p class="text-xs mt-1 italic">Type: ${metadata.type}</p>` : ''}
                ${metadata.metadata ? `<p class="text-xs mt-1 italic">${metadata.metadata}</p>` : ''}
            </div>
        </div>
    `;
}

/**
 * Switches the content displayed in the backup (right) pane for comparison.
 * The current (left) pane always shows the latest version of the selected file.
 * @param {string} versionKey - The version key (e.g., 'v2', 'v1').
 */
function switchVersion(versionKey) {
    // Find the file object from latestSearchResults
    let fileObj = null;
    if (window.latestSearchResults) {
        fileObj = window.latestSearchResults.find(f => f.name === currentFileKey);
    }
    if (!fileObj || !fileObj.versions) return;

    // Determine latest (current) version key
    const latestVersionKey = Object.keys(fileObj.versions)[0];
    const currentVersion = fileObj.versions[latestVersionKey];
    const selectedVersion = fileObj.versions[versionKey];

    if (!selectedVersion) return;

    currentBackupVersionKey = versionKey;

    // 1. Update the display times
    currentHeaderSpan.textContent = currentVersion.time;
    backupHeaderSpan.textContent = selectedVersion.time;

    // 2. Handle Content Display (Diff or Metadata)
    if (fileObj.type === 'text') {
        currentContentElement.innerHTML = styleDiffContent(currentVersion.content, false); 
        backupContentElement.innerHTML = styleDiffContent(selectedVersion.content, true);
    } else {
        const currentMetadata = renderMetadataView(currentVersion);
        const backupMetadata = renderMetadataView(selectedVersion);

        currentContentElement.innerHTML = currentMetadata;
        backupContentElement.innerHTML = backupMetadata;
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
    }
}

function fetchFileVersions(filePath) {
    return fetch(`/api/file-versions?file_path=${encodeURIComponent(filePath)}`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.versions) {
                return data.versions;
            } else {
                console.error('Failed to fetch versions:', data.error);
                return [];
            }
        })
        .catch(error => {
            console.error('Error fetching file versions:', error);
            return [];
        });
}



document.addEventListener('DOMContentLoaded', () => {
    ActivityManager.init();

    // Search
    const searchInput = document.getElementById('searchInput'); 
    
    // Create a debounced version of fetchAndRenderFiles
    // Adjust the delay (e.g., 500ms) as needed for your application's responsiveness
    const debouncedPerformSearch = debounce(performSearch, 500); 

    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            // Call the debounced function instead of the original directly
            debouncedPerformSearch(event.target.value);
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
            switchVersion(versionKey); 
        }
    });

    // 3. Backup Version Actions Listener
    backupVersionActionsContainer.addEventListener('click', (event) => {
        const actionButton = event.target.closest('.action-btn');
        if (actionButton && currentBackupVersionKey) {
            const action = actionButton.getAttribute('data-action');
            if (action === 'open-location') {
                // Get the selected version's path
                let fileObj = null;
                if (window.latestSearchResults) {
                    fileObj = window.latestSearchResults.find(f => f.name === currentFileKey);
                }
                if (!fileObj || !fileObj.versions) return;
                const selectedVersion = fileObj.versions[currentBackupVersionKey];
                if (!selectedVersion || !selectedVersion.path) return;

                // Open the folder containing the selected version
                const folderPath = selectedVersion.path.substring(0, selectedVersion.path.lastIndexOf('/'));
                openPathInExplorer(folderPath);
            } else {
                handleVersionAction(action, currentBackupVersionKey);
            }
        }
    });

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

// =============================================
// UI MESSAGE HANDLER (for WebSocket/SSE)
// =============================================
const UIMessageHandler = {
    handleMessage: (msg) => {
        try {
            const data = JSON.parse(msg);
            switch (data.type) {
                case 'analysis_progress':
                    ActivityManager.updateAnalysisStatus(data);
                    break;
                case 'new_activity':
                    // The timestamp should ideally be an ISO string from the server.
                    // new Date() is used here as a fallback.
                    data.activity.timestamp = data.activity.timestamp ? new Date(data.activity.timestamp) : new Date();
                    ActivityManager.addActivity(data.activity);
                    break;
                case 'transfer_progress':
                     // TODO: Handle 'transfer_progress' if needed, e.g., update progress bars
                    break;
                case 'scan_complete': // --- NEW: Handle scan completion message ---
                    if (data.status === 'success') {
                        console.log("File scan complete! Search input enabled.");
                        elements.searchInput.disabled = false; // Enable the search input
                        elements.searchInput.placeholder = "Search files..."; // Optional: Update placeholder
                    } 
                    else if (data.status === 'scanning') {
                        console.log("Caching files...");
                        elements.searchInput.disabled = true;  // Disable the search input
                        elements.searchInput.placeholder = "Caching files...";
                    }
                    else {
                        elements.searchInput.placeholder = `Error loading files: ${data.message || 'Unknown error'}`;
                        console.error("File scan failed:", data.message);
                    }
                    break;
            }
        } catch (error) {
            console.error("Failed to parse message from server:", error);
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
            a.download = 'dataguardian_logs.txt';
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
    console.log('Query being sent to API:', query); 
    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(response => response.json())
        .then(data => {
            const fileListContainer = document.getElementById('file-list-container');

            if (!fileListContainer) {
                console.error('Error: Element with ID "file-list-container" not found in web.html.');
                return;
            }

            // Store latest search results globally for later use (e.g., selectFile)
            window.latestSearchResults = data.files || [];

            // Clear previous results
            fileListContainer.innerHTML = '';

            // Track added files to prevent duplicates
            const addedFiles = new Set();

            // Populate with new results
            if (data.files && data.files.length > 0) {
                data.files.forEach(file => {
                    if (addedFiles.has(file.name)) return; // Skip if already added
                    addedFiles.add(file.name);

                    // Determine icon and color based on file type/extension
                    let iconClass = 'fas fa-file';
                    let iconColor = 'text-gray-500';
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (ext === 'txt') {
                        iconClass = 'fas fa-file-alt';
                        iconColor = 'text-green-500';
                    } else if (ext === 'blend') {
                        iconClass = 'fas fa-cube';
                        iconColor = 'text-orange-500';
                    } else if (ext === 'md') {
                        iconClass = 'fas fa-file-code';
                        iconColor = 'text-indigo-500';
                    }

                    // Count versions (default to 1 if not provided)
                    const versionCount = file.versions ? file.versions.length : (file.version_count || 1);

                    // Mark active if needed (example: first file)
                    const isActive = data.files[0] && file.name === data.files[0].name ? 'active' : '';

                    const fileItemDiv = document.createElement('div');
                    fileItemDiv.className = `file-item flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors border-l-4 border-transparent hover:border-indigo-500 ${isActive}`;
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
            const fileListContainer = document.getElementById('file-list-container');
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

    // You can add a confirmation dialog here if desired
    // if (!confirm(`Are you sure you want to open this file?\n\n${filePath}`)) {
    //     return;
    // }

    // Make an API call to a NEW backend endpoint for opening files
    fetch('/api/open-file', { // Changed endpoint here
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
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
function openPathInExplorer(path, openFile) {
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
            console.log(`Successfully requested to open path: ${path}`);
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
 * Sends a request to the backend to restore the specified path .
 * @param {string} path The file or directory path to restore.
 */
function restoreFile(path, restoreFile) {
    if (!path) {
        console.warn("No path provided to openPathInExplorer.");
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
    .then(Utils.handleResponse) // Re-use your existing response handler
    .then(data => {
        if (data && data.success) {
            console.log(`Successfully requested to open path: ${path}`);
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

// =============================================
// INITIALIZATION
// =============================================
const App = {
    init: () => {
        
        Navigation.setup();
        UIControls.setup();
        LogManager.setup();
        UIControls.setupToggles();
        DiffManager.setupModalControls();
        
        // Initial data loading
        BackupManager.updateUsage();
        DeviceManager.load();
        LogManager.load();
        FolderManager.loadWatchedFolders();  // Load folders immediately
        
        // Set up intervals
        // AppState.intervals.backup = setInterval(BackupManager.updateStatus, 1000);  // TO REMOVE
        AppState.intervals.device = setInterval(DeviceManager.loadCurrent, 5000);  // Load current device every 5 seconds
        AppState.intervals.storage = setInterval(BackupManager.updateUsage, 30000);  // Update storage usage every 30 seconds

        // Check if backup path is configured
        fetch('/api/backup/check-config')
            .then(response => response.json())
            .then(data => {
                if (data.is_configured) {
                    console.log('Using configured path:', data.path);
                    BackupManager.updateUsage();
                    // Update the UI with the choose backup device's name
                    devicesName.textContent = data.device_name || 'N/A';
                    // Update the UI with the devices filesystem
                    devicesFilesystem.textContent = data.filesystem || 'N/A';
                    // Update the UI with the devices serial number
                    devicesSerialNumber.textContent = data.serial_number || 'N/A';
                    // Update the UI with the devices model
                    devicesModel.textContent = data.model || 'N/A';
                } else {
                    console.log('No backup path configured');
                    Navigation.showSection('devices');
                }
            });
        DiffManager.init();
    },

    cleanup: () => {
        Object.values(AppState.intervals).forEach(interval => {
            if (interval) clearInterval(interval);
        });
    },

};

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());




// Establish WebSocket connection
const socket = new WebSocket('ws://localhost:5000/ws'); // Replace with your WebSocket URL

socket.addEventListener('open', (event) => {
    console.log('WebSocket connection established.');
});

socket.addEventListener('message', (event) => {
    UIMessageHandler.handleMessage(event.data);
});

socket.addEventListener('close', (event) => {
    console.log('WebSocket connection closed.');
});


// Clean up on page unload
window.addEventListener('beforeunload', App.cleanup);