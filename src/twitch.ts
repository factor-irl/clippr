import { RuntimeConfig } from "./config";

const TWITCH_API_BASE = "https://api.twitch.tv/helix/";

type FetchOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
};

export async function twitchFetch<T>(
  config: RuntimeConfig,
  accessToken: string,
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const url = new URL(path, TWITCH_API_BASE);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "Client-Id": config.twitchClientId,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch API ${res.status}: ${text}`);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return (await res.json()) as T;
}

type UsersResponse = {
  data: Array<{ id: string }>;
};

export async function getBroadcasterUserId(
  config: RuntimeConfig,
  accessToken: string
): Promise<string> {
  const response = await twitchFetch<UsersResponse>(config, accessToken, "users", {
    query: { login: config.broadcasterLogin }
  });

  const user = response.data?.[0];
  if (!user) {
    throw new Error(`No Twitch user found for login ${config.broadcasterLogin}`);
  }
  return user.id;
}

export async function createChannelPointSubscription(
  config: RuntimeConfig,
  accessToken: string,
  sessionId: string,
  broadcasterUserId: string
): Promise<void> {
  await twitchFetch(config, accessToken, "eventsub/subscriptions", {
    method: "POST",
    body: {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: broadcasterUserId },
      transport: { method: "websocket", session_id: sessionId }
    }
  });
}
