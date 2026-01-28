# Reward Playback Runtime (PDR)

This document reframes the spike implementation into a Product Design Review that can guide the Reward Playback Runtime from design through testing and delivery.

## Problem & Goals
- Play a local media clip inside OBS immediately after a Channel Point redeem triggers.
- Let broadcasters manage clips by naming rewards and dropping files into a folder—no code changes required.
- Keep OAuth/refresh token handling safe, automatic, and developer-friendly.
- Recover cleanly from OBS restarts or Twitch EventSub reconnect instructions.

### Non-Goals
- General-purpose OBS automation beyond swapping a single Media Source.
- Managing reward definitions through API calls (broadcaster keeps using the Twitch dashboard).
- Cloud hosting; runtime is intentionally local/edge so it can reach the OBS WebSocket server.

## Requirements
### Functional
- OAuth Authorization Code flow with redirect helper on `http://localhost:<PORT>/callback`.
- Persisted refresh tokens and auto-refresh when <60 seconds remain.
- EventSub WebSocket subscription for `channel.channel_points_custom_reward_redemption.add` scoped to a single broadcaster.
- Reward title parsing with configurable prefix and extension whitelist, resolving to media files in `CLIPS_DIR`.
- OBS WebSocket actions (`SetInputSettings`, `TriggerMediaInputAction`) targeted at `OBS_MEDIA_SOURCE_NAME`.
- Command-line interface with `auth` (launch helper server) and `run` (start listener pipeline).

### Non-Functional
- Cross-platform Node.js 18+ or Bun runtime; zero native addons.
- Handles OBS/Twitch disconnects with retries and jittered backoff.
- Latency from redeem to playback under ~2 seconds given local networking.
- Logging suitable for troubleshooting without extra tooling.

## Constraints & Dependencies
- Twitch Developer application with client id/secret and redirect URI configured (default `http://localhost:3000/callback`).
- OBS 28+ with WebSocket server enabled and password-protected (default port 4455).
- Local filesystem access for `tokens.json` + clip library; runtime must enforce `CLIPS_DIR` sandboxing.
- No requirement for a compiled `.exe`; Node.js/Bun install on the Windows host that runs OBS is sufficient (see "Runtime Packaging").

## Architecture Overview
```
[Broadcaster Browser]
       |
       |  Twitch OAuth grant
       v
[Auth Helper Server] ---> tokens.json
                               |
                               v
[Reward Runtime CLI] <--> Twitch EventSub WebSocket
       |
       | clip path + play command
       v
[OBS Controller] <--> OBS WebSocket <--> OBS Media Source
```

Core components:
1. **OAuth Helper** – express server that exchanges auth codes for tokens and writes them to disk.
2. **Token Manager** – loads tokens, refreshes as needed, rewrites the token file atomically.
3. **EventSub Client** – manages welcome, subscription creation, notification handling, and reconnect instructions.
4. **Clip Resolver** – applies prefix/slug/extension rules to map reward titles to files safely.
5. **OBS Controller** – maintains WebSocket connection, updates source settings, and restarts playback with cooldown protection.

## Detailed Design
### OAuth & Token Storage
- Authorization Code flow with scopes `channel:read:redemptions` (extendable via env var `SCOPES`).
- Helper server prints a link to Twitch OAuth; `/callback` validates `state`, exchanges code for tokens, and stores them in `TOKENS_FILE`.
- Persisted JSON keys: `access_token`, `refresh_token`, `scope`, `token_type`, `expires_at`, `obtained_at`.
- `loadToken()` refreshes automatically when `expires_at - now < 60s`; refresh writes new values but retains old `refresh_token` when Twitch omits it.

### EventSub Flow
1. Connect to `wss://eventsub.wss.twitch.tv/ws`; wait for `session_welcome` and capture `session_id`.
2. POST `eventsub/subscriptions` with `channel.channel_points_custom_reward_redemption.add` and `transport.session_id`.
3. On `notification`, emit event payload to the clip pipeline.
4. On `session_reconnect`, close socket and connect to the provided `reconnect_url`.
5. On unexpected socket close/error, retry with exponential backoff up to e.g. 15 seconds, then reset.

