# Motrex Auto Player Test

Electron test app for tray execution, OS login auto launch, and scheduled video playback.

## Run

```bash
npm install
npm start
```

The app automatically registers itself for OS login startup when it runs.
After restarting the PC and logging in, it starts in the background with only the tray icon visible.

## Schedule

Edit `schedule.json`.

- `mode: "interval"` plays every `intervalSeconds`.
- `mode: "daily"` plays once per day at `timeOfDay` in `HH:mm` format.
- `videoUrl` points to the video URL to play.

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
