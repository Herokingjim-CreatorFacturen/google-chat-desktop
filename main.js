'use strict';

const {
  app, BrowserWindow, Tray, Menu, shell, session, powerMonitor, nativeImage,
  powerSaveBlocker, Notification, ipcMain, dialog, screen, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');
const { pickAlertSound } = require('./alerts');

const CHAT_URL = 'https://chat.google.com';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Single instance -- claim this before doing any other work.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return; // CommonJS modules are function-wrapped, so this is a legal early exit.
}

log.transports.file.level = 'info';
log.transports.console.level = 'info';
log.info(`--- Starting ${app.getName()} ${app.getVersion()} `
  + `(Electron ${process.versions.electron}, Chromium ${process.versions.chrome}) ---`);

// ---------------------------------------------------------------------------
// Profile migration
//
// Older builds took their userData folder name from package.json's `name`
// ("google-Eddie-1.3.3"). Now that a proper productName is set, the folder is
// "%APPDATA%\Google Chat" instead -- which would silently sign everyone out and
// lose their settings. Carry the old profile over on first run.
// ---------------------------------------------------------------------------
// Folder names this app has shipped under before now.
const LEGACY_PROFILE_PATTERN = /^(google-Eddie.*|google-chat-desktop|google-chat-electron)$/i;

// Caches are large, frequently locked by a running instance, and regenerate on
// their own -- copying them buys nothing and is the most likely way to fail.
const PROFILE_SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'blob_storage', 'logs'
]);

// Chromium moved the cookie DB into Network/ years ago; older profiles still
// have it at the top level. Finding it is what proves a folder holds a real
// signed-in session rather than an empty shell.
function findCookieDb(dir) {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const MIGRATION_MARKER = '.profile-migration.json';
const MIGRATION_MAX_ATTEMPTS = 3;

function readMigrationMarker(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, MIGRATION_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function writeMigrationMarker(target, state) {
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, MIGRATION_MARKER), JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn('Could not record migration state:', err);
  }
}

function pickLegacyProfile(target) {
  const appDataRoot = app.getPath('appData');
  return fs.readdirSync(appDataRoot)
    .filter((name) => LEGACY_PROFILE_PATTERN.test(name))
    .map((name) => path.join(appDataRoot, name))
    .filter((dir) => dir !== target)
    .map((dir) => ({ dir, cookieDb: findCookieDb(dir) }))
    .filter((entry) => entry.cookieDb)
    // Most recently *used* wins -- the cookie DB's mtime, not the folder's,
    // which anything at all can touch.
    .sort((a, b) => fs.statSync(b.cookieDb).mtimeMs - fs.statSync(a.cookieDb).mtimeMs)[0] || null;
}

/**
 * Copy a profile tree file by file. A single locked file must not abandon the
 * whole migration, so failures are counted rather than thrown.
 */
function copyProfileTree(sourceDir, targetDir) {
  let copied = 0;
  let failed = 0;

  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (PROFILE_SKIP.has(entry.name)) continue;
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      try {
        if (entry.isDirectory()) walk(src, dest);
        else if (entry.isFile()) { fs.copyFileSync(src, dest); copied += 1; }
      } catch (err) {
        failed += 1;
        log.warn(`Skipped ${src} during migration: ${err.code || err.message}`);
      }
    }
  };

  walk(sourceDir, targetDir);
  return { copied, failed };
}

// Set when migration could not run because the old app still holds its profile;
// surfaced to the user once the app is ready.
let migrationWarning = null;

