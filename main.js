const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mqtt = require('mqtt');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_NAME = 'Motrex Auto Player Test';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEDULE_PATH = path.join(__dirname, 'schedule.json');
const TRAY_ICON_PATH = path.join(__dirname, 'tray-icon.png');
const DEFAULT_VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const DEFAULT_PRELOAD_MINUTES = 10;
const DEFAULT_APP_CONFIG = {
  apiBaseUrl: 'http://localhost:3000',
  mqttUrl: 'mqtt://localhost:1883',
  scheduleUpdatedTopic: 'motrex/schedule/updated'
};

app.setName(APP_NAME);

let tray = null;
let playerWindow = null;
let scheduleTimer = null;
let preloadTimer = null;
let downloadInFlight = null;
let mqttClient = null;
let currentScheduleConfig = null;
let mqttStatus = {
  state: 'Disconnected',
  detail: 'MQTT is not connected',
  lastMessageAt: null,
  topic: null
};

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
      intervalSeconds: 30,
      preloadMinutes: DEFAULT_PRELOAD_MINUTES
    };
  }
}

function readAppConfig() {
  try {
    const rawConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
    return {
      ...DEFAULT_APP_CONFIG,
      ...JSON.parse(rawConfig)
    };
  } catch (error) {
    return DEFAULT_APP_CONFIG;
  }
}

function normalizeScheduleConfig(scheduleConfig) {
  return {
    enabled: scheduleConfig?.enabled ?? true,
    videoUrl: scheduleConfig?.videoUrl || DEFAULT_VIDEO_URL,
    mode: scheduleConfig?.mode || 'interval',
    intervalSeconds: scheduleConfig?.intervalSeconds ?? 30,
    preloadMinutes: scheduleConfig?.preloadMinutes ?? DEFAULT_PRELOAD_MINUTES,
    timeOfDay: scheduleConfig?.timeOfDay || '09:00'
  };
}

function getActiveScheduleFromResponse(scheduleResponse) {
  if (Array.isArray(scheduleResponse?.schedules)) {
    return scheduleResponse.schedules.find((schedule) => schedule.enabled) || scheduleResponse.schedules[0];
  }

  return scheduleResponse;
}

function getCurrentScheduleConfig() {
  return currentScheduleConfig || normalizeScheduleConfig(readScheduleConfig());
}

async function fetchScheduleConfigFromServer() {
  const appConfig = readAppConfig();
  const scheduleUrl = new URL('/api/schedules', appConfig.apiBaseUrl).toString();
  const response = await fetch(scheduleUrl);

  if (!response.ok) {
    throw new Error(`Schedule API failed with HTTP ${response.status}`);
  }

  const scheduleResponse = await response.json();
  return normalizeScheduleConfig(getActiveScheduleFromResponse(scheduleResponse));
}

async function refreshScheduleFromServer(reason = 'startup') {
  try {
    currentScheduleConfig = await fetchScheduleConfigFromServer();
    notifyPlayerStatus(`Schedule loaded from server for ${reason}`);
    scheduleNextRun();
    return currentScheduleConfig;
  } catch (error) {
    currentScheduleConfig = normalizeScheduleConfig(readScheduleConfig());
    notifyPlayerStatus(`Schedule API failed. Using local fallback. ${error.message}`);
    scheduleNextRun();
    return currentScheduleConfig;
  }
}

function getVideoCacheDir() {
  return path.join(app.getPath('userData'), 'videos');
}

function getVideoCacheIndexPath() {
  return path.join(app.getPath('userData'), 'video-cache.json');
}

function getVideoFileName(videoUrl) {
  const urlPath = new URL(videoUrl).pathname;
  const extension = path.extname(urlPath) || '.mp4';
  const hash = crypto.createHash('sha256').update(videoUrl).digest('hex').slice(0, 16);
  return `${hash}${extension}`;
}

async function readVideoCache() {
  try {
    const rawCache = await fsp.readFile(getVideoCacheIndexPath(), 'utf8');
    return JSON.parse(rawCache);
  } catch (error) {
    return {};
  }
}

