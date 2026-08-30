# @openclaw/memory-new

A new memory extension for OpenClaw.

## Installation

```bash
openclaw plugins install @openclaw/memory-new
```

This drops the plugin into `~/.openclaw/npm/projects/yhc3577-memory-new-*/`.
The plugin **does not** auto-enable visualization — that's intentional, since
binding a TCP port (`127.0.0.1:4123`) on boot can surprise users.

## Optional: enable the visualization dashboard

After install, run **once**:

```bash
npx -p @yhc3577/memory-new memory-new-setup
# or, with a profile:
OPENCLAW_PROFILE=test npx -p @yhc3577/memory-new memory-new-setup
```

What it does:
1. Patches `~/.openclaw/openclaw.json` so `plugins.entries.memory_new.config.visualize = {enabled: true, autoStart: true}` is persisted.
2. Backs up the existing config to `openclaw.json.bak` (one-time).
3. Restarts the gateway so the HTTP server binds on the next boot.

The HTTP dashboard then lives at `http://127.0.0.1:4123`. Use
`memory-new-setup --reset` to turn it back off.

> **Why a separate CLI bin instead of an npm postinstall hook or an
> `openclaw` command?**
> - OpenClaw runs `npm install --ignore-scripts` for security, so any
>   `postinstall` in `package.json` is silently skipped during
>   `openclaw plugins install` / `update`.
> - OpenClaw plugin commands (`api.registerCommand`) are dispatched from chat
>   channels, not from the terminal — `openclaw memory_new.foo` never resolves.
>   So the package exposes a standalone `bin` (`memory-new-setup`) that calls
>   the same logic directly from the shell.

## Commands

- `memory_new status` — show plugin status
- `memory_new help` — show help
- `memory_new_visualize start|stop|status` — standalone HTTP dashboard (transient, not persisted; chat channel only)
- `memory-new-setup [--reset] [--no-restart]` — persist or remove `config.visualize` in `openclaw.json` (terminal CLI)
- `memory_new_verify_hooks` — multi-layer E2E hook self-test
- `memory_new_l3_dry_run` — preview what L3 persona would write

## Configuration

`openclaw.json` example:

```json
{
  "plugins": {
    "entries": {
      "memory_new": {
        "enabled": true,
        "config": {
          "layersEnabled": { "L0": true, "L1": true, "L2": true, "L3": false },
          "retrieval": { "hybridSearch": true, "topK": 10 },
          "decay": { "ttl": { "enabled": true, "retentionDays": 30 } },
          "visualize": { "enabled": true, "autoStart": true }
        }
      }
    }
  }
}
```

> Plugin-private fields go under `config` because `PluginEntrySchema` is a
> `strictObject` that only allows top-level `enabled / hooks / subagent / llm / config`.

## Development

```bash
pnpm install
pnpm run build
node scripts/publish.mjs
```

## License

MIT