function migrateLegacyProfile() {
  const target = app.getPath('userData');

  try {
    const marker = readMigrationMarker(target);
    if (marker && marker.status === 'done') return;

    const attempts = marker && Number.isInteger(marker.attempts) ? marker.attempts : 0;
    if (attempts >= MIGRATION_MAX_ATTEMPTS) {
      log.warn(`Giving up on profile migration after ${attempts} attempts.`);
      writeMigrationMarker(target, { status: 'done', attempts, outcome: 'gave-up' });
      return;
    }

    const source = pickLegacyProfile(target);
    if (!source) {
      log.info('No previous profile to migrate; starting fresh.');
      writeMigrationMarker(target, { status: 'done', attempts, outcome: 'nothing-to-migrate' });
      return;
    }

    // If our own profile is already newer than the source, this install has been
    // used since -- never clobber a live session with a stale one.
    const targetCookieDb = findCookieDb(target);
    if (targetCookieDb
        && fs.statSync(targetCookieDb).mtimeMs > fs.statSync(source.cookieDb).mtimeMs) {
      log.info('Current profile is newer than the legacy one; skipping migration.');
      writeMigrationMarker(target, { status: 'done', attempts, outcome: 'target-newer' });
      return;
    }

    // The cookie DB goes first and alone. It is the whole point of the exercise,
    // and it is the file the old app keeps locked while it runs -- so if it
    // cannot be copied, bail out now having written almost nothing.
    log.info(`Migrating profile from ${source.dir} -> ${target}`);
    const cookieDest = path.join(target, path.relative(source.dir, source.cookieDb));
    try {
      fs.mkdirSync(path.dirname(cookieDest), { recursive: true });
      fs.copyFileSync(source.cookieDb, cookieDest);
    } catch (err) {
      log.warn(`Cookie database is locked (${err.code || err.message}); deferring migration.`);
      writeMigrationMarker(target, { status: 'pending', attempts: attempts + 1, source: source.dir });
      migrationWarning = path.basename(source.dir);
      return;
    }

    const { copied, failed } = copyProfileTree(source.dir, target);
    log.info(`Profile migration complete: ${copied} files copied, ${failed} skipped.`);
    writeMigrationMarker(target, {
      status: 'done', attempts: attempts + 1, source: source.dir, copied, failed
    });
  } catch (err) {
    // A failed migration just means signing in again -- never a reason to crash.
    log.error('Profile migration failed (starting with a fresh profile):', err);
    writeMigrationMarker(target, { status: 'pending', attempts: MIGRATION_MAX_ATTEMPTS });
  }
}
migrateLegacyProfile();

// ---------------------------------------------------------------------------
// Anti-sleep switches -- Chat is useless if Chromium throttles it in the tray.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-background-media-suspend');

let mainWindow = null;
let helperWindow = null;      // hidden: plays sounds, renders badge PNGs
let tray = null;
let isQuitting = false;
let isIdle = false;
let globalUnreadCount = 0;
let lastTitle = '';
let lastSoundTime = 0;
let clearBadgeTimer = null;
let highestUnreadCount = 0;
let reloadAttempt = 0;
let reloadTimer = null;
let updateState = { status: 'idle', version: null, message: null };

const launchedHidden = process.argv.includes('--hidden');

function getResourcePath(fileName) {
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.join(__dirname, fileName);
}

// Bundled sounds ship read-only inside the install dir and are REPLACED on every
// update. Anything the user uploads therefore has to live in userData, or each
// update would quietly delete their custom VIP sounds.
function getBundledSoundsDir() { return getResourcePath('sounds'); }
function getUserSoundsDir() { return path.join(app.getPath('userData'), 'sounds'); }

function listSounds() {
  const seen = new Set();
  for (const dir of [getUserSoundsDir(), getBundledSoundsDir()]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.mp3')) seen.add(f);
      }
    } catch (err) {
      log.warn(`Could not read sounds from ${dir}:`, err);
    }
  }
  return [...seen].sort();
}

