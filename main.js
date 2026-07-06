const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'Motrex Auto Player Test';
const SCHEDULE_PATH = path.join(__dirname, 'schedule.json');
const TRAY_ICON_PATH = path.join(__dirname, 'tray-icon.png');
const DEFAULT_VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

app.setName(APP_NAME);

let tray = null;
let playerWindow = null;
let scheduleTimer = null;

function getAutoLaunchSettings(enabled = true) {
  if (app.isPackaged) {
    return {
      openAtLogin: enabled,
      name: APP_NAME,
      path: process.execPath
    };
  }

  return {
    openAtLogin: enabled,
    name: APP_NAME,
    path: process.execPath,
    args: [app.getAppPath()]
  };
}

function readScheduleConfig() {
  try {
    const rawConfig = fs.readFileSync(SCHEDULE_PATH, 'utf8');
    return JSON.parse(rawConfig);
  } catch (error) {
    return {
      enabled: true,
      videoUrl: DEFAULT_VIDEO_URL,
      mode: 'interval',
      intervalSeconds: 30
    };
  }
}

function getAutoLaunchEnabled() {
  return app.getLoginItemSettings(getAutoLaunchSettings(true)).openAtLogin;
}

function setAutoLaunchEnabled(enabled) {
  app.setLoginItemSettings(getAutoLaunchSettings(enabled));
}

function ensureAutoLaunchRegistered() {
  if (getAutoLaunchEnabled()) {
    return;
  }

  setAutoLaunchEnabled(true);
}

function createTrayIcon() {
  const trayIcon = nativeImage.createFromPath(TRAY_ICON_PATH);
  return trayIcon.resize({ width: 16, height: 16 });
}

function createPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    return playerWindow;
  }

  playerWindow = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  playerWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      playerWindow.hide();
    }
  });

  playerWindow.loadFile(path.join(__dirname, 'player.html'));
  return playerWindow;
}

function playVideo(reason = 'manual') {
  const scheduleConfig = readScheduleConfig();
  const targetWindow = createPlayerWindow();
  const videoUrl = scheduleConfig.videoUrl || DEFAULT_VIDEO_URL;
  const payload = { videoUrl, reason };

  if (targetWindow.webContents.isLoading()) {
    targetWindow.webContents.once('did-finish-load', () => {
      targetWindow.webContents.send('video:play', payload);
    });
  } else {
    targetWindow.webContents.send('video:play', payload);
  }

  targetWindow.show();
  targetWindow.focus();
}

function openPlayer() {
  const targetWindow = createPlayerWindow();
  targetWindow.show();
  targetWindow.focus();
}

function rebuildTrayMenu() {
  const autoLaunchEnabled = getAutoLaunchEnabled();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Player',
      click: openPlayer
    },
    {
      label: 'Play Video Now',
      click: () => playVideo('tray')
    },
    {
      label: autoLaunchEnabled ? 'Disable Auto Launch' : 'Enable Auto Launch',
      click: () => {
        setAutoLaunchEnabled(!autoLaunchEnabled);
        rebuildTrayMenu();
      }
    },
    {
      label: 'Open Schedule File',
      click: () => shell.openPath(SCHEDULE_PATH)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', openPlayer);
  rebuildTrayMenu();
}

function millisecondsUntilTimeOfDay(timeOfDay) {
  const [hour, minute] = String(timeOfDay).split(':').map(Number);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}

function scheduleNextRun() {
  clearTimeout(scheduleTimer);

  const scheduleConfig = readScheduleConfig();
  if (!scheduleConfig.enabled) {
    return;
  }

  let delayMs = 30 * 1000;

  if (scheduleConfig.mode === 'daily') {
    delayMs = millisecondsUntilTimeOfDay(scheduleConfig.timeOfDay) || delayMs;
  }

  if (scheduleConfig.mode === 'interval') {
    const intervalSeconds = Number(scheduleConfig.intervalSeconds);
    delayMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds * 1000
      : delayMs;
  }

  scheduleTimer = setTimeout(() => {
    playVideo('schedule');
    scheduleNextRun();
  }, delayMs);
}

app.whenReady().then(() => {
  ensureAutoLaunchRegistered();
  createTray();
  createPlayerWindow();
  scheduleNextRun();

  app.on('activate', openPlayer);
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuiting = true;
  clearTimeout(scheduleTimer);
});
