import OBSWebSocket from "obs-websocket-js";
import { RuntimeConfig } from "./config";

export interface MediaController {
  init(): Promise<void>;
  playMedia(filePath: string): Promise<void>;
}

class RealObsController implements MediaController {
  private obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(private config: RuntimeConfig) {
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
      console.warn("OBS connection closed. Will retry on next playback.");
    });
  }

  async init() {
    await this.ensureConnected();
  }

  private async ensureConnected() {
    if (this.connected) return;
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectWithRetry();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithRetry() {
    let attempt = 0;
    let lastError: unknown = null;
    while (!this.connected && attempt < 5) {
      attempt += 1;
      try {
        await this.obs.connect(this.config.obsAddress, this.config.obsPassword);
        this.connected = true;
        console.log(`✅ Connected to OBS at ${this.config.obsAddress}`);
        return;
      } catch (error) {
        lastError = error;
        const delayMs = Math.min(2000 * attempt, 5000);
        console.warn(
          `OBS connection attempt ${attempt} failed (${(error as Error)?.message ?? error}). Retrying in ${delayMs}ms...`
        );
        await wait(delayMs);
      }
    }

    if (!this.connected && lastError) {
      throw lastError;
    }
  }

  async playMedia(filePath: string) {
    await this.ensureConnected();

    await this.obs.call("SetInputSettings", {
      inputName: this.config.obsMediaSourceName,
      inputSettings: { local_file: filePath },
      overlay: true
    });

    await this.obs.call("TriggerMediaInputAction", {
      inputName: this.config.obsMediaSourceName,
      mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"
    });

    console.log(`▶ OBS playback triggered for ${filePath}`);
  }
}

class DryRunObsController implements MediaController {
  constructor(private config: RuntimeConfig) {}

  async init() {
    console.log("🧪 Dry-run mode enabled. OBS interactions are skipped.");
  }

  async playMedia(filePath: string) {
    console.log(`[DRY-RUN] Would play ${filePath} on ${this.config.obsMediaSourceName}`);
  }
}

export function createMediaController(config: RuntimeConfig): MediaController {
  if (config.dryRun) {
    return new DryRunObsController(config);
  }
  return new RealObsController(config);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