async function writeVideoCache(cache) {
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(getVideoCacheIndexPath(), JSON.stringify(cache, null, 2), 'utf8');
}

function notifyPlayerStatus(status) {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send('video:status', status);
  }
}

function publishMqttStatus(nextStatus) {
  mqttStatus = {
    ...mqttStatus,
    ...nextStatus
  };

  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send('mqtt:status', mqttStatus);
  }

  if (tray) {
    rebuildTrayMenu();
  }
}

function getMqttErrorMessage(error) {
  return error?.message || error?.code || 'MQTT broker is unavailable';
}

async function fileExists(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (error) {
    return false;
  }
}

async function downloadVideo(videoUrl, targetPath) {
  const response = await fetch(videoUrl);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const tempPath = `${targetPath}.download`;
  await fsp.rm(tempPath, { force: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
  await fsp.rename(tempPath, targetPath);
}

async function ensureVideoDownloaded(videoUrl, reason = 'preload') {
  if (downloadInFlight) {
    return downloadInFlight;
  }

  downloadInFlight = (async () => {
    const cacheDir = getVideoCacheDir();
    const fileName = getVideoFileName(videoUrl);
    const filePath = path.join(cacheDir, fileName);
    const cache = await readVideoCache();

    await fsp.mkdir(cacheDir, { recursive: true });

    if (await fileExists(filePath)) {
      return filePath;
    }

    notifyPlayerStatus(`Downloading video for ${reason}...`);
    await downloadVideo(videoUrl, filePath);

    const stats = await fsp.stat(filePath);
    cache[videoUrl] = {
      fileName,
      filePath,
      downloadedAt: new Date().toISOString(),
      size: stats.size
    };
    await writeVideoCache(cache);
    notifyPlayerStatus('Download completed');

    return filePath;
  })();

  try {
    return await downloadInFlight;
  } finally {
    downloadInFlight = null;
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
  const resizedTrayIcon = trayIcon.resize({ width: 16, height: 16 });

  if (process.platform === 'darwin') {
    resizedTrayIcon.setTemplateImage(true);
  }

  return resizedTrayIcon;
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
  playerWindow.webContents.once('did-finish-load', () => {
    playerWindow.webContents.send('mqtt:status', mqttStatus);
  });
  return playerWindow;
}

async function playVideo(reason = 'manual') {
  const scheduleConfig = getCurrentScheduleConfig();
  const targetWindow = createPlayerWindow();
  const sourceVideoUrl = scheduleConfig.videoUrl || DEFAULT_VIDEO_URL;

  let videoUrl = sourceVideoUrl;
  let isLocal = false;

  try {
    const localVideoPath = await ensureVideoDownloaded(sourceVideoUrl, reason);
    videoUrl = pathToFileURL(localVideoPath).toString();
    isLocal = true;
  } catch (error) {
    notifyPlayerStatus(`Download failed. Playing source URL. ${error.message}`);
  }

  const payload = { videoUrl, sourceVideoUrl, reason, isLocal };

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
      label: `MQTT: ${mqttStatus.state}`,
      enabled: false
    },
    {
      label: mqttStatus.lastMessageAt
        ? `Last MQTT: ${new Date(mqttStatus.lastMessageAt).toLocaleTimeString()}`
        : 'Last MQTT: none',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Player',
      click: openPlayer
    },
    {
      label: 'Play Video Now',
      click: () => playVideo('tray')
    },
    {
      label: 'Refresh Schedule',
      click: () => refreshScheduleFromServer('tray')
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

function getNextScheduleDelayMs(scheduleConfig) {
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

  return delayMs;
}

function schedulePreload() {
  clearTimeout(preloadTimer);

  const scheduleConfig = getCurrentScheduleConfig();
  if (!scheduleConfig.enabled) {
    return;
  }

  const videoUrl = scheduleConfig.videoUrl || DEFAULT_VIDEO_URL;
  const preloadMinutes = Number(scheduleConfig.preloadMinutes);
  const preloadMs = Number.isFinite(preloadMinutes) && preloadMinutes > 0
    ? preloadMinutes * 60 * 1000
    : DEFAULT_PRELOAD_MINUTES * 60 * 1000;
  const nextDelayMs = getNextScheduleDelayMs(scheduleConfig);
  const preloadDelayMs = Math.max(0, nextDelayMs - preloadMs);

  preloadTimer = setTimeout(() => {
    ensureVideoDownloaded(videoUrl, 'schedule preload').catch((error) => {
      notifyPlayerStatus(`Preload failed. ${error.message}`);
    });
  }, preloadDelayMs);
}

function scheduleNextRun() {
  clearTimeout(scheduleTimer);
  schedulePreload();

  const scheduleConfig = getCurrentScheduleConfig();
  if (!scheduleConfig.enabled) {
    return;
  }

  const delayMs = getNextScheduleDelayMs(scheduleConfig);

  scheduleTimer = setTimeout(() => {
    playVideo('schedule');
    scheduleNextRun();
  }, delayMs);
}

function showScheduleUpdatedNotification() {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: APP_NAME,
    body: 'Schedule was updated. Refreshing playback schedule.'
  });

  notification.on('click', openPlayer);
  notification.show();
}

function connectMqtt() {
  const appConfig = readAppConfig();
  publishMqttStatus({
    state: 'Connecting',
    detail: `Connecting to ${appConfig.mqttUrl}`,
    topic: appConfig.scheduleUpdatedTopic
  });

  mqttClient = mqtt.connect(appConfig.mqttUrl, {
    reconnectPeriod: 5000
  });

  mqttClient.on('connect', () => {
    publishMqttStatus({
      state: 'Connected',
      detail: `Connected to ${appConfig.mqttUrl}`,
      topic: appConfig.scheduleUpdatedTopic
    });

    mqttClient.subscribe(appConfig.scheduleUpdatedTopic, { qos: 1 }, (error) => {
      if (error) {
        publishMqttStatus({
          state: 'Subscribe failed',
          detail: error.message
        });
        notifyPlayerStatus(`MQTT subscribe failed. ${error.message}`);
        return;
      }

      notifyPlayerStatus(`MQTT connected: ${appConfig.scheduleUpdatedTopic}`);
    });
  });

  mqttClient.on('message', (_topic, message) => {
    publishMqttStatus({
      state: 'Connected',
      detail: 'MQTT message received',
      lastMessageAt: new Date().toISOString()
    });

    let payload = {};

    try {
      payload = JSON.parse(message.toString());
    } catch (error) {
      payload = { type: message.toString() };
    }

    if (payload.type && payload.type !== 'schedule_updated') {
      return;
    }

    showScheduleUpdatedNotification();
    refreshScheduleFromServer('mqtt update');
  });

  mqttClient.on('error', (error) => {
    const errorMessage = getMqttErrorMessage(error);

    publishMqttStatus({
      state: 'Error',
      detail: errorMessage
    });
    notifyPlayerStatus(`MQTT error. ${errorMessage}`);
  });

  mqttClient.on('reconnect', () => {
    publishMqttStatus({
      state: 'Reconnecting',
      detail: `Reconnecting to ${appConfig.mqttUrl}`
    });
  });

  mqttClient.on('offline', () => {
    publishMqttStatus({
      state: 'Offline',
      detail: 'MQTT client is offline'
    });
  });

  mqttClient.on('close', () => {
    publishMqttStatus({
      state: 'Disconnected',
      detail: 'MQTT connection closed'
    });
  });
}

app.whenReady().then(() => {
  ensureAutoLaunchRegistered();
  createTray();
  createPlayerWindow();
  connectMqtt();
  refreshScheduleFromServer('startup');

  app.on('activate', openPlayer);
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuiting = true;
  clearTimeout(scheduleTimer);
  clearTimeout(preloadTimer);

  if (mqttClient) {
    mqttClient.end(true);
  }
});
