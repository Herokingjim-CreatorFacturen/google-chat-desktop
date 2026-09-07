const { app, BrowserWindow, Tray, Menu, shell, session, powerMonitor, nativeImage, powerSaveBlocker, Notification, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// --- THE ULTIMATE ANTI-SLEEP ENGINE ---
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-background-media-suspend'); 

let mainWindow;
let tray = null;
let isIdle = false; 
let globalUnreadCount = 0;
let lastTitle = '';
let lastSoundTime = 0; 
let clearBadgeTimer = null;
let highestUnreadCount = 0;

function getIconPath(fileName) {
  if (app.isPackaged) { return path.join(process.resourcesPath, fileName); }
  return path.join(__dirname, fileName);
}

function getSoundsDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'sounds') : path.join(__dirname, 'sounds');
}

// --- CONFIGURATION SYSTEM ---
const configPath = path.join(app.getPath('userData'), 'google-chat-settings.json');
let config = { selectedSound: 'default', selectedTheme: 'none', alwaysOnTop: false, widgetMode: false, runAtStartup: true, idleTimeout: 300, privateMode: false, vipSounds: {} };

if (fs.existsSync(configPath)) { 
  config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; 
}
saveConfig();
function saveConfig() { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }

app.setAppUserModelId("com.yourname.googlechat");
app.setLoginItemSettings({ openAtLogin: config.runAtStartup });