### Clip Pipeline
- Reward titles must start with `TITLE_PREFIX` (default `"Play:"`).
- Remainder of title slugged (lowercase, whitespace to `-`, allow `[a-z0-9-_]`).
- Iterate over `EXTENSIONS` (default `.mp4,.webm,.mov,.mkv`) inside `CLIPS_DIR`.
- Ensure resolved path stays under `CLIPS_DIR` to avoid traversal attacks.
- Missing clip → log warning with guidance. Successful resolution → pass to OBS Controller.
- Cooldown guard (`COOLDOWN_MS`, default 1500) prevents overlapping redeems.

### OBS Control
- Connect via `obs-websocket-js` using `OBS_ADDRESS` (default `ws://127.0.0.1:4455`) and `OBS_PASSWORD`.
- Retry connection when OBS restarts; re-register event handlers.
- `playOnMediaSource(file)`:
    1. `SetInputSettings` with `{ local_file: file }`, `overlay: true` to avoid resetting unrelated settings.
    2. `TriggerMediaInputAction` with `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART`.
- Only one Media Source is in scope for v1. Future versions could allow mapping source per reward via config file.

### Configuration Surface
```
TWITCH_CLIENT_ID (required)
TWITCH_CLIENT_SECRET (required)
BROADCASTER_LOGIN (required)
OBS_PASSWORD (required)
OBS_ADDRESS=ws://127.0.0.1:4455
OBS_MEDIA_SOURCE_NAME=RewardClip
CLIPS_DIR=./clips
OBS_UNMUTE_ON_PLAY=1
OBS_VOLUME_DB=0
TITLE_PREFIX="Play:"
EXTENSIONS=".mp4,.webm,.mov,.mkv"
COOLDOWN_MS=1500
TOKENS_FILE=./config/tokens.json
SCOPES="channel:read:redemptions"
PORT=3000
REDIRECT_URI=http://localhost:3000/callback
```

Values now live in `config/runtime.config.json` (gitignored) so broadcasters edit a single file instead of shell env vars. Use `PDR_CONFIG_PATH=/custom/file.json` to point at alternative configs; traditional env vars still override specific keys for advanced setups. When the bundled executable is launched from Windows, it automatically falls back to `runtime.config.json` in the same directory if `config/runtime.config.json` is absent. `OBS_UNMUTE_ON_PLAY` and `OBS_VOLUME_DB` give a guardrail for ensuring the media source is audible whenever redeems fire.

Configuration is split into two JSON files so only high-level knobs live in source control:
- `config/runtime.config.json` – non-sensitive options (ports, clip directories, OBS source name, cooldown timing, dry-run, etc.).
- `config/secrets.config.json` – secrets and account identifiers (`twitchClientId`, `twitchClientSecret`, `broadcasterLogin`, `obsPassword`, `obsAddress`).

Both files are gitignored and have `.example.json` templates checked in. The runtime loads `config/runtime.config.json` + `config/secrets.config.json`, falls back to `runtime.config.json` + `secrets.config.json` sitting beside the executable, and finally allows overrides via `PDR_CONFIG_PATH` / `PDR_SECRETS_PATH` or classic env vars.

## Implementation Plan
1. **Project bootstrap** – keep single-file script or convert to small package; add `npm` and `bun` scripts for parity.
2. **Config module** – centralize env parsing + validation; throw early when a required variable is absent.
3. **Token manager** – extract helper functions, add CLI command `auth` that launches the express server.
4. **OBS client wrapper** – encapsulate connection lifecycle, add typed errors, support reconnect handlers.
5. **Clip resolver** – finalize slug rules, add tests for tricky titles (spaces, punctuation, unicode).
6. **EventSub client** – convert while-loop into a class with event emitters for welcome, notifications, reconnect.
7. **Runtime CLI** – `run` command wires clients together, manages cooldown state, logs structured messages.
8. **Docs & packaging** – README instructions, sample PowerShell commands, optional script to build standalone binary (see below).

## Testing Strategy
### Automated
- Use Bun test runner or Vitest/Jest (either works) for:
    - Clip resolver slugging + sandbox enforcement.
    - Token manager refresh flow (mock `fetch`).
    - Cooldown logic (fake timers) and config validation.
- EventSub client: spin up a mock `ws` server in tests to emit welcome/notification/reconnect payloads.
- OBS client: inject mocked `OBSWebSocket` implementation to assert `SetInputSettings` and `TriggerMediaInputAction` calls.