function resolveSoundPath(fileName) {
  for (const dir of [getUserSoundsDir(), getBundledSoundsDir()]) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings
//
// The old version did a bare JSON.parse with no guard and a non-atomic write.
// A power cut mid-save left a truncated file that crashed the app on every
// subsequent launch, permanently, with no way out from the UI.
// ---------------------------------------------------------------------------
const configPath = path.join(app.getPath('userData'), 'google-chat-settings.json');
const DEFAULT_CONFIG = {
  selectedSound: 'default',
  alwaysOnTop: false,
  widgetMode: false,
  runAtStartup: true,
  idleTimeout: 300,
  privateMode: false,
  autoUpdate: true,
  vipSounds: {},
  keywordSounds: {},
  spellCheckLanguages: ['nl', 'en-US'],
  bounds: null,
  maximized: false
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...DEFAULT_CONFIG, ...parsed };
      }
      throw new Error('settings file is not an object');
    }
  } catch (err) {
    log.error('Settings file unreadable; resetting to defaults.', err);
    try {
      fs.renameSync(configPath, `${configPath}.corrupt-${Date.now()}`);
    } catch (renameErr) {
      log.error('Could not set the corrupt settings file aside:', renameErr);
    }
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig() {
  try {
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath); // atomic within the same volume
  } catch (err) {
    log.error('Could not save settings:', err);
  }
}

const config = loadConfig();
saveConfig();

app.setAppUserModelId('com.yourname.googlechat');
app.setLoginItemSettings({ openAtLogin: config.runAtStartup, args: ['--hidden'] });