// --- AUTOMATISCHE CHROME VERSIE GENERATOR ---
// Chrome versie 120 was in december 2023. We rekenen er 1 versie per maand bij op.
const currentDate = new Date();
const dynamicChromeVersion = 120 + ((currentDate.getFullYear() - 2023) * 12) + currentDate.getMonth();
app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${dynamicChromeVersion}.0.0.0 Safari/537.36`;

// --- IPC BRIDGE FOR THE VIP UI & UPLOADER ---
ipcMain.handle('get-vips', () => {
  const soundsDir = getSoundsDir();
  const soundFiles = fs.existsSync(soundsDir) ? fs.readdirSync(soundsDir).filter(f => f.endsWith('.mp3')) : [];
  return { vips: config.vipSounds, sounds: soundFiles };
});

ipcMain.on('save-vips', (event, newVips) => {
  config.vipSounds = newVips;
  saveConfig();
});

ipcMain.handle('upload-sound', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select an MP3 Sound File',
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['mp3'] }]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const sourcePath = result.filePaths[0];
    const fileName = path.basename(sourcePath);
    const soundsDir = getSoundsDir();
    
    if (!fs.existsSync(soundsDir)) {
      fs.mkdirSync(soundsDir, { recursive: true });
    }
    
    fs.copyFileSync(sourcePath, path.join(soundsDir, fileName));
    updateTrayMenu(); 
    return true; 
  }
  return false;
});

function openVipManager() {
  const vipWin = new BrowserWindow({
    width: 480, height: 680,
    title: "VIP Sounds Manager",
    autoHideMenuBar: true,
    icon: getIconPath('icon.ico'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  vipWin.loadFile('vip.html');
}

function updateBadgeUI(count) {
  globalUnreadCount = count;
  app.setBadgeCount(count); 
  
  if (!mainWindow) return;

  try {
    if (count > 0) {
      if (tray) {
        const alertImg = nativeImage.createFromPath(getIconPath('icon-alert.ico'));
        if (!alertImg.isEmpty()) tray.setImage(alertImg); 
        tray.setToolTip(`Google Chat (${count} unread)`);
      }
    } else {
      if (tray) {
        const stdImg = nativeImage.createFromPath(getIconPath('icon.ico'));
        if (!stdImg.isEmpty()) tray.setImage(stdImg); 
        tray.setToolTip('Google Chat');
      }
    }
  } catch (error) { console.log("Badge Update Error:", error); }
}

function playCustomSound(overrideSound = null) {
  if (mainWindow && mainWindow.isFocused()) return;
  
  const soundToPlay = overrideSound || config.selectedSound;
  if (soundToPlay === 'default' || soundToPlay === 'none' || isIdle) return; 

  const now = Date.now();
  if (now - lastSoundTime < 10000) return; 
  lastSoundTime = now; 

  try {
    const soundPath = path.join(getSoundsDir(), soundToPlay);
    if (fs.existsSync(soundPath) && mainWindow) {
      const audioBase64 = fs.readFileSync(soundPath).toString('base64');
      mainWindow.webContents.executeJavaScript(`
        try {
          if (window.customAudio) { window.customAudio.pause(); } 
          window.customAudio = new Audio("data:audio/mp3;base64,${audioBase64}");
          window.customAudio.play().catch(e => console.log("Audio Error:", e));
        } catch(err) { console.log(err); }
      `);
    }
  } catch (error) { console.log("Could not play custom sound.", error); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: config.widgetMode ? 380 : 1200, height: config.widgetMode ? 650 : 800,
    autoHideMenuBar: true, alwaysOnTop: config.alwaysOnTop || config.widgetMode,
    icon: getIconPath('icon.ico'), 
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'notifications');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'notifications'));

  mainWindow.loadURL('https://chat.google.com');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('chat.google.com') || url.includes('accounts.google.com')) { mainWindow.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url); return { action: 'deny' };
  });

  mainWindow.on('close', function (event) {
    if (!app.isQuiting) { event.preventDefault(); mainWindow.hide(); }
    return false;
  });

  mainWindow.webContents.on('dom-ready', () => {
    const injectionScript = `
      if (!window.customNotificationHook) {
        window.customNotificationHook = true;
        class CustomNotification {
          constructor(title, options) {
            console.log('ELECTRON_NOTIF|' + JSON.stringify({ title: title, body: options ? options.body : '' }));
          }
          static get permission() { return 'granted'; }
          static requestPermission(cb) { if (cb) cb('granted'); return Promise.resolve('granted'); }
        }
        window.Notification = CustomNotification;

        if (window.ServiceWorkerRegistration) {
          window.ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
            console.log('ELECTRON_NOTIF|' + JSON.stringify({ title: title, body: options ? options.body : '' }));
            return Promise.resolve();
          };
        }
      }
    `;
    mainWindow.webContents.executeJavaScript(injectionScript).catch(e => console.log("Hook error:", e));
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (typeof message === 'string' && message.startsWith('ELECTRON_NOTIF|')) {
      if (mainWindow && mainWindow.isFocused()) return; 

      try {
        const payload = JSON.parse(message.replace('ELECTRON_NOTIF|', ''));
        let notifTitle = payload.title; 
        let notifBody = payload.body;

        let playedVipSound = false;
        
        for (const [vipName, vipSound] of Object.entries(config.vipSounds)) {
          if (notifTitle.toLowerCase().includes(vipName.toLowerCase())) {
            playCustomSound(vipSound); 
            playedVipSound = true;
            break; 
          }
        }

        if (!playedVipSound) {
          playCustomSound(); 
        }

        if (config.privateMode) {
          notifTitle = "New Message";
          notifBody = "Content hidden for privacy";
        }

        if (Notification.isSupported()) {
          const nativeBanner = new Notification({
            title: notifTitle,
            body: notifBody,
            icon: getIconPath('icon.ico'),
            silent: true 
          });

          nativeBanner.on('click', () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          });

          nativeBanner.show();
        }
      } catch (e) { console.log("Notification Parser Error", e); }
    }
  });

  mainWindow.on('page-title-updated', (event, title) => {
    if (title === lastTitle) return; 
    lastTitle = title;

    if (mainWindow && mainWindow.isFocused()) return;

    let currentUnread = 0;
    const unreadMatch = title.match(/\((\d+)\)/);
    
    if (unreadMatch) {
      currentUnread = parseInt(unreadMatch[1], 10);
    } else if (title.trim() !== 'Google Chat' && title.trim() !== 'Chat') {
      currentUnread = highestUnreadCount > 0 ? highestUnreadCount : 1;
    }

    if (currentUnread > 0) {
      if (clearBadgeTimer) { clearTimeout(clearBadgeTimer); clearBadgeTimer = null; }
      if (currentUnread > highestUnreadCount) {
        highestUnreadCount = currentUnread;
      }
      updateBadgeUI(currentUnread);
    } else if (title.trim() === 'Google Chat') {
      if (!clearBadgeTimer) {
        clearBadgeTimer = setTimeout(() => {
          highestUnreadCount = 0; 
          updateBadgeUI(0);
          clearBadgeTimer = null;
        }, 10000); 
      }
    }
  });

  const clearBadges = () => {
    if (clearBadgeTimer) { clearTimeout(clearBadgeTimer); clearBadgeTimer = null; }
    highestUnreadCount = 0;
    updateBadgeUI(0);
    lastTitle = 'Google Chat';
    lastSoundTime = Date.now(); 
  };
  
  mainWindow.on('focus', clearBadges);
  mainWindow.on('restore', clearBadges);
  mainWindow.on('show', clearBadges);

  setInterval(() => {
    if (config.idleTimeout === 0) {
      if (isIdle) { isIdle = false; updateBadgeUI(globalUnreadCount); }
      return;
    }

    const idleTime = powerMonitor.getSystemIdleTime();
    if (idleTime > config.idleTimeout) { 
      if (!isIdle) { isIdle = true; if (tray) tray.setToolTip('Google Chat (Away - Idle)'); }
    } else {
      if (isIdle) { isIdle = false; updateBadgeUI(globalUnreadCount); }
    }
  }, 10000); 
}

function updateTrayMenu() {
  if (!tray) return;

  const soundMenuTemplate = [
    { label: 'Google Default', type: 'radio', checked: config.selectedSound === 'default', click: () => { config.selectedSound = 'default'; saveConfig(); updateTrayMenu(); } },
    { label: 'MSN Classic', type: 'radio', checked: config.selectedSound === 'msn.mp3', click: () => { config.selectedSound = 'msn.mp3'; saveConfig(); updateTrayMenu(); } },
    { label: 'None (Mute All)', type: 'radio', checked: config.selectedSound === 'none', click: () => { config.selectedSound = 'none'; saveConfig(); updateTrayMenu(); } }
  ];

  const idleMenuTemplate = [
    { label: '1 Minute', type: 'radio', checked: config.idleTimeout === 60, click: () => { config.idleTimeout = 60; saveConfig(); updateTrayMenu(); } },
    { label: '5 Minutes', type: 'radio', checked: config.idleTimeout === 300, click: () => { config.idleTimeout = 300; saveConfig(); updateTrayMenu(); } },
    { label: '15 Minutes', type: 'radio', checked: config.idleTimeout === 900, click: () => { config.idleTimeout = 900; saveConfig(); updateTrayMenu(); } },
    { label: 'Never (Always Active)', type: 'radio', checked: config.idleTimeout === 0, click: () => { config.idleTimeout = 0; saveConfig(); updateTrayMenu(); } }
  ];

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Google Chat', click: () => mainWindow.show() },
    { label: 'Reload App', click: () => mainWindow.reload() },
    { type: 'separator' },
    { label: '👤 Manage VIP Sounds', click: () => openVipManager() },
    { type: 'separator' },
    { label: 'Private Notifications (Hide Text)', type: 'checkbox', checked: config.privateMode, click: (item) => { 
        config.privateMode = item.checked; saveConfig(); 
      } 
    },
    { label: 'Run at Startup', type: 'checkbox', checked: config.runAtStartup, click: (item) => { 
        config.runAtStartup = item.checked; saveConfig(); app.setLoginItemSettings({ openAtLogin: config.runAtStartup }); 
      } 
    },
    { label: 'Always on Top', type: 'checkbox', checked: config.alwaysOnTop, click: (item) => { 
        config.alwaysOnTop = item.checked; saveConfig(); if (!config.widgetMode) mainWindow.setAlwaysOnTop(config.alwaysOnTop); 
      } 
    },
    { type: 'separator' },
    { label: 'Default Notification Sound', submenu: soundMenuTemplate },
    { label: 'Idle Timeout (Away)', submenu: idleMenuTemplate },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); 
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    powerSaveBlocker.start('prevent-app-suspension');
    
    createWindow();
    const stdImg = nativeImage.createFromPath(getIconPath('icon.ico'));
    tray = new Tray(stdImg); 
    updateBadgeUI(0); 
    tray.on('double-click', () => {
      mainWindow.show();
    });
    updateTrayMenu();
  });
}