### Local Integration (no stream needed)
- **Twitch CLI**: `twitch event trigger channel.channel_points_custom_reward_redemption.add` to send synthetic redeems to the runtime.
- **OBS sandbox scene**: create a spare profile with `RewardClip` media source pointing to sample clips. No live stream required.
- **Dry-run flag**: support `DRY_RUN=1` (or `--no-obs`) to log resolved file paths instead of calling OBS, useful on macOS/Linux laptops away from OBS.
- **Simulate command**: `bun src/cli.ts simulate "Play: tasty"` resolves the clip + exercises OBS playback without Twitch; ideal for quick checks after adding new files.

### Dry-Run Mode
- Set `DRY_RUN=1 bun run start` (or `node script.mjs run --dry-run`) while developing away from OBS/Windows. The runtime still boots OAuth/token refresh, connects to EventSub, resolves clips, and enforces cooldowns, but intercepts the OBS controller so no WebSocket calls are issued.
- Logs show the resolved absolute path for each redeem and whether it would have played or been throttled. Use this to verify reward naming, slugging, and cooldown behavior from WSL/macOS before hopping onto the Windows OBS machine.

### Manual Verification Checklist
1. Launch `bun run auth` (or `node script.mjs auth`), approve OAuth, confirm `tokens.json` created.
2. Start OBS WebSocket (Tools → WebSocket Server Settings) with known port/password.
3. Run `bun run start` / `node script.mjs run`; ensure logs show OBS + EventSub connections.
4. Trigger reward titled `Play: airhorn` via Twitch dashboard or CLI, confirm clip plays.
5. Trigger reward without matching file, confirm warning log.
6. Fire redeems rapidly to confirm cooldown logging.

## Runtime Packaging & Windows Strategy
- **Default**: install Node.js or Bun on the Windows machine that already runs OBS. PowerShell examples:
    - `setx TWITCH_CLIENT_ID "..."` (or use `$env:VAR` per session).
    - `bun install` / `npm install`, then `bun run auth` / `bun run start`.
- **Bun vs. Node**: keep code runtime-agnostic so either `bun` or `node` can execute it; Bun offers faster startup but is optional.
- **Single-file executable**: `bun run build:exe` invokes `bun build src/cli.ts --compile --outfile dist/reward-runtime.exe`. Run that command on Windows to emit a native `.exe`, then copy `dist/reward-runtime.exe`, `runtime.config.json`, `secrets.config.json`, `config/tokens.json` (or whatever `tokensFile` points to), and the `clips/` folder to the streaming PC. The binary will read the co-located config files unless `PDR_CONFIG_PATH` / `PDR_SECRETS_PATH` override the locations.
- **Standalone executable**: Optional but available now; `bun run build:exe` outputs `dist/reward-runtime.exe` so broadcasters can double-click with `runtime.config.json` in the same folder.
- OBS may run on Windows while development happens on macOS/Linux; nothing prevents developing/test-driving in WSL or macOS and then copying the project to Windows for final verification.

## Deployment & Operations
- **Secrets**: store env vars in `.env` (gitignored) or Windows environment variables. Never commit `tokens.json`.
- **Start/stop**: `npm run auth`, `npm run run`, plus equivalent Bun scripts.
- **Failure recovery**: if refresh fails, delete `tokens.json` and re-run `auth`. If OBS restarts, runtime should auto-reconnect, but provide manual "press Ctrl+C and restart" guidance.
- **Logging**: send all logs to stdout; users can redirect to a file (`node script.mjs run | tee runtime.log`).

## Open Risks & Follow-Ups
- Consider encrypting `tokens.json` on disk (DPAPI on Windows) if the broadcaster shares the machine.
- Potential future support for per-reward clip overrides (JSON config) or remote clip storage.
- Observability beyond logging (e.g., desktop notifications) could help during streams; defer for v2.

## Appendix: OBS & Twitch Setup Notes
- Twitch redirect URL must match exactly; if HTTPS is mandatory, run a local tunnel (ngrok/Cloudflare) and update both Twitch console and `REDIRECT_URI`.
- OBS setup: Tools → WebSocket Server Settings → enable, set password, note port. Create Media Source named `RewardClip` (or update env var). Enable "Restart playback when source becomes active".
- Clips folder: default `./clips` relative to the runtime. Reward names follow `Play: <slug>`; e.g., file `airhorn.mp4` maps to reward `Play: airhorn`.
