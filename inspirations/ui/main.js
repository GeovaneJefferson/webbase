const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: path.join(__dirname, 'static', 'icon.png')
    });

    // Just connect to Flask - don't start it
    mainWindow.loadURL('http://127.0.0.1:5000');

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', () => {
    setTimeout(createWindow, 1000);
});

app.on('window-all-closed', () => {
    app.quit();
});