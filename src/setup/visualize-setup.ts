// Persist visualize config into openclaw.json.
//
// Why this lives here (not as a postinstall npm script):
// openclaw uses `npm install --ignore-scripts` for security, so any
// postinstall hook we wire into package.json is silently skipped during
// `openclaw plugins install|update`. The only safe place to write to
// openclaw.json is *inside* the plugin process — i.e. a command handler
// invoked via the plugin CLI surface (`memory_new.visualize_setup`).
//
// What this writes:
//   plugins.entries.memory_new.config.visualize = { enabled, autoStart }
// (note the `config` nesting: PluginEntrySchema is a strictObject that only
// allows `enabled / hooks / subagent / llm / config`, so plugin-private
// keys MUST live under `config`.)

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

type ApiSurface = {
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
  };
};

type RunVisualizeSetupParams = {
  reset: boolean;
  noRestart: boolean;
  profile: string;
  api: ApiSurface;
};

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJsonAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function profileDirs(profile: string): string[] {
  const home = homedir();
  if (profile) return [join(home, `.openclaw-${profile}`)];
  return [join(home, ".openclaw"), join(home, ".openclaw-test")];
}

function resolveConfigPath(profile: string): string | null {
  for (const dir of profileDirs(profile)) {
    const p = join(dir, "openclaw.json");
    if (existsSync(p)) return p;
  }
  return null;
}

function desiredViz(reset: boolean): { enabled: boolean; autoStart: boolean } | null {
  if (reset) return { enabled: false, autoStart: false };
  return { enabled: true, autoStart: true };
}

function vizMatches(
  current: { enabled?: boolean; autoStart?: boolean } | undefined,
  desired: { enabled: boolean; autoStart: boolean } | null,
): boolean {
  if (desired === null) return true; // both wanted-missing and present-missing → matches
  if (!current) return false;
  return Boolean(current.enabled) === desired.enabled && Boolean(current.autoStart) === desired.autoStart;
}

/**
 * Synchronous best-effort writer used from plugin register().
 *
 * register() must stay synchronous, so we cannot await runVisualizeSetup (and
 * we must NOT spawn a gateway restart from inside register — that would
 * re-enter register in a loop). This writes `config.visualize` directly if it
 * is absent, so a freshly installed plugin automatically enables the
 * dashboard on the FIRST gateway boot, with no manual setup step.
 *
 * Never throws — any failure logs nothing and returns false.
 */
