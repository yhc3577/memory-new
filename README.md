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

## Memory Pipeline (L0 → L1 → L2 → L3)

Memories flow through four layers, distilled bottom-up by the
`DistillationPipeline`. Raw conversation becomes atomic facts, then scenes,
then a long-term persona.

```
                          ┌─────────────────────────────────────────────┐
   conversation           │             DistillationPipeline            │
 ┌────────────┐  session_end   ┌────────────┐       ┌────────────┐       │
 │  L0        │──────────────▶ │  L1        │──────▶│  L2        │       │
 │  raw msgs  │  ingest()      │  atomic    │distill│  scenes    │       │
 │  (JSONL)   │                │  memories  │  L2   │  (Markdown)│       │
 └────────────┘                └────────────┘       └────────────┘       │
                                       │ distill L3  │  (from high-value)│
                                       ▼              ▼                  │
                                   ┌────────────┐                          │
                                   │  L3        │  persona.md (opt-in)     │
                                   │  persona   │                          │
                                   └────────────┘                          │
                          └─────────────────────────────────────────────┘
```

### Layer summary

| Layer | Content | Storage | Trigger |
|-------|---------|---------|---------|
| **L0** | Raw user/assistant messages | `l0/<sessionKey>.jsonl` | `session_end` hook → `pipeline.ingest()` |
| **L1** | Atomic memories (`persona` / `episodic` / `instruction`) | `l1/<sessionKey>.jsonl` | `distill("L1")` on `session_end` + idle timer |
| **L2** | Scene summaries built from L1 | `scenes/<id>.md` + `index.json` | Auto after L1 stored + `session_end` |
| **L3** | Long-term user persona | `persona.md` | `session_end`, **opt-in** (see below) |

### Write path (session_end)

1. **L0 capture** — the `session_end` hook reads the session's messages and
   writes each to L0 via `MemoryStore.ingestMessage()` (truncated to 10k chars).
2. **L1 extraction** — `DistillationPipeline.distill("L1")` batches the last
   `l1.batchSize` (default **10**) buffered messages, splits them into
   `newMessages` (last 5) + background, and asks an LLM (subagent runner, or a
   local fallback extractor when no LLM is configured) to emit atomic memories
   with type + priority + scene name. Results go through `storeL1()`.
3. **L2 distillation** — fires two ways:
   - immediately, via `store.setOnL1Stored()` (any L1 write triggers `distill("L2")`);
   - after `l2.delayAfterL1Seconds` (default **30s**), scheduled at the end of `runL1Distillation`.
   `runL2Distillation()` clusters L1 records into scenes and writes them as
   Markdown.
4. **L3 persona** — runs on `session_end` when enabled. If
   `layersEnabled.L3 === false` (the default) it runs a **dry-run** instead:
   it computes the same report and writes `memory/l3-preview.json` so you can
   inspect what `persona.md` *would* contain before opting in. To enable real
   writes, set `layersEnabled.L3 = true`; a persona is only materialized when
   the average L1 priority passes `l3.importanceThreshold` (default **0.4**).
5. **Decay** — `session_end` also runs `applyDecayToL1()`: TTL expiry,
   Ebbinghaus freshness, and the `draft → active → frozen → forgotten` state
   machine.

> The L1 idle timer (`l1.idleSeconds`, default **30s**) forces extraction even
> if `session_end` never fires (e.g. long-running sessions).

### Storage layout

```
~/.openclaw/memory-new/memory/
├── l0/                # raw messages, one JSONL per sessionKey
├── l1/                # atomic memories, one JSONL per sessionKey
├── scenes/            # L2 scenes (Markdown) + index.json
└── persona.md         # L3 persona
```

## Recall Process

Recall happens **per-turn** in the `before_prompt_build` hook: relevant
memories are injected into the prompt before the model sees it.

```
 before_prompt_build
        │
        ▼
 ┌─────────────────┐    query = event.prompt[0..200]
 │ RecallEngine.   │
 │   recall()      │
 └────────┬────────┘
          │
          ├─▶ 1. L1 search (hybrid or text)
          │        vectorStore.syncFromL1Records(all L1)
          │        vectorStore.hybridSearch({ query, topK, weights })
          │        ── BM25 + semantic + entity boost (weights: 0.5 / 0.3 / 0.2)
          │        fallback: StorageAdapter.searchL1(query) plain text scan
          │
          ├─▶ 2. read L2 scene index (scene navigation)
          ├─▶ 3. read L3 persona
          │
          └─▶ build injected context
                 prependContext      → injected BEFORE the user prompt
                 appendSystemContext → appended to the system prompt
```

### What gets injected

| Block | Where | Content |
|-------|-------|---------|
| `<relevant-memories>` | prependContext (per-turn, dynamic) | Top-K matched L1 memories, `- [type] content` lines |
| `<user-persona>` | appendSystemContext (stable) | L3 persona content |
| `<scene-navigation>` | appendSystemContext (stable) | Scene index as `- [title](memory://scene/<id>): summary` |
| `<memory-tools-guide>` | appendSystemContext | Guides the agent to call `memory_search` / `memory_get` when injected memories aren't enough (max 3 calls/turn) |

```js
// prependContext (before user prompt):
<relevant-memories>
以下是与当前对话相关的记忆：

- [persona] 用户喜欢钻研某个领域/技术
- [episodic] 用户昨天讨论了项目X架构
</relevant-memories>

// appendSystemContext (appended to system prompt):
<user-persona>…</user-persona>

<scene-navigation>
- [User Added](memory://scene/scene_xxx): 5 条记忆, 平均优先级 71
- [System](memory://scene/scene_yyy): 2 条记忆, 平均优先级 75
</scene-navigation>

<memory-tools-guide>…</memory-tools-guide>
```

### Key parameters

| Config | Default | Meaning |
|--------|---------|---------|
| `retrieval.hybridSearch` | `true` | Use BM25+semantic+entity hybrid search |
| `retrieval.semanticWeight` | `0.3` | Semantic score weight |
| `retrieval.bm25Weight` | `0.5` | BM25 score weight |
| `retrieval.entityBoostWeight` | `0.2` | Entity-match boost weight |
| `retrieval.topK` | `10` | Max memories injected per turn |

If `hybridSearch` finds nothing, recall falls back to a plain text scan of L1,
so the hook never depends on a vector backend being available.

## Development

```bash
pnpm install
pnpm run build
node scripts/publish.mjs
```

## License

MIT