#!/usr/bin/env node
/**
 * Standalone CLI binary for memory-new setup.
 *
 * Exposed via package.json `bin` so users can run:
 *   npx -p @yhc3577/memory-new memory-new-setup                # enable + restart gateway
 *   npx -p @yhc3577/memory-new memory-new-setup --reset        # turn off + restart
 *   npx -p @yhc3577/memory-new memory-new-setup --no-restart   # patch config only
 *
 * Why a separate bin and not an `openclaw` plugin command:
 * openclaw plugin commands (api.registerCommand) are dispatched from chat
 * channels (Telegram, Discord, etc.) — NOT from the terminal CLI. The only
 * way to invoke plugin logic from a shell is via a separate Node entry point,
 * which `bin` provides. This binary imports `runVisualizeSetup` from the
 * published dist and calls it directly.
 */
import { runVisualizeSetup } from "./setup/visualize-setup.js";

const args = process.argv.slice(2);
const RESET = args.includes("--reset");
const NO_RESTART = args.includes("--no-restart");
const PROFILE =
  args.find((a) => a.startsWith("--profile="))?.slice("--profile=".length) ??
  process.env.OPENCLAW_PROFILE ??
  "";

const result = await runVisualizeSetup({
  reset: RESET,
  noRestart: NO_RESTART,
  profile: PROFILE,
  api: {
    logger: {
      info: (m) => console.log(m),
      warn: (m) => console.warn(`⚠ ${m}`),
      error: (m) => console.error(`✗ ${m}`),
    },
  },
});

console.log(result.text);
process.exit(result.text.startsWith("failed") || result.text.startsWith("openclaw.json not found") ? 1 : 0);