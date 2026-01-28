import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { RuntimeConfig } from "./config";
import { exchangeCodeForToken, writeStoredToken } from "./tokenManager";

export function startAuthHelper(config: RuntimeConfig) {
  const app = express();
  const state = crypto.randomBytes(16).toString("hex");

  app.get("/", (_req, res) => {
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", config.twitchClientId);
    authUrl.searchParams.set("redirect_uri", config.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", config.scopes.join(" "));
    authUrl.searchParams.set("state", state);

    res.send(`
      <h2>Twitch OAuth</h2>
      <p><a href="${authUrl.toString()}">Authorize on Twitch</a></p>
      <p>Redirect URI: <code>${config.redirectUri}</code></p>
    `);
  });

  app.get("/callback", async (req, res) => {
    try {
      const incomingState = req.query.state;
      if (incomingState !== state) {
        res.status(400).send("Invalid state");
        return;
      }

      const code = req.query.code;
      if (typeof code !== "string") {
        res.status(400).send("Missing code");
        return;
      }

      const token = await exchangeCodeForToken(config, code);
      const expiresAt = Date.now() + (token.expires_in ?? 0) * 1000;
      ensureDir(path.dirname(config.tokensFile));
      writeStoredToken(config.tokensFile, {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        scope: token.scope,
        token_type: token.token_type,
        expires_in: token.expires_in,
        expires_at: expiresAt,
        obtained_at: Date.now()
      });

      console.log(`✅ Tokens saved to ${config.tokensFile}`);
      res.json({ saved_to: config.tokensFile });
    } catch (error) {
      console.error("OAuth callback failed", error);
      res.status(500).send("OAuth callback failed");
    }
  });

  app.listen(config.port, () => {
    console.log(`Auth helper listening on http://localhost:${config.port}`);
    console.log(`Open this URL in your browser to authorize.`);
  });
}

function ensureDir(dir: string) {
  if (!dir || dir === ".") return;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
