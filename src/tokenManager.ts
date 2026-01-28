import fs from "node:fs";
import { RuntimeConfig } from "./config";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string[];
  token_type?: string;
};

export type StoredToken = {
  access_token: string;
  refresh_token?: string;
  scope?: string[];
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  obtained_at?: number;
};

export function readStoredToken(filePath: string): StoredToken | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as StoredToken;
  } catch (error) {
    console.error(`Failed to parse token file at ${filePath}:`, error);
    return null;
  }
}

export function writeStoredToken(filePath: string, token: StoredToken) {
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2));
}

export async function exchangeCodeForToken(config: RuntimeConfig, code: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("client_id", config.twitchClientId);
  params.set("client_secret", config.twitchClientSecret);
  params.set("code", code);
  params.set("grant_type", "authorization_code");
  params.set("redirect_uri", config.redirectUri);

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed with status ${res.status}`);
  }

  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(config: RuntimeConfig, refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("client_id", config.twitchClientId);
  params.set("client_secret", config.twitchClientSecret);
  params.set("refresh_token", refreshToken);
  params.set("grant_type", "refresh_token");

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed with status ${res.status}`);
  }

  return (await res.json()) as TokenResponse;
}

export async function loadOrRefreshAccessToken(config: RuntimeConfig): Promise<string> {
  const stored = readStoredToken(config.tokensFile);
  if (!stored?.access_token) {
    throw new Error(`No tokens found at ${config.tokensFile}. Run the auth command first.`);
  }

  const expiresAt = stored.expires_at ?? 0;
  const msRemaining = expiresAt - Date.now();
  const shouldRefresh = !expiresAt || msRemaining < 60_000;

  if (!shouldRefresh) return stored.access_token;

  if (!stored.refresh_token) {
    throw new Error(`Stored access token expired and refresh_token missing. Re-run auth.`);
  }

  console.log("🔄 Refreshing Twitch access token...");
  const refreshed = await refreshAccessToken(config, stored.refresh_token);
  const expires_at = Date.now() + (refreshed.expires_in ?? 0) * 1000;

  const merged: StoredToken = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
    scope: refreshed.scope ?? stored.scope,
    token_type: refreshed.token_type ?? stored.token_type,
    expires_in: refreshed.expires_in ?? stored.expires_in,
    expires_at,
    obtained_at: Date.now()
  };

  writeStoredToken(config.tokensFile, merged);
  console.log("✅ Token refreshed and saved.");
  return merged.access_token;
}
