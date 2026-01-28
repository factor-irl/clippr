import fs from "node:fs";
import path from "node:path";
import { RuntimeConfig } from "./config";

export function slugFromTitle(title: string, prefix: string): string | null {
  if (!title) return null;
  const normalizedPrefix = prefix.trim().toLowerCase();
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle.startsWith(normalizedPrefix)) return null;

  const remainder = title.slice(prefix.length).trim();
  const slug = remainder
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");

  return slug || null;
}

function isWithinDir(baseDir: string, candidate: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveClipPath(config: RuntimeConfig, rewardTitle: string): string | null {
  const clipsDir = path.resolve(config.clipsDir);
  const slug = slugFromTitle(rewardTitle, config.titlePrefix);
  if (!slug) return null;

  for (const extension of config.extensions) {
    const candidate = path.resolve(clipsDir, `${slug}${extension}`);
    if (!isWithinDir(clipsDir, candidate)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}
