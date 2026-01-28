import fs from "node:fs";
import WebSocket from "ws";
import { RuntimeConfig } from "./config";
import { createMediaController } from "./obsController";
import { resolveClipPath } from "./clipResolver";
import { createChannelPointSubscription, getBroadcasterUserId } from "./twitch";
import { loadOrRefreshAccessToken } from "./tokenManager";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";

type EventSubMessage = {
  metadata?: { message_type?: string };
  payload?: any;
};

export async function runRuntime(config: RuntimeConfig) {
  ensureClipsDir(config);
  const controller = createMediaController(config);
  try {
    await controller.init();
  } catch (error) {
    console.warn("⚠️ Initial OBS connection failed; will retry when redeems arrive.", error);
  }

  const accessToken = await loadOrRefreshAccessToken(config);
  const broadcasterUserId = await getBroadcasterUserId(config, accessToken);
  console.log(`Broadcaster user id: ${broadcasterUserId}`);

  let wsUrl = EVENTSUB_URL;
  let cooldownActive = false;

  while (true) {
    console.log(`Connecting to Twitch EventSub: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    const sessionId = await waitForWelcome(ws);
    await createChannelPointSubscription(config, accessToken, sessionId, broadcasterUserId);
    console.log("✅ EventSub subscription active");

    const nextUrl = await new Promise<string>((resolve) => {
      ws.on("message", async (payload: WebSocket.RawData) => {
        let message: EventSubMessage;
        try {
          message = JSON.parse(payload.toString());
        } catch {
          return;
        }

        const type = message.metadata?.message_type;
        if (type === "session_keepalive") return;

        if (type === "session_reconnect") {
          const reconnectUrl = message.payload?.session?.reconnect_url || EVENTSUB_URL;
          console.log(`🔁 Twitch requested reconnect to ${reconnectUrl}`);
          resolve(reconnectUrl);
          ws.close();
          return;
        }

        if (type === "notification") {
          const event = message.payload?.event;
          const rewardTitle: string = event?.reward?.title ?? "";
          const userName: string = event?.user_name ?? "unknown";
          console.log(`🎟 Redeem by ${userName}: "${rewardTitle}"`);

          const clipPath = resolveClipPath(config, rewardTitle);
          if (!clipPath) {
            console.warn(
              `⚠️ No clip found. Expected "${config.titlePrefix} <name>" => ${config.clipsDir}/<name>.{${config.extensions.join(", ")}}`
            );
            return;
          }

          if (cooldownActive) {
            console.log("⏳ Cooldown active; skipping playback.");
            return;
          }

          cooldownActive = true;
          setTimeout(() => {
            cooldownActive = false;
          }, config.cooldownMs);

          try {
            await controller.playMedia(clipPath);
          } catch (error) {
            console.error("❌ Failed to trigger OBS: ", error);
          }
        }
      });

      ws.on("close", () => resolve(EVENTSUB_URL));
      ws.on("error", (err) => {
        console.error("EventSub socket error", err);
        resolve(EVENTSUB_URL);
      });
    });

    wsUrl = nextUrl;
    console.log("Reconnecting to EventSub in 2 seconds...");
    await delay(2000);
  }
}

function ensureClipsDir(config: RuntimeConfig) {
  if (!fs.existsSync(config.clipsDir)) {
    fs.mkdirSync(config.clipsDir, { recursive: true });
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWelcome(ws: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const onMessage = (payload: WebSocket.RawData) => {
      try {
        const parsed: EventSubMessage = JSON.parse(payload.toString());
        if (parsed.metadata?.message_type === "session_welcome") {
          ws.off("message", onMessage);
          const sessionId = parsed.payload?.session?.id;
          if (!sessionId) {
            reject(new Error("Welcome message missing session id"));
            return;
          }
          resolve(sessionId);
        }
      } catch {
        // ignore
      }
    };

    ws.on("message", onMessage);
    ws.on("error", (err) => reject(err));
    ws.on("close", () => reject(new Error("WebSocket closed before welcome")));
  });
}
