# Motrex Auto Player Test

Electron test app for tray execution, OS login auto launch, and scheduled video playback.

## Run

```bash
npm install
npm run server
npm start
```

The app automatically registers itself for OS login startup when it runs.
After restarting the PC and logging in, it starts in the background with only the tray icon visible.

## Build

Windows installer:

```bash
npm run dist
```

macOS DMG/ZIP:

```bash
npm run dist:mac
```

Build the macOS package on macOS. Code signing and notarization are required for distribution outside local testing.

## Schedule

The app loads schedules from the API server on startup:

```text
GET http://localhost:3000/api/schedules
```

Edit `server/schedules.json` for server-provided schedules. `schedule.json` remains as a local fallback if the API is unavailable.

- `mode: "interval"` plays every `intervalSeconds`.
- `mode: "daily"` plays once per day at `timeOfDay` in `HH:mm` format.
- `videoUrl` points to the video URL to play.
- `preloadMinutes` downloads the video before the scheduled playback time.

Downloaded videos are cached under Electron's `userData` directory:

```text
%APPDATA%\Motrex Auto Player Test\videos
```

The app records download metadata in `video-cache.json` in the same `userData` directory.

## MQTT Schedule Updates

Default MQTT settings are in `config.json`:

```json
{
  "apiBaseUrl": "http://localhost:3000",
  "mqttUrl": "mqtt://localhost:1883",
  "scheduleUpdatedTopic": "motrex/schedule/updated"
}
```

When the app receives a `schedule_updated` message on the configured topic, it shows a desktop notification and reloads schedules from the API.

Test publish through the local server:

```bash
curl -X POST http://localhost:3000/api/schedules/notify-update ^
  -H "Content-Type: application/json" ^
  -d "{\"source\":\"manual-test\"}"
```

This requires an MQTT broker such as Mosquitto running on `mqtt://localhost:1883`.

## Tray Menu

- `Open Player`: show the player window.
- `Play Video Now`: play the configured video immediately.
- `Enable Auto Launch` / `Disable Auto Launch`: toggle login startup.
- `Open Schedule File`: open `schedule.json`.
- `Quit`: exit the background app.

## Auto Launch Test

1. Run `npm start` once.
2. Confirm the tray icon appears.
3. Restart the PC or log out and log in again.
4. Confirm the app starts in the background and the tray icon appears.

Use the tray menu to disable auto launch when testing is finished.
