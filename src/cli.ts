#!/usr/bin/env bun
import { loadConfig } from "./config";
import { startAuthHelper } from "./oauthHelper";
import { runRuntime } from "./runtime";
import { resolveClipPath } from "./clipResolver";
import { createMediaController } from "./obsController";

async function main() {
  const command = (process.argv[2] || "").toLowerCase();
  if (!command || !["auth", "run", "simulate"].includes(command)) {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  const config = loadConfig();
  console.log(`Loaded config from ${config.configPath}`);

  if (command === "auth") {
    startAuthHelper(config);
    return;
  }

  if (command === "run") {
    try {
      await runRuntime(config);
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    }
  }

  if (command === "simulate") {
    const rewardTitle = process.argv[3];
    if (!rewardTitle) {
      console.error("Missing reward title. Example: bun src/cli.ts simulate 'Play: tasty'");
      process.exit(1);
    }

    const clipPath = resolveClipPath(config, rewardTitle);
    if (!clipPath) {
      console.error(
        `No clip found for "${rewardTitle}". Expected file under ${config.clipsDir} matching extensions ${config.extensions.join(", ")}`
      );
      process.exit(1);
    }

    const controller = createMediaController(config);
    await controller.init();
    await controller.playMedia(clipPath);
    console.log(`Simulated reward playback for "${rewardTitle}" using ${clipPath}`);
  }
}

function printUsage() {
  console.log(`
Reward Playback Runtime CLI
Usage:
  bun src/cli.ts auth   # Launch OAuth helper
  bun src/cli.ts run    # Start Twitch listener -> OBS
  bun src/cli.ts simulate "Play: tasty"  # Trigger playback for testing

Environment overrides:
  PDR_CONFIG_PATH=custom.json bun src/cli.ts run
`);
}

main();
