#!/usr/bin/env node
/**
 * Launcher for `memory-new-setup` (the plugin's CLI bin).
 *
 * Used by `npm run viz:setup` for developer convenience. Real config logic
 * lives in src/setup/visualize-setup.ts; this file just spawns the built bin.
 *
 * Usage:
 *   npm run viz:setup                      # enable + restart gateway
 *   npm run viz:setup -- --reset           # turn off + restart
 *   npm run viz:setup -- --no-restart      # patch config only
 *   OPENCLAW_PROFILE=test npm run viz:setup
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, "../dist/cli-bin.js");

const args = process.argv.slice(2);
const profile = process.env.OPENCLAW_PROFILE;
const profileFlag = profile ? ["--profile=" + profile] : [];

console.log(`[memory_new] running: node ${binPath} ${[...profileFlag, ...args].join(" ")}`);
const r = spawnSync(process.execPath, [binPath, ...profileFlag, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