// ---------------------------------------------------------------------------
// User agent
//
// This used to compute a fake Chrome major version from the calendar, which by
// now claims a version ~14 ahead of the engine actually running. That is worse
// than not spoofing at all: navigator.userAgentData and the Sec-CH-UA request
// headers are generated from the real Chromium build and cannot be moved by
// userAgentFallback, so the two disagree and the mismatch is trivially
// detectable. Reporting the real major keeps every signal consistent, and the
// ".0.0.0" tail matches Chrome's own UA-reduction format.
//
// Staying un-blocked is a matter of keeping Chromium current -- which is what
// the auto-updater below is for -- not of claiming to be newer than we are.
// ---------------------------------------------------------------------------
const chromeMajor = process.versions.chrome.split('.')[0];
app.userAgentFallback =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + `Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
log.info(`User agent pinned to real engine: Chrome/${chromeMajor}`);

// ---------------------------------------------------------------------------
// Hidden helper window: sound playback + badge rendering
// ---------------------------------------------------------------------------
function createHelperWindow() {
  helperWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  });
  helperWindow.loadFile('audio.html');
  helperWindow.on('closed', () => { helperWindow = null; });
}

async function helperEval(expression) {
  if (!helperWindow || helperWindow.isDestroyed()) return null;
  try {
    return await helperWindow.webContents.executeJavaScript(expression);
  } catch (err) {
    log.warn('Helper window call failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Taskbar badge
//
// app.setBadgeCount() is documented linux/darwin only and does nothing at all
// on Windows -- which is why the unread count never showed up. Windows needs a
// taskbar overlay icon instead.
// ---------------------------------------------------------------------------
async function updateBadgeUI(count) {
  globalUnreadCount = count;

  try {
    if (tray) {
      const iconFile = count > 0 ? 'icon-alert.ico' : 'icon.ico';
      const img = nativeImage.createFromPath(getResourcePath(iconFile));
      if (!img.isEmpty()) tray.setImage(img);
      tray.setToolTip(count > 0 ? `Google Chat (${count} unread)` : 'Google Chat');
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (count > 0) {
      let overlay = null;
      const dataUrl = await helperEval(`makeBadge(${Number(count)})`);
      if (dataUrl) overlay = nativeImage.createFromDataURL(dataUrl);
      if (!overlay || overlay.isEmpty()) {
        overlay = nativeImage.createFromPath(getResourcePath('badge-dot.png'));
      }
      if (!overlay.isEmpty()) {
        mainWindow.setOverlayIcon(overlay, `${count} unread message${count === 1 ? '' : 's'}`);
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } catch (err) {
    log.warn('Badge update failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Notification sounds
// ---------------------------------------------------------------------------
async function playCustomSound(overrideSound = null, { urgent = false } = {}) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  const soundToPlay = overrideSound || config.selectedSound;
  if (soundToPlay === 'default' || soundToPlay === 'none' || isIdle) return;

  // Ordinary traffic is rate-limited so a busy room can't machine-gun you.
  // A keyword hit is the case you specifically asked to be interrupted for,
  // so it ignores the throttle.
  const now = Date.now();
  if (!urgent && now - lastSoundTime < 10000) return;
  lastSoundTime = now;

  try {
    const soundPath = resolveSoundPath(soundToPlay);
    if (!soundPath) {
      log.warn(`Sound not found: ${soundToPlay}`);
      return;
    }

    // Hand the file over once; after that the helper window replays from cache.
    const cached = await helperEval(`hasSound(${JSON.stringify(soundToPlay)})`);
    if (!cached) {
      const dataUrl = `data:audio/mp3;base64,${fs.readFileSync(soundPath).toString('base64')}`;
      await helperEval(`loadSound(${JSON.stringify(soundToPlay)}, ${JSON.stringify(dataUrl)})`);
    }
    await helperEval(`playSound(${JSON.stringify(soundToPlay)})`);
  } catch (err) {
    log.warn('Could not play notification sound:', err);
  }
}

// ---------------------------------------------------------------------------
// Notification capture
//
// The hook runs in the page's own (main) world, where Google's code lives. It
// cannot talk to the main process directly, so it dispatches a DOM CustomEvent
// carrying a JSON string; preload.js listens for that in the isolated world --
// the two worlds share the DOM -- and forwards it over IPC.
//
// The previous design shouted the payload through console.log and read it back
// via the 'console-message' event, whose (event, level, message) signature is
// deprecated in Electron. When that is removed, notifications stop dead.
// ---------------------------------------------------------------------------
const NOTIFICATION_HOOK = `
(() => {
  if (window.__gcwNotificationHook) return 'already-installed';
  window.__gcwNotificationHook = true;

  const emit = (title, options) => {
    try {
      window.dispatchEvent(new CustomEvent('gcw-notification', {
        detail: JSON.stringify({
          title: title == null ? '' : String(title),
          body: options && options.body ? String(options.body) : ''
        })
      }));
    } catch (e) { /* a broken hook must never break the Chat page */ }
  };

  class GcwNotification {
    constructor(title, options) { emit(title, options); }
    static get permission() { return 'granted'; }
    static requestPermission(cb) { if (cb) cb('granted'); return Promise.resolve('granted'); }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  window.Notification = GcwNotification;

  if (window.ServiceWorkerRegistration) {
    window.ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      emit(title, options);
      return Promise.resolve();
    };
  }
  return 'installed';
})();
`;

ipcMain.on('gcw:notification', (event, rawPayload) => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (err) {
    log.warn('Malformed notification payload:', err);
    return;
  }

  const title = String(payload.title || 'Google Chat');
  const body = String(payload.body || '');

  const alert = pickAlertSound({ title, body }, config);
  if (alert.matched === 'keyword') {
    log.info(`Keyword "${alert.term}" matched; alerting.`);
  }
  playCustomSound(alert.sound, { urgent: alert.urgent });

  if (!Notification.isSupported()) return;

  const banner = new Notification({
    title: config.privateMode ? 'New Message' : title,
    body: config.privateMode ? 'Content hidden for privacy' : body,
    icon: getResourcePath('icon.ico'),
    silent: true,
    // Asks Windows to treat a keyword hit as high priority, so it is less
    // likely to be quietly collapsed into the notification centre.
    urgency: alert.matched === 'keyword' ? 'critical' : 'normal'
  });
  banner.on('click', () => showMainWindow());
  banner.show();
});

// ---------------------------------------------------------------------------
// Spellcheck
//
// Chromium ships the dictionaries; Electron just needs to be told which to
// load. Left alone it follows the system locale only, so a Dutch/English
// workplace gets one of the two underlined as gibberish.
// ---------------------------------------------------------------------------
function applySpellCheckLanguages() {
  const available = session.defaultSession.availableSpellCheckerLanguages;
  const wanted = (config.spellCheckLanguages || []).filter((lang) => available.includes(lang));

  try {
    // An empty list is how Electron expresses "spellcheck off".
    session.defaultSession.setSpellCheckerLanguages(wanted);
    log.info(`Spellcheck: ${wanted.length ? wanted.join(', ') : 'disabled'}`);
  } catch (err) {
    log.warn('Could not set spellcheck languages:', err);
  }
}

// ---------------------------------------------------------------------------
// Right-click menu
//
// Electron provides none of this by default: without it there is no Cut, Copy,
// Paste or spelling correction anywhere in the app, which is a strange thing to
// discover in something you type in all day.
// ---------------------------------------------------------------------------
function attachContextMenu(webContents) {
  webContents.on('context-menu', (event, params) => {
    const template = [];
    const { editFlags } = params;

    for (const suggestion of params.dictionarySuggestions) {
      template.push({
        label: suggestion,
        click: () => webContents.replaceMisspelling(suggestion)
      });
    }
    if (params.dictionarySuggestions.length > 0) template.push({ type: 'separator' });

    if (params.misspelledWord) {
      template.push({
        label: 'Add to dictionary',
        click: () => session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      template.push({ type: 'separator' });
    }

    if (params.linkURL) {
      template.push(
        { label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }

    if (params.mediaType === 'image' && params.srcURL) {
      template.push(
        { label: 'Copy image', click: () => webContents.copyImageAt(params.x, params.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }

    template.push(
      { label: 'Cut', role: 'cut', enabled: editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll', enabled: editFlags.canSelectAll }
    );

    if (!app.isPackaged) {
      template.push(
        { type: 'separator' },
        { label: 'Inspect element', click: () => webContents.inspectElement(params.x, params.y) }
      );
    }

    Menu.buildFromTemplate(template).popup();
  });
}

// ---------------------------------------------------------------------------
// Navigation policy
// ---------------------------------------------------------------------------
function isGoogleHost(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname === 'google.com'
      || hostname.endsWith('.google.com')
      || hostname.endsWith('.googleusercontent.com')
      || hostname === 'accounts.youtube.com';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Offline recovery
//
// With "run at startup" enabled the app very often launches before the network
// is up. Previously that left a dead Chromium error page that never retried --
// you had to notice and reload by hand.
// ---------------------------------------------------------------------------
function loadChat() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  mainWindow.loadURL(CHAT_URL).catch((err) => log.warn('loadURL rejected:', err));
}

function scheduleReload(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || reloadTimer) return;

  reloadAttempt += 1;
  const delaySec = Math.min(60, 2 ** reloadAttempt);
  log.info(`Load failed (${reason}); retry #${reloadAttempt} in ${delaySec}s`);

  mainWindow.loadFile('offline.html', { query: { in: String(delaySec) } })
    .catch((err) => log.warn('Could not show offline page:', err));

  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadChat();
  }, delaySec * 1000);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Window bounds
