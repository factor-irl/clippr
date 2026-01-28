OAuth login + token storage (with redirect URL)

EventSub WebSocket listener for Channel Point redeems

Dynamic mapping from reward title → local file

Triggers OBS Media Source to play that file

It uses Twitch EventSub WebSockets (welcome → get session_id → create subscription) and the OAuth Authorization Code flow + refresh tokens.

1) Twitch app setting: OAuth Redirect URL

In the Twitch Developer Console, set the OAuth Redirect URL to:

http://localhost:3000/callback

Your redirect URL must match exactly what the code uses.

If your console refuses http://localhost and demands HTTPS, that’s a known annoyance some people hit; you’d need an HTTPS localhost setup or a tunnel URL.

2) OBS setup (required)

OBS 28+ → Tools → WebSocket Server Settings

Enable server + set password (default port 4455)

Create a Media Source in your scene named RewardClip (or change env var)

The script will call SetInputSettings and TriggerMediaInputAction on that source.

3) Install dependencies
npm init -y
npm i express ws obs-websocket-js

4) Full code (single file)

Save as twitch-redeem-obs.mjs:

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import WebSocket from "ws";
import OBSWebSocket from "obs-websocket-js";

// --------------------
// CONFIG (env vars)
// --------------------
const PORT = Number(process.env.PORT || 3000);

// Twitch app
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Twitch user/channel to listen for redeems
const BROADCASTER_LOGIN = process.env.BROADCASTER_LOGIN || "";

// Scopes for listening to channel point redemptions
const SCOPES = (process.env.SCOPES || "channel:read:redemptions")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// EventSub WebSocket URL :contentReference[oaicite:5]{index=5}
const EVENTSUB_WSS = "wss://eventsub.wss.twitch.tv/ws";

// Token storage
const TOKENS_FILE = process.env.TOKENS_FILE || path.resolve("./tokens.json");

// OBS
const OBS_ADDRESS = process.env.OBS_ADDRESS || "ws://127.0.0.1:4455";
const OBS_PASSWORD = process.env.OBS_PASSWORD || "";
const OBS_MEDIA_SOURCE_NAME = process.env.OBS_MEDIA_SOURCE_NAME || "RewardClip";

// Dynamic title -> file mapping
// Example reward title: "Play: airhorn" => ./clips/airhorn.mp4
const CLIPS_DIR = process.env.CLIPS_DIR || path.resolve("./clips");
const TITLE_PREFIX = process.env.TITLE_PREFIX || "Play:";
const EXTENSIONS = (process.env.EXTENSIONS || ".mp4,.webm,.mov,.mkv")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

// Anti-spam / overlap behavior
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1500);

