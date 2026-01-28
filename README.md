# Reward Playback Runtime

Local Bun service that listens for Twitch Channel Point redeems and swaps a single OBS Media Source to play clip files on demand. Designed for streamers who want “drop a file in a folder, name the reward, done” without custom bots.

## Features
- OAuth helper (`auth` mode) to grab/refresh Twitch tokens locally.
- EventSub WebSocket client for `channel.channel_points_custom_reward_redemption.add` events.
- Clip resolver maps reward titles (e.g., `Play: tasty`) to files in `clips/` with slug/extension whitelists.
- OBS WebSocket control that updates `local_file`, unmutes, and restarts the configured media source.
- Dry-run/testing mode and a `simulate` command for quick playback.
- Build once (`bun run build:exe`) to ship a single Windows `.exe` + config files.

## Requirements
- Bun for local development.
- Twitch Developer app client ID/secret with redirect `http://localhost:3000/callback`.
- OBS 28+ with WebSocket server enabled + password.
- Local filesystem access for config files, tokens, and `clips/` directory.

## Configuration
Two JSON files (gitignored) supply runtime settings:

1. `config/runtime.config.json` (non-sensitive):
   ```jsonc
   {
     "redirectUri": "http://localhost:3000/callback",
     "port": 3000,
     "tokensFile": "./config/tokens.json",
     "obsAddress": "ws://127.0.0.1:4455",
     "obsMediaSourceName": "RewardClip",
     "clipsDir": "./clips",
     "obsUnmuteOnPlay": true,
     "obsVolumeDb": 0,
     "titlePrefix": "Play:",
     "extensions": [".mp4", ".webm", ".mov", ".mkv"],
     "cooldownMs": 1500,
     "dryRun": false
   }
   ```

2. `config/secrets.config.json` (sensitive, never commit):
   ```json
   {
     "twitchClientId": "YOUR_CLIENT_ID",
     "twitchClientSecret": "YOUR_CLIENT_SECRET",
     "broadcasterLogin": "yourchannel",
     "obsPassword": "yourObsPassword"
   }
   ```

Environment variables can override any field; use `PDR_CONFIG_PATH` / `PDR_SECRETS_PATH` to point to custom files (the executable also falls back to `runtime.config.json` / `secrets.config.json` beside it).

## Development Usage (CLI)

Install dependencies:
```bash
bun install   # or npm install
```

Authorize Twitch and save tokens:
```bash
# launches local auth server with redirect helper
bun src/cli.ts auth
```

Run the runtime:
```bash
# connects to Twitch + OBS
bun src/cli.ts run
```

Simulate a reward without Twitch (manual OBS playback):
```bash
bun src/cli.ts simulate "Play: tasty"
```

`DRY_RUN=1 bun src/cli.ts run` keeps the pipeline running but skips OBS calls—useful when testing away from the streaming PC.

## Building the Windows Executable

On Windows (required for a working `.exe`), run:
```powershell
bun install   # once
bun run build:exe
```

This emits `dist/reward-runtime.exe`. Copy the following to your streaming machine (same folder):
- `reward-runtime.exe`
- `runtime.config.json` (or keep in `config/` and set `PDR_CONFIG_PATH`)
- `secrets.config.json`
- `config/tokens.json`
- `clips/` directory with your media files

Double-clicking the `.exe` defaults to `run` mode (starts OBS if `obsLaunchPath` is set). Use `reward-runtime.exe auth` or `reward-runtime.exe simulate ...` for other commands.


## Troubleshooting
- **No clip audio**: Ensure the OBS media source is unmuted and audio monitoring is set to `Monitor and Output`. The runtime also calls `SetInputMute(false)` and can set `obsVolumeDb` each playback.
- **Token errors**: Delete `config/tokens.json` and rerun `auth` to refresh.
- **EventSub disconnects**: Runtime auto-reconnects with backoff; check logs for Twitch error messages.
- **OBS connection failures**: Verify OBS WebSocket server is enabled, password matches, and the runtime can reach the host/port (set `obsAddress` appropriately when using WSL/remote machines).