// ---------------------------------------------------------------------------
function restoreBounds() {
  const fallback = config.widgetMode
    ? { width: 380, height: 650 }
    : { width: 1200, height: 800 };

  const saved = config.bounds;
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return fallback;

  // A window saved on a monitor that is no longer attached must not be restored
  // off-screen, where it cannot be reached.
  const visible = screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return saved.x < wa.x + wa.width && saved.x + saved.width > wa.x
      && saved.y < wa.y + wa.height && saved.y + saved.height > wa.y;
  });
  if (!visible) return fallback;

  return {
    x: saved.x,
    y: saved.y,
    width: Math.max(380, saved.width),
    height: Math.max(400, saved.height)
  };
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
    config.bounds = mainWindow.getBounds();
  }
  config.maximized = mainWindow.isMaximized();
  saveConfig();
}

// 'resize' and 'move' fire continuously while a window is dragged, so writing
// the settings file straight from the handler means hundreds of writes per drag.
let boundsTimer = null;
function persistBoundsSoon() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    persistBounds();
  }, 500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...restoreBounds(),
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: config.alwaysOnTop || config.widgetMode,
    icon: getResourcePath('icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (config.maximized) mainWindow.maximize();

  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'notifications');
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, callback) => callback(permission === 'notifications')
  );

  applySpellCheckLanguages();
  attachContextMenu(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    if (!launchedHidden) mainWindow.show();
  });

  loadChat();

  // Popups: keep Chat and sign-in in-window, send everything else to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('chat.google.com') || url.includes('accounts.google.com')) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // In-place navigation: previously unguarded, so an external link could replace
  // the whole app with an arbitrary site and leave no way back.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') || isGoogleHost(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.webContents.getURL().startsWith('file://')) return; // the offline page
    reloadAttempt = 0;
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: a normal part of redirects
    scheduleReload(`${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('Renderer went away:', details);
    if (details.reason !== 'clean-exit') loadChat();
  });

  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.executeJavaScript(NOTIFICATION_HOOK)
      .then((result) => log.info(`Notification hook: ${result}`))
      .catch((err) => log.error('Notification hook failed to install:', err));
  });

  mainWindow.on('page-title-updated', (event, title) => {
    if (title === lastTitle) return;
    lastTitle = title;
    if (mainWindow.isFocused()) return;

    let currentUnread = 0;
    const unreadMatch = title.match(/\((\d+)\)/);

    if (unreadMatch) {
      currentUnread = parseInt(unreadMatch[1], 10);
    } else if (title.trim() !== 'Google Chat' && title.trim() !== 'Chat') {
      currentUnread = highestUnreadCount > 0 ? highestUnreadCount : 1;
    }

    if (currentUnread > 0) {
      if (clearBadgeTimer) { clearTimeout(clearBadgeTimer); clearBadgeTimer = null; }
      if (currentUnread > highestUnreadCount) highestUnreadCount = currentUnread;
      updateBadgeUI(currentUnread);
    } else if (title.trim() === 'Google Chat' && !clearBadgeTimer) {
      clearBadgeTimer = setTimeout(() => {
        highestUnreadCount = 0;
        updateBadgeUI(0);
        clearBadgeTimer = null;
      }, 10000);
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
  mainWindow.on('resize', persistBoundsSoon);
  mainWindow.on('move', persistBoundsSoon);

  mainWindow.on('close', (event) => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    persistBounds();
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  setInterval(() => {
    if (config.idleTimeout === 0) {
      if (isIdle) { isIdle = false; updateBadgeUI(globalUnreadCount); }
      return;
    }
    if (powerMonitor.getSystemIdleTime() > config.idleTimeout) {
      if (!isIdle) {
        isIdle = true;
        if (tray) tray.setToolTip('Google Chat (Away - Idle)');
      }
    } else if (isIdle) {
      isIdle = false;
      updateBadgeUI(globalUnreadCount);
    }
  }, 10000);
}

// Waking from sleep on a different network usually leaves a stale socket behind.
powerMonitor.on('resume', () => {
  log.info('System resumed; refreshing Chat.');
  reloadAttempt = 0;
  loadChat();
});

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------
function setUpdateState(status, extra = {}) {
  updateState = { status, version: null, message: null, ...extra };
  updateTrayMenu();
}

function installUpdateNow() {
  isQuitting = true;
  // quitAndInstall has to run after this tick so the click handler can unwind.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

function checkForUpdates({ interactive = false } = {}) {
  if (!app.isPackaged) {
    if (interactive) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: 'Auto-update only runs in an installed build, not from `npm start`.'
      });
    }
    return;
  }
  if (!config.autoUpdate && !interactive) return;

  autoUpdater.checkForUpdates().catch((err) => {
    const message = String(err && err.message ? err.message : err);
    if (message.includes('No published versions')) {
      if (interactive) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Updates',
          message: `You’re on the latest version (${app.getVersion()}).`
        });
      }
      return;
    }
    log.error('Update check failed:', err);
    if (interactive) {
      dialog.showMessageBox({
        type: 'error',
        title: 'Update check failed',
        message: 'Could not reach the update server.',
        detail: message
      });
    }
  });
}

function initAutoUpdater() {
  if (!app.isPackaged) {
    log.info('Auto-update disabled: not a packaged build.');
    setUpdateState('dev');
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // This app lives in the tray and may never be quit deliberately, so also let
  // a staged update land on the next Windows shutdown.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setUpdateState('checking'));
  autoUpdater.on('update-not-available', () => setUpdateState('up-to-date'));
  autoUpdater.on('update-available', (info) => {
    log.info(`Update available: ${info.version}`);
    setUpdateState('downloading', { version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    // Deliberately not rebuilding the tray menu on every progress tick.
    updateState = {
      status: 'downloading',
      version: updateState.version,
      message: `${Math.round(p.percent)}%`
    };
  });
  autoUpdater.on('error', (err) => {
    const message = String(err && err.message ? err.message : err);
    // A repo with no releases yet is a normal state, not a failure -- don't put
    // a warning in the tray for it.
    if (message.includes('No published versions')) {
      log.info('No releases published yet; nothing to update to.');
      setUpdateState('up-to-date');
      return;
    }
    log.error('Auto-update error:', err);
    setUpdateState('error', { message });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Update ${info.version} downloaded and staged.`);
    setUpdateState('downloaded', { version: info.version });

    if (Notification.isSupported()) {
      const banner = new Notification({
        title: `Google Chat ${info.version} is ready`,
        body: 'Click to restart and finish updating, or it will install next time you quit.',
        icon: getResourcePath('icon.ico')
      });
      banner.on('click', installUpdateNow);
      banner.show();
    }
  });

  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
}