// --------------------
// Helpers
// --------------------
function required(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function sanitizeSlug(input) {
  // lowercase, spaces -> -, keep alnum _ -
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

function findClipFileFromTitle(title) {
  if (!title) return null;

  // Require prefix at beginning (case-insensitive)
  if (!title.toLowerCase().startsWith(TITLE_PREFIX.toLowerCase())) return null;

  const raw = title.slice(TITLE_PREFIX.length).trim();
  const slug = sanitizeSlug(raw);
  if (!slug) return null;

  for (const ext of EXTENSIONS) {
    const candidate = path.resolve(CLIPS_DIR, slug + ext);

    // Safety: must stay inside CLIPS_DIR
    if (!candidate.startsWith(CLIPS_DIR + path.sep)) continue;

    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

async function twitchFetch(pathname, { method = "GET", body, params, accessToken } = {}) {
  const url = new URL(`https://api.twitch.tv/helix/${pathname}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    method,
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Twitch API error ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function exchangeCodeForToken(code) {
  // OAuth token endpoint (authorization code grant) :contentReference[oaicite:6]{index=6}
  const url = new URL("https://id.twitch.tv/oauth2/token");
  const form = new URLSearchParams();
  form.set("client_id", TWITCH_CLIENT_ID);
  form.set("client_secret", TWITCH_CLIENT_SECRET);
  form.set("code", code);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", REDIRECT_URI);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${JSON.stringify(json)}`);

  return json; // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshAccessToken(refreshToken) {
  // Refresh flow :contentReference[oaicite:7]{index=7}
  const url = new URL("https://id.twitch.tv/oauth2/token");
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", TWITCH_CLIENT_ID);
  form.set("client_secret", TWITCH_CLIENT_SECRET);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getBroadcasterUserId(accessToken, login) {
  const data = await twitchFetch("users", {
    params: { login },
    accessToken,
  });
  if (!data?.data?.length) throw new Error(`No user found for login: ${login}`);
  return data.data[0].id;
}

// --------------------
// OBS control
// --------------------
async function connectOBS() {
  const obs = new OBSWebSocket();
  await obs.connect(OBS_ADDRESS, OBS_PASSWORD);
  console.log(`✅ Connected to OBS: ${OBS_ADDRESS}`);
  return obs;
}

async function playOnMediaSource(obs, filePath) {
  // Update Media Source settings and restart :contentReference[oaicite:8]{index=8}
  await obs.call("SetInputSettings", {
    inputName: OBS_MEDIA_SOURCE_NAME,
    inputSettings: { local_file: filePath },
    overlay: true,
  });

  await obs.call("TriggerMediaInputAction", {
    inputName: OBS_MEDIA_SOURCE_NAME,
    mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
  });
}

// --------------------
// Token + OAuth server
// --------------------
function startAuthServer() {
  required("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
  required("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);

  const app = express();
  const state = crypto.randomBytes(16).toString("hex");

  app.get("/", (_req, res) => {
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", TWITCH_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES.join(" "));
    authUrl.searchParams.set("state", state);

    res.send(`
      <h2>Twitch OAuth</h2>
      <p>Click to authorize:</p>
      <p><a href="${authUrl.toString()}">Authorize on Twitch</a></p>
      <p>Redirect URI configured as: <code>${REDIRECT_URI}</code></p>
    `);
  });

  app.get("/callback", async (req, res) => {
    try {
      if (req.query.state !== state) {
        res.status(400).send("Invalid state");
        return;
      }
      const code = req.query.code;
      if (!code) {
        res.status(400).send("Missing code");
        return;
      }

      const token = await exchangeCodeForToken(code);

      const expiresAt = Date.now() + Number(token.expires_in || 0) * 1000;

      writeJson(TOKENS_FILE, {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        scope: token.scope,
        token_type: token.token_type,
        expires_in: token.expires_in,
        expires_at: expiresAt,
        obtained_at: Date.now(),
      });

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ saved_to: TOKENS_FILE, ...readJsonIfExists(TOKENS_FILE) }, null, 2));

      console.log("✅ Tokens saved to:", TOKENS_FILE);
    } catch (e) {
      console.error(e);
      res.status(500).send(String(e));
    }
  });

  app.listen(PORT, () => {
    console.log(`Open this in your browser: http://localhost:${PORT}`);
    console.log(`(Make sure your Twitch app Redirect URL includes: ${REDIRECT_URI})`);
  });
}

async function loadOrRefreshToken() {
  required("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
  required("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);

  const t = readJsonIfExists(TOKENS_FILE);
  if (!t?.access_token) {
    throw new Error(`No tokens found. Run: node twitch-redeem-obs.mjs auth (then authorize)`);
  }

  // If expired (or about to), refresh
  const now = Date.now();
  const expiresAt = Number(t.expires_at || 0);
  const shouldRefresh = !expiresAt || expiresAt - now < 60_000;

  if (!shouldRefresh) return t.access_token;

  if (!t.refresh_token) {
    throw new Error(`Token expired and no refresh_token found. Re-auth: node twitch-redeem-obs.mjs auth`);
  }

  console.log("🔄 Refreshing Twitch access token...");
  const refreshed = await refreshAccessToken(t.refresh_token);

  const expiresAtNew = Date.now() + Number(refreshed.expires_in || 0) * 1000;

  writeJson(TOKENS_FILE, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || t.refresh_token,
    scope: refreshed.scope || t.scope,
    token_type: refreshed.token_type || t.token_type,
    expires_in: refreshed.expires_in,
    expires_at: expiresAtNew,
    obtained_at: Date.now(),
  });

  console.log("✅ Token refreshed and saved.");
  return refreshed.access_token;
}

// --------------------
// EventSub WebSocket listener
// --------------------
async function createEventSubSubscription(accessToken, { sessionId, broadcasterUserId }) {
  // WebSocket transport requires session_id from welcome message :contentReference[oaicite:9]{index=9}
  const body = {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId },
    transport: { method: "websocket", session_id: sessionId },
  };

  await twitchFetch("eventsub/subscriptions", {
    method: "POST",
    body,
    accessToken,
  });

  console.log("✅ EventSub subscription created (channel point redeems).");
}

async function runListener() {
  required("BROADCASTER_LOGIN", BROADCASTER_LOGIN);
  required("OBS_PASSWORD", OBS_PASSWORD);

  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const accessToken = await loadOrRefreshToken();
  const broadcasterUserId = await getBroadcasterUserId(accessToken, BROADCASTER_LOGIN);
  console.log("Broadcaster user id:", broadcasterUserId);

  const obs = await connectOBS();

  let wsUrl = EVENTSUB_WSS;
  let onCooldown = false;

  while (true) {
    console.log("Connecting to EventSub WS:", wsUrl);

    const ws = new WebSocket(wsUrl);

    const welcome = await new Promise((resolve, reject) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg?.metadata?.message_type === "session_welcome") resolve(msg);
        } catch {}
      });
      ws.on("error", reject);
      ws.on("close", () => reject(new Error("WebSocket closed before welcome")));
    });

    const sessionId = welcome.payload.session.id;
    console.log("Session ID:", sessionId);

    // Subscribe quickly after welcome (Twitch expects you to create subs promptly). :contentReference[oaicite:10]{index=10}
    await createEventSubSubscription(accessToken, { sessionId, broadcasterUserId });

    // Wait until reconnect or close/error
    const next = await new Promise((resolve) => {
      ws.on("message", async (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        const type = msg?.metadata?.message_type;

        if (type === "session_keepalive") return;

        if (type === "session_reconnect") {
          const newUrl = msg.payload.session.reconnect_url;
          console.log("🔁 Reconnect requested:", newUrl);
          resolve({ url: newUrl });
          ws.close();
          return;
        }

        if (type === "notification") {
          const event = msg?.payload?.event;
          const rewardTitle = event?.reward?.title || "";
          const userName = event?.user_name || "unknown";

          console.log(`🎟 Redeem by ${userName}: "${rewardTitle}"`);

          const clipPath = findClipFileFromTitle(rewardTitle);
          if (!clipPath) {
            console.log(
              `⚠️ No clip found. Expected "${TITLE_PREFIX} <name>" => ${CLIPS_DIR}/<name>.{${EXTENSIONS.join(",")}}`
            );
            return;
          }

          if (onCooldown) {
            console.log("⏳ Cooldown active; ignoring redeem.");
            return;
          }

          onCooldown = true;
          try {
            await playOnMediaSource(obs, clipPath);
            console.log("▶ Playing:", clipPath);
          } catch (e) {
            console.error("❌ OBS play failed:", e);
          } finally {
            setTimeout(() => (onCooldown = false), COOLDOWN_MS);
          }
        }
      });

      ws.on("close", () => resolve({ url: EVENTSUB_WSS }));
      ws.on("error", () => resolve({ url: EVENTSUB_WSS }));
    });

    wsUrl = next.url;
    console.log("Reconnecting in 2s...");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// --------------------
// Entrypoint
// --------------------
const mode = (process.argv[2] || "").toLowerCase();

if (mode === "auth") {
  startAuthServer();
} else if (mode === "run") {
  runListener().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
} else {
  console.log(`
Usage:
  node twitch-redeem-obs.mjs auth   # get tokens (OAuth) using redirect URL ${REDIRECT_URI}
  node twitch-redeem-obs.mjs run    # listen for redeems and trigger OBS

Required env vars:
  TWITCH_CLIENT_ID
  TWITCH_CLIENT_SECRET
  BROADCASTER_LOGIN
  OBS_PASSWORD

Optional:
  OBS_ADDRESS=ws://127.0.0.1:4455
  OBS_MEDIA_SOURCE_NAME=RewardClip
  CLIPS_DIR=./clips
  TITLE_PREFIX="Play:"
  EXTENSIONS=".mp4,.webm,.mov,.mkv"
  COOLDOWN_MS=1500
  PORT=3000
  REDIRECT_URI=http://localhost:3000/callback
`);
}

5) How to run it
Step A — authorize and create tokens.json

Windows PowerShell

$env:TWITCH_CLIENT_ID="xxx"
$env:TWITCH_CLIENT_SECRET="xxx"
$env:BROADCASTER_LOGIN="yourlogin"
$env:OBS_PASSWORD="yourObsWsPassword"
node .\twitch-redeem-obs.mjs auth


Open the printed localhost URL, click Authorize, and it will save tokens.json.

Step B — add clips + create rewards

Put clips in ./clips/ like:

airhorn.mp4

bruh.webm

Create Channel Point rewards titled:

Play: airhorn

Play: bruh

Step C — run the listener
node .\twitch-redeem-obs.mjs run