export function ensureVisualizeAutoStartSync(profile: string, opts?: { dryRun?: boolean }): {
  changed: boolean;
  configPath: string | null;
  message: string;
} {
  const configPath = resolveConfigPath(profile);
  if (!configPath) {
    return {
      changed: false,
      configPath: null,
      message: "openclaw.json not found; skipping visualize auto-setup",
    };
  }
  try {
    const cfg = readJson<Record<string, unknown>>(configPath);
    const plugins = (cfg.plugins ?? {}) as Record<string, unknown>;
    const entries = (plugins.entries ?? {}) as Record<string, unknown>;
    const entry = (entries["memory_new"] ?? {}) as Record<string, unknown>;
    const innerConfig = (entry.config ?? {}) as Record<string, unknown>;
    const currentViz = innerConfig.visualize as
      | { enabled?: boolean; autoStart?: boolean }
      | undefined;

    const already = Boolean(currentViz?.enabled) === true && Boolean(currentViz?.autoStart) === true;
    if (already || opts?.dryRun) {
      return {
        changed: false,
        configPath,
        message: already
          ? "visualize already enabled in openclaw.json"
          : "would enable visualize (dry-run)",
      };
    }

    innerConfig.visualize = { enabled: true, autoStart: true };
    entry.config = innerConfig;
    entries["memory_new"] = entry;
    plugins.entries = entries;
    cfg.plugins = plugins;

    // One-time backup, atomic write.
    const backupPath = `${configPath}.bak`;
    if (!existsSync(backupPath)) {
      try {
        copyFileSync(configPath, backupPath);
      } catch {
        /* non-fatal */
      }
    }
    writeJsonAtomic(configPath, cfg);
    return {
      changed: true,
      configPath,
      message: "wrote plugins.entries.memory_new.config.visualize={enabled:true,autoStart:true}",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { changed: false, configPath, message: `auto-setup failed: ${msg}` };
  }
}

export async function runVisualizeSetup(params: RunVisualizeSetupParams): Promise<{ text: string }> {
  const { reset, noRestart, profile, api } = params;
  const log = (m: string) => api.logger?.info?.(`[memory_new] ${m}`);
  const warn = (m: string) => api.logger?.warn?.(`[memory_new] ${m}`);

  const configPath = resolveConfigPath(profile);
  if (!configPath) {
    const hint = profile ? `~/.openclaw-${profile}/openclaw.json` : "~/.openclaw/openclaw.json";
    return {
      text: `openclaw.json not found at ${hint}. Run \`openclaw init\` or \`openclaw --profile <name> init\` first.`,
    };
  }
  log(`config: ${configPath}`);

  let cfg: Record<string, unknown>;
  try {
    cfg = readJson<Record<string, unknown>>(configPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: `failed to parse ${configPath}: ${msg}` };
  }

  const plugins = (cfg.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const entry = (entries["memory_new"] ?? {}) as Record<string, unknown>;
  const innerConfig = (entry.config ?? {}) as Record<string, unknown>;
  const currentViz = innerConfig.visualize as
    | { enabled?: boolean; autoStart?: boolean }
    | undefined;
  const desired = desiredViz(reset);

  if (vizMatches(currentViz, desired)) {
    const label = currentViz ? `enabled=${currentViz.enabled}, autoStart=${currentViz.autoStart}` : "absent";
    log(`already configured (${label}); no change`);
    return { text: `already configured (${label}); no change. Run \`openclaw gateway restart\` to apply if you just updated.` };
  }

  if (reset) {
    delete innerConfig.visualize;
  } else {
    innerConfig.visualize = { enabled: true, autoStart: true };
  }
  entry.config = innerConfig;
  entries["memory_new"] = entry;
  plugins.entries = entries;
  cfg.plugins = plugins;

  // Backup once
  const backupPath = `${configPath}.bak`;
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(configPath, backupPath);
      log(`backup: ${backupPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`backup failed (continuing): ${msg}`);
    }
  }

  try {
    mkdirSync(configPath.replace(/\/[^/]+$/, ""), { recursive: true });
    writeJsonAtomic(configPath, cfg);
    log(`wrote ${configPath}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: `write failed: ${msg}` };
  }

  if (noRestart) {
    return {
      text:
        `config updated: plugins.entries.memory_new.config.visualize = ${JSON.stringify(reset ? "removed" : innerConfig.visualize)}\n` +
        `gateway NOT restarted — run \`openclaw [--profile <name>] gateway restart\` to apply.`,
    };
  }

  const openclawBin = process.env.OPENCLAW_BIN || "openclaw";
  const profileFlag = profile ? ["--profile", profile] : [];
  const cmd = [openclawBin, ...profileFlag, "gateway", "restart"];
  log(`restarting gateway: ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "pipe", encoding: "utf-8" });
  if (r.status !== 0) {
    warn(`gateway restart exited ${r.status}: ${r.stderr?.trim() ?? ""}`);
    return {
      text:
        `config updated, but gateway restart failed (exit ${r.status}).\n` +
        `stderr: ${r.stderr?.trim() || "(empty)"}\n` +
        `Run manually: ${cmd.join(" ")}`,
    };
  }
  return {
    text:
      `config updated: plugins.entries.memory_new.config.visualize = ${JSON.stringify(reset ? "removed" : innerConfig.visualize)}\n` +
      `gateway restarted — visualize will auto-start on every boot from now on.`,
  };
}