function updateMenuLabel() {
  switch (updateState.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return `Downloading ${updateState.version || 'update'}`
        + `${updateState.message ? ` (${updateState.message})` : ''}…`;
    case 'downloaded':
      return `✅ Restart to install ${updateState.version}`;
    case 'up-to-date':
      return 'You’re up to date';
    case 'error':
      return '⚠️ Update check failed — retry';
    case 'dev':
      return 'Updates disabled (dev build)';
    default:
      return 'Check for updates…';
  }
}

// ---------------------------------------------------------------------------
// Alerts manager IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-vips', () => ({
  vips: config.vipSounds,
  keywords: config.keywordSounds,
  sounds: listSounds()
}));

ipcMain.on('save-vips', (event, newVips) => {
  if (!newVips || typeof newVips !== 'object') return;
  config.vipSounds = newVips;
  saveConfig();
  updateTrayMenu();
});

ipcMain.on('save-keywords', (event, newKeywords) => {
  if (!newKeywords || typeof newKeywords !== 'object') return;
  config.keywordSounds = newKeywords;
  saveConfig();
  updateTrayMenu();
});

ipcMain.handle('upload-sound', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select an MP3 Sound File',
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['mp3'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return false;

  try {
    const sourcePath = result.filePaths[0];
    const soundsDir = getUserSoundsDir();
    fs.mkdirSync(soundsDir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(soundsDir, path.basename(sourcePath)));
    updateTrayMenu();
    return true;
  } catch (err) {
    log.error('Sound upload failed:', err);
    dialog.showErrorBox('Upload failed', String(err && err.message ? err.message : err));
    return false;
  }
});

