import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const CONFIG_PATH_ENV = "PDR_CONFIG_PATH";
const SECRETS_PATH_ENV = "PDR_SECRETS_PATH";

function buildCandidatePaths(explicit: string | undefined, relativePath: string, fallbackFileName: string): string[] {
  if (explicit) {
    return [path.resolve(explicit)];
  }

  const candidates = [path.resolve(relativePath)];
  const exeDir = path.dirname(process.execPath);
  const fallback = path.join(exeDir, fallbackFileName);
  if (!candidates.includes(fallback)) {
    candidates.push(fallback);
  }
  return candidates;
}

function getCandidateConfigPaths(): string[] {
  return buildCandidatePaths(process.env[CONFIG_PATH_ENV], "config/runtime.config.json", "runtime.config.json");
}

function getCandidateSecretsPaths(): string[] {
  return buildCandidatePaths(process.env[SECRETS_PATH_ENV], "config/secrets.config.json", "secrets.config.json");
}

const configSchema = z.object({
  twitchClientId: z.string().min(1, "twitchClientId required"),
  twitchClientSecret: z.string().min(1, "twitchClientSecret required"),
  broadcasterLogin: z.string().min(1, "broadcasterLogin required"),
  redirectUri: z.string().url(),
  port: z.number().int().positive(),
  scopes: z.array(z.string().min(1)).min(1),
  tokensFile: z.string().min(1),
  obsAddress: z.string().min(1),
  obsPassword: z.string().min(1),
  obsMediaSourceName: z.string().min(1),
  clipsDir: z.string().min(1),
  obsUnmuteOnPlay: z.boolean().default(true),
  obsVolumeDb: z.number().optional(),
  titlePrefix: z.string().min(1),
  extensions: z.array(z.string().startsWith(".")),
  cooldownMs: z.number().int().nonnegative(),
  dryRun: z.boolean().default(false)
});

export type RuntimeConfig = z.infer<typeof configSchema> & {
  configPath: string;
  secretsPath: string;
};

const defaultValues: Omit<RuntimeConfig, "configPath" | "secretsPath"> = {
  twitchClientId: "",
  twitchClientSecret: "",
  broadcasterLogin: "",
  redirectUri: "http://localhost:3000/callback",
  port: 3000,
  scopes: ["channel:read:redemptions"],
  tokensFile: path.resolve("./config/tokens.json"),
  obsAddress: "ws://127.0.0.1:4455",
  obsPassword: "",
  obsMediaSourceName: "RewardClip",
  clipsDir: path.resolve("./clips"),
  obsUnmuteOnPlay: true,
  obsVolumeDb: undefined,
  titlePrefix: "Play:",
  extensions: [".mp4", ".webm", ".mov", ".mkv"],
  cooldownMs: 1500,
  dryRun: false
};

type PartialConfig = Partial<Omit<RuntimeConfig, "configPath">>;

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function overlayEnv(base: PartialConfig): PartialConfig {
  const overrides: PartialConfig = {};

  if (process.env.TWITCH_CLIENT_ID) overrides.twitchClientId = process.env.TWITCH_CLIENT_ID;
  if (process.env.TWITCH_CLIENT_SECRET) overrides.twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (process.env.BROADCASTER_LOGIN) overrides.broadcasterLogin = process.env.BROADCASTER_LOGIN;
  if (process.env.REDIRECT_URI) overrides.redirectUri = process.env.REDIRECT_URI;
  if (process.env.PORT) overrides.port = Number(process.env.PORT);
  const scopes = parseList(process.env.SCOPES);
  if (scopes?.length) overrides.scopes = scopes;
  if (process.env.TOKENS_FILE) overrides.tokensFile = path.resolve(process.env.TOKENS_FILE);
  if (process.env.OBS_ADDRESS) overrides.obsAddress = process.env.OBS_ADDRESS;
  if (process.env.OBS_PASSWORD) overrides.obsPassword = process.env.OBS_PASSWORD;
  if (process.env.OBS_MEDIA_SOURCE_NAME) overrides.obsMediaSourceName = process.env.OBS_MEDIA_SOURCE_NAME;
  if (process.env.CLIPS_DIR) overrides.clipsDir = path.resolve(process.env.CLIPS_DIR);
  if (process.env.OBS_UNMUTE_ON_PLAY) overrides.obsUnmuteOnPlay = parseBoolean(process.env.OBS_UNMUTE_ON_PLAY) ?? overrides.obsUnmuteOnPlay;
  if (process.env.OBS_VOLUME_DB) overrides.obsVolumeDb = Number(process.env.OBS_VOLUME_DB);
  if (process.env.TITLE_PREFIX) overrides.titlePrefix = process.env.TITLE_PREFIX;
  const extensions = parseList(process.env.EXTENSIONS);
  if (extensions?.length) overrides.extensions = extensions;
  if (process.env.COOLDOWN_MS) overrides.cooldownMs = Number(process.env.COOLDOWN_MS);
  const dryRun = parseBoolean(process.env.DRY_RUN);
  if (typeof dryRun === "boolean") overrides.dryRun = dryRun;

  return { ...base, ...overrides };
}

function loadFileConfig(configPath: string, examplePath: string, envVar: string): PartialConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing config file at ${configPath}. Copy ${examplePath} next to the executable or set ${envVar}.`
    );
  }

  const contents = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(contents);
  const normalized: PartialConfig = { ...parsed };
  if (parsed.tokensFile) normalized.tokensFile = path.resolve(parsed.tokensFile);
  if (parsed.clipsDir) normalized.clipsDir = path.resolve(parsed.clipsDir);
  return normalized;
}

function resolveConfigPath(): string {
  const candidates = getCandidateConfigPaths();
  const configPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (configPath) return configPath;

  const pretty = candidates.map((c) => `- ${c}`).join("\n");
  throw new Error(
    `Missing config file. Copy config/runtime.config.example.json next to the executable or set ${CONFIG_PATH_ENV}. Tried:\n${pretty}`
  );
}

function resolveSecretsPath(): string {
  const candidates = getCandidateSecretsPaths();
  const secretsPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (secretsPath) return secretsPath;

  const pretty = candidates.map((c) => `- ${c}`).join("\n");
  throw new Error(
    `Missing secrets config file. Copy config/secrets.config.example.json next to the executable and remove .example then set ${SECRETS_PATH_ENV}. Tried:\n${pretty}`
  );
}

export function loadConfig(): RuntimeConfig {
  const configPath = resolveConfigPath();
  const secretsPath = resolveSecretsPath();

  const generalConfig = loadFileConfig(configPath, "config/runtime.config.example.json", CONFIG_PATH_ENV);
  const secretsConfig = loadFileConfig(secretsPath, "config/secrets.config.example.json", SECRETS_PATH_ENV);
  const merged = overlayEnv({ ...defaultValues, ...generalConfig, ...secretsConfig });
  let parsed = configSchema.parse(merged);
  parsed = applyLegacyPathFixes(parsed);
  return { ...parsed, configPath, secretsPath };
}

function applyLegacyPathFixes(config: z.infer<typeof configSchema>): z.infer<typeof configSchema> {
  const legacyTokens = path.resolve("./tokens.json");
  if (config.tokensFile === legacyTokens) {
    return { ...config, tokensFile: path.resolve("./config/tokens.json") };
  }
  return config;
}