let vipWindow = null;

function openVipManager() {
  if (vipWindow && !vipWindow.isDestroyed()) {
    vipWindow.show();
    vipWindow.focus();
    return;
  }

  vipWindow = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Alert Sounds',
    autoHideMenuBar: true,
    icon: getResourcePath('icon.ico'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  vipWindow.loadFile('vip.html');
  attachContextMenu(vipWindow.webContents);
  vipWindow.on('closed', () => { vipWindow = null; });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function setWidgetMode(enabled) {
  config.widgetMode = enabled;
  config.bounds = null; // the saved size belongs to the other mode
  saveConfig();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.unmaximize();
  mainWindow.setSize(enabled ? 380 : 1200, enabled ? 650 : 800);
  mainWindow.setAlwaysOnTop(config.alwaysOnTop || enabled);
  mainWindow.center();
}

function updateTrayMenu() {
  if (!tray) return;

  const soundOptions = [
    { label: 'Google Default', value: 'default' },
    ...listSounds().map((f) => ({ label: f.replace(/\.mp3$/i, ''), value: f })),
    { label: 'None (Mute All)', value: 'none' }
  ];

  const soundMenuTemplate = soundOptions.map(({ label, value }) => ({
    label,
    type: 'radio',
    checked: config.selectedSound === value,
    click: () => { config.selectedSound = value; saveConfig(); updateTrayMenu(); }
  }));

  const idleMenuTemplate = [
    { label: '1 Minute', value: 60 },
    { label: '5 Minutes', value: 300 },
    { label: '15 Minutes', value: 900 },
    { label: 'Never (Always Active)', value: 0 }
  ].map(({ label, value }) => ({
    label,
    type: 'radio',
    checked: config.idleTimeout === value,
    click: () => { config.idleTimeout = value; saveConfig(); updateTrayMenu(); }
  }));

  const sameLanguages = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const spellCheckTemplate = [
    { label: 'Nederlands + English', value: ['nl', 'en-US'] },
    { label: 'Nederlands only', value: ['nl'] },
    { label: 'English only', value: ['en-US'] },
    { label: 'Off', value: [] }
  ].map(({ label, value }) => ({
    label,
    type: 'radio',
    checked: sameLanguages(config.spellCheckLanguages || [], value),
    click: () => {
      config.spellCheckLanguages = value;
      saveConfig();
      applySpellCheckLanguages();
      updateTrayMenu();
    }
  }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Google Chat', click: showMainWindow },
    { label: 'Reload App', click: () => { reloadAttempt = 0; loadChat(); } },
    { type: 'separator' },
    { label: '🔔 Manage Alert Sounds', click: openVipManager },
    { type: 'separator' },
    {
      label: 'Private Notifications (Hide Text)',
      type: 'checkbox',
      checked: config.privateMode,
      click: (item) => { config.privateMode = item.checked; saveConfig(); }
    },
    {
      label: 'Run at Startup',
      type: 'checkbox',
      checked: config.runAtStartup,
      click: (item) => {
        config.runAtStartup = item.checked;
        saveConfig();
        app.setLoginItemSettings({ openAtLogin: config.runAtStartup, args: ['--hidden'] });
      }
    },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        saveConfig();
        if (mainWindow && !config.widgetMode) mainWindow.setAlwaysOnTop(config.alwaysOnTop);
      }
    },
    {
      label: 'Widget Mode (compact)',
      type: 'checkbox',
      checked: config.widgetMode,
      click: (item) => setWidgetMode(item.checked)
    },
    { type: 'separator' },
    { label: 'Default Notification Sound', submenu: soundMenuTemplate },
    { label: 'Idle Timeout (Away)', submenu: idleMenuTemplate },
    { label: 'Spellcheck', submenu: spellCheckTemplate },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    {
      label: updateMenuLabel(),
      click: () => {
        if (updateState.status === 'downloaded') installUpdateNow();
        else checkForUpdates({ interactive: true });
      }
    },
    {
      label: 'Install Updates Automatically',
      type: 'checkbox',
      checked: config.autoUpdate,
      click: (item) => { config.autoUpdate = item.checked; saveConfig(); }
    },
    {
      label: 'Open Log Folder',
      click: () => shell.openPath(path.dirname(log.transports.file.getFile().path))
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', showMainWindow);
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension');

  createHelperWindow();
  createWindow();

  const trayIcon = nativeImage.createFromPath(getResourcePath('icon.ico'));
  tray = new Tray(trayIcon);
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);

  updateBadgeUI(0);
  updateTrayMenu();
  initAutoUpdater();

  if (migrationWarning) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Previous version still running',
      message: 'Your existing Google Chat sign-in could not be carried over.',
      detail: 'The older Google Chat app is still running and is holding on to its '
        + 'saved session. Quit it from the system tray, then restart this app and '
        + 'your sign-in will be carried across automatically.\n\n'
        + 'You can also just sign in again here — nothing is lost either way.',
      buttons: ['OK']
    }).catch((err) => log.warn('Could not show migration warning:', err));
  }
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process:', err);
});
