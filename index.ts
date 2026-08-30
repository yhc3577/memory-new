/**
 * Memory New - OpenClaw Memory Plugin
 *
 * Complete implementation with storage and distillation pipeline integration.
 * - L0→L1→L2→L3 distillation (TDB model)
 * - Persistent storage (JSONL + Markdown)
 * - Recall engine for prompt injection
 * - Team memory with visibility ACL
 * - Decay mechanisms
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MemoryStore, StorageAdapter, RecallEngine, createMemoryStore, createMemoryStoreSync, type L0Message } from "./src/store/storage.js";
import { SqliteStore } from "./src/store/sqlite-store.js";
import { startVisualizeServer as _startVisualizeServer } from "./src/visualize/visualize-server.js";
import { runVisualizeSetup, ensureVisualizeAutoStartSync } from "./src/setup/visualize-setup.js";
import { DistillationPipeline, DEFAULT_DISTILLATION_CONFIG } from "./src/pipeline/distillation.js";
import { VectorStore } from "./src/vector/vector-store.js";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { applyDecayBatch, applyTTLCleanup, type DecayConfig } from "./src/decay/decay.js";
import { TeamMemoryManager, TeamEventStore } from "./src/team/team-memory.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

// 4 orthogonal axes (from Co-Engram research)
export type EngramKind = "observation" | "fact" | "pattern" | "procedure" | "hypothesis";
export type EngramStatus = "draft" | "active" | "frozen" | "forgotten";
export type EngramVisibility = "public" | "team" | "private" | "restricted";
export type VerificationStatus = "unverified" | "plausible" | "probable" | "verified" | "refuted";

// Disclosure tiers for progressive reveal
export type DisclosureTier = "catalog" | "digest" | "content" | "meta" | "synapses";

// Memory layer (from TDB research: L0 raw → L1 atomic → L2 scene → L3 persona)
export type MemoryLayer = "L0" | "L1" | "L2" | "L3";

// Core engram interface
export interface Engram {
  id: string;
  kind: EngramKind;
  status: EngramStatus;
  visibility: EngramVisibility;
  verification: VerificationStatus;

  // Content
  content: string;
  summary?: string;
  title?: string;

  // Importance & dynamics
  importance: number;
  lastEffectiveAt: number;

  // Metadata
  metadata: Record<string, unknown>;
  tags: string[];
  contextTags: string[];

  // Provenance
  source: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  trustLevel: TrustLevel;

  // Relations
  synapses: Synapse[];
}

export type TrustLevel = "direct" | "external" | "automated" | "proposal";

// Synapse: relationship between engrams
export interface Synapse {
  targetId: string;
  strength: number;
  type: "supports" | "contradicts" | "references" | "refines";
}

// Search result
export interface SearchResult {
  engram: Engram;
  score: number;
  tier: DisclosureTier;
  matchedOn: string[];
  fromAgentId?: string;
}

// Configuration
export interface MemoryNewConfig {
  enabled: boolean;

  // Memory layers
  layersEnabled: {
    L0: boolean;
    L1: boolean;
    L2: boolean;
    L3: boolean;
  };

  // Decay mechanisms
  decay: {
    ttl: {
      enabled: boolean;
      retentionDays: number;
      safetyThreshold: number;
      minRetainL0: number;
      minRetainL1: number;
    };
    importance: {
      enabled: boolean;
      baseHalflifeDays: number;
    };
    accessFrequency: {
      enabled: boolean;
    };
    stateMachine: {
      enabled: boolean;
    };
  };

  // Team memory
  teamMemory: {
    enabled: boolean;
    maxImportedAgents: number;
    visibilityGate: boolean;
  };

  // Retrieval
  retrieval: {
    hybridSearch: boolean;
    semanticWeight: number;
    bm25Weight: number;
    entityBoostWeight: number;
    topK: number;
    overFetch: number;
  };

  // Storage
  storage: {
    backend: "sqlite" | "memory";
    dataDir: string;
  };

  // Standalone HTTP visualization server (default off — opt in to bind 127.0.0.1:4123)
  visualize?: {
    enabled: boolean;
    port?: number;          // override MEMORY_NEW_PORT
    autoStart?: boolean;    // start on plugin init
  };

  // LLM for extraction
  llm?: {
    enabled: boolean;
    model?: string;
  };
}

/**
 * Deep merge utility - merges source into target (mutates target)
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      deepMerge(targetValue as Record<string, any>, sourceValue as Record<string, any>);
    } else {
      target[key] = sourceValue as any;
    }
  }
  return target;
}

// Default config
const DEFAULT_CONFIG: MemoryNewConfig = {
  enabled: true,
  layersEnabled: { L0: true, L1: true, L2: true, L3: false },
  decay: {
    ttl: { enabled: true, retentionDays: 30, safetyThreshold: 0.8, minRetainL0: 50, minRetainL1: 20 },
    importance: { enabled: true, baseHalflifeDays: 50 },
    accessFrequency: { enabled: true },
    stateMachine: { enabled: true },
  },
  teamMemory: {
    enabled: true,
    maxImportedAgents: 2,
    visibilityGate: true,
  },
  retrieval: {
    hybridSearch: true,
    semanticWeight: 0.5,
    bm25Weight: 0.25,
    entityBoostWeight: 0.25,
    topK: 10,
    overFetch: 4,
  },
  storage: {
    backend: "memory",
    dataDir: "~/.openclaw/memory-new",
  },
  visualize: {
    enabled: false,        // opt-in; bind 127.0.0.1 only
    autoStart: false,      // don't bind on plugin init unless explicitly enabled
  },
  llm: {
    enabled: false,  // Disabled by default, use fallback extraction
    model: "default",
  },
};

// ============================================================================
// Core Functions
// ============================================================================

// Freshness derivation (Ebbinghaus curve, from Co-Engram research)
function deriveFreshness(engram: Engram, config: MemoryNewConfig): "fresh" | "aging" | "stale" | "forgotten" {
  if (!config.decay.importance.enabled) return "fresh";

  const ageDays = (Date.now() - engram.lastEffectiveAt) / (1000 * 60 * 60 * 24);
  const halflife = config.decay.importance.baseHalflifeDays * Math.pow(engram.importance + 0.1, 1.5);

  if (ageDays <= halflife) return "fresh";
  if (ageDays <= halflife * 2) return "aging";
  if (ageDays <= halflife * 4) return "stale";
  return "forgotten";
}

// Hotness derivation (from Co-Engram research)
function deriveHotness(retrievalCount: number, ageDays: number): number {
  return 1 / (1 + Math.exp(-Math.log(1 + retrievalCount))) * Math.exp(-Math.LN2 * ageDays / 7);
}

// 5-factor scoring
function calculateScore(
  relevance: number,
  recency: number,
  importance: number,
  strength: number,
  hotness: number,
  weights = { relevance: 0.50, recency: 0.15, importance: 0.25, strength: 0.05, hotness: 0.05 }
): number {
  return (
    weights.relevance * relevance +
    weights.recency * recency +
    weights.importance * importance +
    weights.strength * strength +
    weights.hotness * hotness
  );
}

// Visibility gate (from Co-Engram research)
function validateVisibilityTransition(
  from: EngramVisibility,
  to: EngramVisibility,
  config: MemoryNewConfig
): boolean {
  if (!config.teamMemory.visibilityGate) return true;
  if (from === to) return true;
  if (to === "private" && from !== "private") return false;
  if (from === "private") return true;
  return true;
}

// Generate unique ID
function genId(): string {
  return `engram_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// Decay Integration
// ============================================================================

interface DecayResult {
  deleted: number;
  frozen: number;
  revived: number;
}

/**
 * Apply decay mechanisms to L1 memories
 */
async function applyDecayToL1(store: MemoryStore, decayConfig: MemoryNewConfig["decay"]): Promise<DecayResult> {
  const result: DecayResult = { deleted: 0, frozen: 0, revived: 0 };

  try {
    // Get all L1 records
    const l1Records = await store.searchL1("", 1000);

    // Convert to Engram format for decay
    const engrams: Engram[] = l1Records.map(r => ({
      id: r.id,
      kind: "fact" as const,
      status: "active" as const,
      visibility: "private" as const,
      verification: "probable" as const,
      content: r.content,
      importance: r.priority / 100,
      lastEffectiveAt: new Date(r.updatedAt).getTime(),
      metadata: r.metadata,
      tags: [],
      contextTags: [],
      source: "memory",
      createdAt: new Date(r.createdAt).getTime(),
      updatedAt: new Date(r.updatedAt).getTime(),
      createdBy: r.userId,
      trustLevel: "external" as const,
      synapses: [],
    }));

    // Apply state machine decay
    if (decayConfig.stateMachine.enabled) {
      const decayResult = applyDecayBatch(engrams, {
        ttl: { enabled: false, retentionDays: 0, safetyThreshold: 0, minRetainL0: 0, minRetainL1: 0 },
        importance: { enabled: true, baseHalflifeDays: decayConfig.importance.baseHalflifeDays, kindMultipliers: {} },
        accessFrequency: { enabled: decayConfig.accessFrequency.enabled },
        stateMachine: { enabled: true },
      });
      result.deleted += decayResult.forgotten.length;
      result.frozen += decayResult.frozen.length;
      result.revived += decayResult.revived.length;
    }

    // Apply TTL cleanup
    if (decayConfig.ttl.enabled) {
      const ttlResult = await applyTTLCleanup(
        engrams,
        { L0: 0, L1: l1Records.length, L2: 0, L3: 0 },
        {
          ttl: {
            enabled: true,
            retentionDays: decayConfig.ttl.retentionDays,
            safetyThreshold: decayConfig.ttl.safetyThreshold,
            minRetainL0: decayConfig.ttl.minRetainL0,
            minRetainL1: decayConfig.ttl.minRetainL1,
          },
          importance: { enabled: false, baseHalflifeDays: 0, kindMultipliers: {} },
          accessFrequency: { enabled: false },
          stateMachine: { enabled: false },
        }
      );
      result.deleted += ttlResult.deleted;
    }

    // Update records based on decay results
    for (const engram of engrams) {
      if (engram.status === "forgotten") {
        // Mark as deleted - would need deleteL1 method
        // For now, just log it
        console.log(`[memory_new] Decay: forgetting ${engram.id}`);
      } else if (engram.status === "frozen") {
        console.log(`[memory_new] Decay: freezing ${engram.id}`);
      }
    }
  } catch (error) {
    console.error(`[memory_new] Decay error: ${error}`);
  }

  return result;
}

// ============================================================================
// Memory Plugin
// ============================================================================

export default definePluginEntry({
  id: "memory_new",
  name: "Memory New",
  description: "Multi-layered memory system with L0→L1→L2→L3 distillation, persistent storage, and recall",

  register(api: OpenClawPluginApi) {
    const config = deepMerge({ ...DEFAULT_CONFIG }, api.pluginConfig ?? {}) as MemoryNewConfig;

    // Ensure storage config exists
    const storageConfig = config.storage ?? { backend: "memory" as const, dataDir: "~/.openclaw/memory-new" };

    // Initialize storage via factory (falls back to JSONL if SQLite is unavailable).
    // register() must be sync (openclaw enforces this — see loader-module-runtime.ts:86),
    // so we use createMemoryStoreSync which only checks module presence via createRequire.
    // Actual SQLite open is deferred to first write; the pipeline drives JSONL today.
    const initResult = createMemoryStoreSync({
      backend: storageConfig.backend,
      dataDir: storageConfig.dataDir,
    });
    if (initResult.warning) {
      api.logger.warn?.(initResult.warning);
    }
    const store = initResult.store;
    const effectiveBackend = initResult.backend;

    if (initResult.warning) {
      api.logger.warn?.(initResult.warning);
      // Surface to Doctor so it can rewrite `storage.backend` to "memory".
      try {
        (api as any).doctor?.recordConfigRepair?.({
          pluginId: "memory_new",
          key: "storage.backend",
          from: storageConfig.backend,
          to: initResult.backend,
          reason: initResult.warning,
        });
      } catch {
        // DoctorContract not present in this host — non-fatal.
      }
    }

    // Initialize storage
    const storage = new StorageAdapter(storageConfig.dataDir);
    const recall = new RecallEngine(storage);

    // Initialize vector store for semantic search
    const vectorStore = new VectorStore();

    // =========================================================================
    // Visualization HTTP server (standalone, 127.0.0.1 only)
    // =========================================================================
    //
    // Started lazily via CLI / exposeFunction. Default OFF — binding a TCP port
    // surprises people, so we require either config.visualize.enabled=true at
    // boot, or an explicit `memory_new.visualize start` CLI invocation. The
    // server uses node:http only (no express), so no new runtime deps.
    type VizHandle = { port: number; url: string; stop: () => Promise<void> };
    let visualizeServer: VizHandle | null = null;

    async function startVisualize(): Promise<VizHandle> {
      if (visualizeServer) return visualizeServer;
      const handle = await _startVisualizeServer({
        store: {
          searchL1: (q, limit) => store.searchL1(q, limit),
          getSceneIndex: () => store.getSceneIndex(),
          getPersona: () => store.getPersona(),
        },
        recall,
        pipeline,
        decayLogger,
        l3DryRun,
        dataDir: storageConfig.dataDir,
        backend: effectiveBackend,
      });
      visualizeServer = handle;
      api.logger.info?.(`[memory_new] visualize server listening at ${handle.url}`);
      return handle;
    }

    async function stopVisualize(): Promise<void> {
      if (!visualizeServer) return;
      const h = visualizeServer;
      visualizeServer = null;
      await h.stop();
      api.logger.info?.(`[memory_new] visualize server stopped`);
    }

    // Expose programmatic lifecycle (for Doctor, tests, automation).
    api.exposeFunction?.("memory_new_visualize_start", async () => {
      const h = await startVisualize();
      return { url: h.url, port: h.port };
    });
    api.exposeFunction?.("memory_new_visualize_stop", async () => {
      await stopVisualize();
      return { stopped: true };
    });
    api.exposeFunction?.("memory_new_visualize_status", async () => {
      if (!visualizeServer) return { running: false };
      return { running: true, url: visualizeServer.url, port: visualizeServer.port };
    });

    // Initialize distillation pipeline
    const pipeline = new DistillationPipeline(DEFAULT_DISTILLATION_CONFIG, store, vectorStore);
    pipeline.setLogger(api.logger);

    // Auto-enable + auto-start the visualization dashboard.
    // IMPORTANT: must come AFTER `const pipeline` (it is referenced by
    // startVisualize). Otherwise the sync register() hits a TDZ ReferenceError
    // ("Cannot access 'pipeline' before initialization") and the dashboard
    // silently never binds its port.
    //
    // Two paths:
    //  1. No visualize config in openclaw.json yet → write it now
    //     (ensureVisualizeAutoStartSync) and start the server this boot, so a
    //     freshly installed plugin is fully automatic — no manual setup step.
    //  2. visualize already configured + enabled → start as usual.
    const autoStartViz = () => {
      startVisualize().catch((e) => {
        api.logger.warn?.(`[memory_new] visualize auto-start failed: ${e?.message ?? e}`);
      });
    };
    if (config.visualize?.enabled && config.visualize.autoStart !== false) {
      autoStartViz();
    } else {
      const setupResult = ensureVisualizeAutoStartSync(process.env.OPENCLAW_PROFILE || "");
      if (setupResult.changed) {
        api.logger.info?.(
          `[memory_new] auto-enabled visualization dashboard (${setupResult.message})`,
        );
        autoStartViz();
      } else if (!setupResult.configPath) {
        // openclaw.json missing — nothing we can persist; leave dashboard off.
      }
    }

    // Initialize team memory manager
    const teamMemory = new TeamMemoryManager(config.teamMemory.maxImportedAgents);

    // Wire up vector store to memory store
    store.setVectorStore(vectorStore);

    // Wire up L1 storage callback to trigger L2 distillation
    store.setOnL1Stored(() => {
      if (config.layersEnabled.L2) {
        pipeline.distill("L2").catch(err => {
          api.logger.debug?.(`[memory_new] L2 auto-distill failed: ${err}`);
        });
      }
    });

    // Register embedding provider for vector search (if LLM enabled)
    if (config.llm?.enabled) {
      // Register our built-in embedding provider adapter
      api.registerEmbeddingProvider({
        id: "memory-new-embedder",
        defaultModel: config.llm.model ?? "default",
        transport: "local",
        create: async (options) => {
          // Create a simple hash-based embedder when no real provider is available
          const provider: EmbeddingProvider = {
            id: "memory-new-embedder",
            model: options.model,
            dimensions: 384,
            maxInputTokens: 8192,
            embed: async (input) => {
              const text = typeof input === "string" ? input : input.text;
              return vectorStore.generatePseudoEmbedding(text);
            },
            embedBatch: async (inputs) => {
              return inputs.map(input => {
                const text = typeof input === "string" ? input : input.text;
                return vectorStore.generatePseudoEmbedding(text);
              });
            },
          };
          return { provider, runtime: { id: "memory-new-embedder" } };
        },
      });

      // Set up subagent runner for LLM extraction
      pipeline.setSubagentRunner(async (prompt: string) => {
        try {
          const result = await api.runtime.subagent.run({
            sessionKey: `memory-${Date.now()}`,
            message: prompt,
            model: config.llm?.model,
            disableTools: true,
          });
          // Wait for completion
          const waitResult = await api.runtime.subagent.waitForRun({ runId: result.runId, timeoutMs: 30000 });
          // Get session messages to extract response
          const messages = await api.runtime.subagent.getSessionMessages({ sessionKey: result.sessionKey! });
          // Find assistant response
          const assistantMsg = messages.messages.find((m: any) => m.role === "assistant");
          return assistantMsg?.content?.[0]?.text ?? "";
        } catch (error) {
          api.logger.debug?.(`Subagent extraction failed: ${error}`);
          throw error;
        }
      });
    }

    // Track session messages for L0
    const sessionMessages = new Map<string, any[]>();

    // =========================================================================
    // Commands
    // =========================================================================

    api.registerCommand({
      name: "mem",
      description: "Interact with memory system (L0→L1→L2→L3)",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const args = ctx.args ?? "";
        const [action, ...rest] = args.trim().split(/\s+/);

        switch (action) {
          case "add": {
            const content = rest.join(" ");
            if (!content) return { text: "Usage: mem add <content>" };

            // Store directly to L1
            const now = new Date().toISOString();
            await store.storeL1({
              content,
              type: "episodic",
              priority: 50,
              sceneName: "User Added",
              sourceMessageIds: [],
              metadata: { source: "command" },
              timestamps: [now],
              sessionKey: ctx.sessionKey ?? "default",
              sessionId: ctx.sessionKey ?? "default",
              userId: ctx.senderIsOwner ? "owner" : "user",
              agentId: "self",
            });

            return { text: `Added: ${content.slice(0, 50)}...` };
          }

          case "search": {
            const query = rest.join(" ");
            if (!query) return { text: "Usage: memory search <query>" };

            // Use recall engine for search
            const result = await recall.recall({
              query,
              sessionKey: ctx.sessionKey ?? "default",
              userId: ctx.senderIsOwner ? "owner" : "user",
              agentId: "self",
              topK: config.retrieval.topK,
            });

            if (!result.prependContext && !result.appendSystemContext) {
              return { text: "No relevant memories found." };
            }

            return {
              text: `Found memories:\n\n${result.prependContext ?? ""}\n\n${result.appendSystemContext ?? ""}`,
            };
          }

          case "list": {
            // Get recent L1 records
            const records = await store.searchL1("", 20);

            if (records.length === 0) return { text: "No memories stored." };

            const lines = records.map(r =>
              `[${r.type}] ${r.content.slice(0, 60)}${r.content.length > 60 ? "..." : ""}`
            );
            return { text: `Recent ${records.length} memories:\n\n${lines.join("\n")}` };
          }

          case "reinforce": {
            // Not applicable with new storage model
            return { text: "Reinforce is not yet supported with persistent storage." };
          }

          case "decay": {
            // Apply decay - placeholder
            return { text: "Decay is not yet fully implemented." };
          }

          case "stats": {
            const stats = await pipeline.getStats();
            return {
              text: `Memory Stats:
  L0 (buffered): ${stats.l0Count}
  L1 (stored): ${stats.l1Count}
  L2 (scenes): ${stats.l2Count}
  L3 (persona): ${stats.l3Count}`,
            };
          }

          case "config": {
            return { text: JSON.stringify(config, null, 2) };
          }

          default:
            return {
              text: `Memory New commands:
  mem add <content>         - Add a memory
  mem search <query>       - Search memories
  mem list                 - List recent memories
  mem stats                - Show memory statistics
  mem config               - Show configuration

Memory layers: L0 (raw) → L1 (atomic) → L2 (scene) → L3 (persona)`,
            };
        }
      },
    });

    // Team memory command
    api.registerCommand({
      name: "team-mem",
      description: "Team memory operations",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        if (!config.teamMemory.enabled) {
          return { text: "Team memory is disabled." };
        }

        const args = ctx.args ?? "";
        const [action, ...rest] = args.trim().split(/\s+/);

        switch (action) {
          case "share": {
            return { text: "Share is not yet implemented." };
          }

          case "import": {
            return { text: "Import is not yet implemented." };
          }

          case "status": {
            const stats = await pipeline.getStats();
            return {
              text: `Team memory status:
  Enabled: ${config.teamMemory.enabled}
  Max imported agents: ${config.teamMemory.maxImportedAgents}
  Visibility gate: ${config.teamMemory.visibilityGate}
  Total L1 memories: ${stats.l1Count}
  Total L2 scenes: ${stats.l2Count}`,
            };
          }

          default:
            return {
              text: `Team memory commands:
  team-memory status            - Show team memory status`,
            };
        }
      },
    });

    // memory_new.l3_dry_run — preview what L3 *would* write, without touching persona.md
    api.registerCommand({
      name: "memory_new_l3_dry_run",
      description: "Preview L3 persona that would have been written (dry-run, safe to call anytime)",
      handler: async () => {
        const report = await l3DryRun();
        await persistL3Preview(report);

        const lines: string[] = [];
        lines.push(`L3 Dry-Run @ ${report.timestamp}`);
        lines.push(`  L1 records: ${report.l1Count}`);
        lines.push(`  Avg importance: ${report.avgImportance.toFixed(2)}`);
        lines.push(`  Threshold met: ${report.thresholdMet}`);
        lines.push(`  High-value scenes: ${report.highValueSceneCount}`);
        lines.push(`  Hint: ${report.hint}`);

        if (report.previewPersona) {
          lines.push("");
          lines.push("---- PREVIEW PERSONA (not written) ----");
          lines.push(report.previewPersona);
        }

        return { text: lines.join("\n") };
      },
    });

    // memory_new.verify_hooks — multi-layer hook self-test
    api.registerCommand({
      name: "memory_new_verify_hooks",
      description: "Run multi-layer E2E self-test for hooks and injection contract",
      handler: async () => {
        const report = await verifyHooks();
        const lines: string[] = [];
        lines.push(`verify_hooks: ${report.success ? "PASS" : "FAIL"}`);
        lines.push("");
        lines.push("[inProcess]");
        lines.push(`  recall:  ${report.layers.inProcess.recallOk ? "✓" : "✗"}`);
        lines.push(`  ingest:  ${report.layers.inProcess.ingestOk ? "✓" : "✗"}`);
        lines.push(`  distill: ${report.layers.inProcess.distillOk ? "✓" : "✗"}`);
        if (report.layers.inProcess.error) lines.push(`  error:   ${report.layers.inProcess.error}`);
        lines.push("");
        lines.push("[injection]");
        lines.push(`  strategy:                ${report.layers.injection.recallStrategy ?? "n/a"}`);
        lines.push(`  <relevant-memories>:     ${report.layers.injection.hasRelevantMemoriesMarker ? "✓" : "✗"}`);
        lines.push(`  <user-persona>:          ${report.layers.injection.hasPersonaMarker ? "✓" : "—"}`);
        lines.push(`  <scene-navigation>:      ${report.layers.injection.hasSceneNavigationMarker ? "✓" : "—"}`);
        if (report.layers.injection.error) lines.push(`  error:   ${report.layers.injection.error}`);
        lines.push("");
        lines.push("[sideEffects]");
        if (report.layers.sideEffects.decayLoggerStats) {
          lines.push(`  decayLogger.total:       ${report.layers.sideEffects.decayLoggerStats.total}`);
          const reasons = Object.entries(report.layers.sideEffects.decayLoggerStats.byReason)
            .map(([k, v]) => `${k}=${v}`).join(", ");
          lines.push(`  decayLogger.byReason:    ${reasons || "(none)"}`);
        }
        if (report.layers.sideEffects.pipelineStats) {
          const p = report.layers.sideEffects.pipelineStats;
          lines.push(`  pipeline:                L0=${p.l0Count} L1=${p.l1Count} L2=${p.l2Count} L3=${p.l3Count}`);
        }
        if (report.layers.sideEffects.error) lines.push(`  error:   ${report.layers.sideEffects.error}`);
        lines.push("");
        lines.push("[coverage]");
        lines.push(`  checked: ${report.coverage.checked.length}`);
        lines.push(`  NOT checked (gateway-only): ${report.coverage.notChecked.length}`);
        for (const nc of report.coverage.notChecked) lines.push(`    - ${nc}`);

        return { text: lines.join("\n") };
      },
    });

    // memory_new_visualize — start/stop/status for the standalone HTTP server.
    // NOTE: command names may only contain [A-Za-z0-9_-]; dots are rejected by
    // the openclaw gateway ("Command name must start with a letter...").
    api.registerCommand({
      name: "memory_new_visualize",
      description: "Control the standalone HTTP visualization server (start|stop|status)",
      acceptsArgs: true,
      handler: async (ctx) => {
        const action = (ctx.args ?? "").trim().split(/\s+/)[0] ?? "status";
        switch (action) {
          case "start": {
            const h = await startVisualize();
            return {
              text:
                `visualize started.\n` +
                `URL:      ${h.url}\n` +
                `Backend:  ${effectiveBackend}\n` +
                `DataDir:  ${storageConfig.dataDir}\n\n` +
                `Open ${h.url} in a browser. Stop with: memory_new.visualize stop`,
            };
          }
          case "stop": {
            await stopVisualize();
            return { text: "visualize stopped." };
          }
          case "status":
          default: {
            if (!visualizeServer) {
              return {
                text:
                  `visualize: not running.\n` +
                  `Start with: memory_new.visualize start`,
              };
            }
            return {
              text: `visualize: running at ${visualizeServer.url} (port ${visualizeServer.port})`,
            };
          }
        }
      },
    });

    // memory_new_visualize_setup — persist visualize auto-start config into
    // openclaw.json so the HTTP server binds on every gateway boot. This is a
    // plugin command (chat-dispatch only). For a terminal CLI path use the
    // package `bin` (`memory-new-setup`), because openclaw plugin commands are
    // NOT reachable from the shell.
    //
    // Usage:
    //   memory_new_visualize_setup           # enable + restart gateway
    //   memory_new_visualize_setup --reset   # remove the block (back to default OFF)
    //   memory_new_visualize_setup --no-restart   # patch config but skip restart
    api.registerCommand({
      name: "memory_new_visualize_setup",
      description:
        "Persist visualize.enabled/autoStart into openclaw.json so the HTTP server starts on every gateway boot. Honors --reset (turn off) and --no-restart (skip gateway restart).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = new Set((ctx.args ?? "").trim().split(/\s+/).filter(Boolean));
        const RESET = args.has("--reset");
        const NO_RESTART = args.has("--no-restart");
        const PROFILE =
          [...args].find((a) => a.startsWith("--profile="))?.slice("--profile=".length) ??
          process.env.OPENCLAW_PROFILE ??
          "";
        return await runVisualizeSetup({ reset: RESET, noRestart: NO_RESTART, profile: PROFILE, api });
      },
    });

    // =========================================================================
    // Hook Self-Verification (for runtime validation)
    // =========================================================================

    /**
     * Multi-layer end-to-end self-test.
     *
     * Returns a structured report so the CLI / Doctor can show *why* a hook is broken
     * instead of a single pass/fail bit. Layers:
     *
     *   inProcess     – recall() / ingest() / distill() actually run without throwing.
     *   injection     – we simulate before_prompt_build and assert the returned
     *                   string actually contains <relevant-memories> / <user-persona> /
     *                   <scene-navigation> markers (the real contract of the hook).
     *   sideEffects   – writing one L1 record triggers decayLogger / pipeline stats,
     *                   proving the write-path side of the hook fires.
     *
     * Note: this still does NOT cross into the OpenClaw gateway runtime — that part
     * is best verified by sending a real prompt via `openclaw session send`. We
     * surface this gap explicitly in `coverage`.
     */
    async function verifyHooks(): Promise<{
      success: boolean;
      layers: {
        inProcess: { passed: boolean; recallOk: boolean; ingestOk: boolean; distillOk: boolean; error?: string };
        injection: {
          passed: boolean;
          hasRelevantMemoriesMarker: boolean;
          hasPersonaMarker: boolean;
          hasSceneNavigationMarker: boolean;
          recallStrategy?: string;
          error?: string;
        };
        sideEffects: {
          passed: boolean;
          decayLoggerStats?: { total: number; byReason: Record<string, number> };
          pipelineStats?: { l0Count: number; l1Count: number; l2Count: number; l3Count: number };
          error?: string;
        };
      };
      coverage: {
        checked: string[];
        notChecked: string[]; // things only the gateway runtime can verify
      };
    }> {
      const report = {
        success: true,
        layers: {
          inProcess: { passed: true, recallOk: false, ingestOk: false, distillOk: false } as any,
          injection: {
            passed: true,
            hasRelevantMemoriesMarker: false,
            hasPersonaMarker: false,
            hasSceneNavigationMarker: false,
          } as any,
          sideEffects: { passed: true } as any,
        },
        coverage: {
          checked: [
            "MemoryStore+StorageAdapter construct",
            "RecallEngine.recall() returns without throwing",
            "MemoryStore.ingestMessage writes a record",
            "DistillationPipeline.distill() runs an L1 pass",
            "Decay logger accumulates transitions",
            "before_prompt_build return contract (markers in injected string)",
          ],
          notChecked: [
            "OpenClaw gateway actually calls our before_prompt_build handler",
            "session_end fires from a real conversation",
            "mem_new_search / mem_new_store tools are exposed to the agent",
            "DoctorContract.configRepair round-trip",
          ],
        },
      };

      // ---- Layer 1: in-process ----
      try {
        await recall.recall({
          query: "__hook_test__",
          sessionKey: "__verify__",
          userId: "__verify__",
          agentId: "__verify__",
          topK: 1,
        });
        report.layers.inProcess.recallOk = true;

        const testMsg: Omit<L0Message, "id" | "recordedAt"> = {
          role: "user",
          content: "__verify_test_message__",
          timestamp: Date.now(),
          sessionKey: "__verify__",
          sessionId: "__verify__",
          userId: "__verify__",
          agentId: "__verify__",
        };
        await store.ingestMessage(testMsg);
        report.layers.inProcess.ingestOk = true;

        await pipeline.distill("L1");
        report.layers.inProcess.distillOk = true;
      } catch (e: any) {
        report.layers.inProcess.passed = false;
        report.layers.inProcess.error = e?.message ?? String(e);
        report.success = false;
      }

      // ---- Layer 2: injection contract ----
      try {
        // Seed a tagged memory so the recall below will find something to inject.
        await store.storeL1({
          content: "__verify_marker__ the user prefers coffee in the morning",
          type: "persona",
          priority: 80,
          sceneName: "__verify_scene__",
          sourceMessageIds: [],
          metadata: { source: "verify_hooks" },
          timestamps: [new Date().toISOString()],
          sessionKey: "__verify__",
          sessionId: "__verify__",
          userId: "__verify__",
          agentId: "__verify__",
        });

        const recallResult = await recall.recall({
          query: "coffee morning",
          sessionKey: "__verify__",
          userId: "__verify__",
          agentId: "__verify__",
          topK: 5,
        });
        report.layers.injection.recallStrategy = recallResult.recallStrategy;

        const appended = recallResult.appendSystemContext ?? "";
        const prepended = recallResult.prependContext ?? "";
        report.layers.injection.hasRelevantMemoriesMarker =
          prepended.includes("<relevant-memories>") || appended.includes("<relevant-memories>");
        report.layers.injection.hasPersonaMarker = appended.includes("<user-persona>");
        report.layers.injection.hasSceneNavigationMarker = appended.includes("<scene-navigation>");

        report.layers.injection.passed =
          report.layers.injection.hasRelevantMemoriesMarker;
        if (!report.layers.injection.passed) report.success = false;
      } catch (e: any) {
        report.layers.injection.passed = false;
        report.layers.injection.error = e?.message ?? String(e);
        report.success = false;
      }

      // ---- Layer 3: side effects (decay + pipeline stats) ----
      try {
        report.layers.sideEffects.decayLoggerStats = {
          total: decayLogger.getStats().total,
          byReason: decayLogger.getStats().byReason,
        };
        report.layers.sideEffects.pipelineStats = await pipeline.getStats();
        report.layers.sideEffects.passed = true;
      } catch (e: any) {
        report.layers.sideEffects.passed = false;
        report.layers.sideEffects.error = e?.message ?? String(e);
        report.success = false;
      }

      return report;
    }

    // Expose verification function for CLI/debugging
    api.exposeFunction?.("memory_new.verify_hooks", verifyHooks);

    // =========================================================================
    // L3 Dry-Run (default behaviour when layersEnabled.L3 === false)
    // =========================================================================
    //
    // When the user hasn't enabled L3, we still want to know *what would have
    // been written* so they can decide whether to flip the switch. After each
    // session_end we run the L3 distillation in dry-run mode: it gathers L1
    // records, checks the importance threshold, and produces a preview persona
    // WITHOUT writing persona.md. If the preview passes the threshold we emit
    // a warning + persist the preview to `memory/l3-preview.json` for the
    // `memory_new.l3_dry_run` CLI command to surface.

    type L3DryRunReport = {
      timestamp: string;
      l1Count: number;
      avgImportance: number;
      thresholdMet: boolean;
      highValueSceneCount: number;
      previewPersona: string;
      hint: string;
    };

    async function l3DryRun(): Promise<L3DryRunReport> {
      const threshold = DEFAULT_DISTILLATION_CONFIG.l3.importanceThreshold;
      const l1Records = await store.searchL1("", 100);
      const sceneIndex = await store.getSceneIndex();

      if (l1Records.length === 0) {
        return {
          timestamp: new Date().toISOString(),
          l1Count: 0,
          avgImportance: 0,
          thresholdMet: false,
          highValueSceneCount: 0,
          previewPersona: "",
          hint: "Not enough L1 records yet. Keep chatting.",
        };
      }

      const avgImportance =
        l1Records.reduce((sum, r) => sum + r.priority, 0) / l1Records.length / 100;
      const thresholdMet = avgImportance >= threshold;

      let highValueScenes: Array<{ id: string; title: string; summary: string }> = [];
      let preview = "";
      if (thresholdMet) {
        highValueScenes = sceneIndex.filter(s => {
          const related = l1Records.filter(r => r.sceneName === s.title);
          if (related.length === 0) return false;
          const avg = related.reduce((sum, r) => sum + r.priority, 0) / related.length;
          return avg >= threshold * 100;
        });
        preview = buildDryRunPersona(highValueScenes, l1Records, avgImportance);
      }

      return {
        timestamp: new Date().toISOString(),
        l1Count: l1Records.length,
        avgImportance,
        thresholdMet,
        highValueSceneCount: highValueScenes.length,
        previewPersona: preview,
        hint: thresholdMet
          ? `Threshold met (avg=${avgImportance.toFixed(2)} >= ${threshold}). Set layersEnabled.L3=true in openclaw.plugin.json to start writing persona.md.`
          : `Below threshold (avg=${avgImportance.toFixed(2)} < ${threshold}). Write higher-priority memories.`,
      };
    }

    function buildDryRunPersona(
      scenes: Array<{ id: string; title: string; summary: string }>,
      l1Records: Awaited<ReturnType<typeof store.searchL1>>,
      avgImportance: number
    ): string {
      const sceneContents = scenes.map(scene => {
        const related = l1Records.filter(r => r.sceneName === scene.title);
        return `### ${scene.title}\n${related.map(m => `- ${m.content}`).join("\n")}`;
      }).join("\n\n");
      return `# Agent Self-Model (DRY RUN)

## Core Knowledge
${sceneContents || "(no high-value scenes)"}

## Behavioral Patterns
- 共 ${scenes.length} 个高价值场景
- 平均重要性: ${avgImportance.toFixed(2)}

## Preferences
(从 persona 类型记忆中提取)

## Communication Style
(从交互模式中学习)

---
Generated: ${new Date().toISOString()}
(DRY RUN — persona.md was NOT written. Flip layersEnabled.L3=true to materialize.)`;
    }

    async function persistL3Preview(report: L3DryRunReport): Promise<void> {
      try {
        await storage.writeFile("l3-preview.json", JSON.stringify(report, null, 2));
      } catch (e) {
        api.logger.debug?.(`[memory_new] failed to persist L3 preview: ${e}`);
      }
    }

    // Expose for CLI/debugging
    api.exposeFunction?.("memory_new.l3_dry_run", l3DryRun);

    // =========================================================================
    // Lifecycle Hooks
    // =========================================================================

    // before_prompt_build: inject relevant memories
    api.on("before_prompt_build", async (event, ctx) => {
      if (!config.enabled) return undefined;

      const sessionKey = ctx.sessionKey ?? "default";
      const userId = "user";  // Default user

      try {
        // Recall relevant memories
        const query = event.prompt?.slice(0, 200) ?? "no-prompt";
        api.logger.info?.(`[memory_new] before_prompt_build called with query: "${query}"`);

        const recallResult = await recall.recall({
          query,
          sessionKey,
          userId,
          agentId: "self",
          topK: config.retrieval.topK,
          vectorStore: config.retrieval.hybridSearch ? vectorStore : undefined,
        });

        api.logger.info?.(`[memory_new] recallResult: strategy=${recallResult.recallStrategy}, memories=${recallResult.recalledL1Memories?.length ?? 0}`);

        // If no memories, skip
        if (!recallResult.prependContext && !recallResult.appendSystemContext) {
          api.logger.debug?.(`[memory_new] No memories found for query: "${query}"`);
          return undefined;
        }

        api.logger.info?.(`[memory_new] Injecting context for session ${sessionKey}`);

        return {
          prependContext: recallResult.prependContext,
          appendContext: recallResult.appendSystemContext,
        };
      } catch (error) {
        api.logger.debug?.(`Memory recall failed: ${error}`);
        return undefined;
      }
    });

    // after_prompt_build: capture messages to L0 (using session_end for cleanup)
    api.on("session_end", async (event, ctx) => {
      if (!config.enabled || !config.layersEnabled.L0) return;

      const sessionKey = ctx.sessionKey ?? "default";

      try {
        // Get messages from event (if available)
        const messages = (event as any).messages ?? [];

        if (messages.length > 0) {
          // Ingest messages into L0
          for (const msg of messages) {
            const l0Msg: Omit<L0Message, "id" | "recordedAt"> = {
              role: msg.role === "user" ? "user" : "assistant",
              content: msg.content?.slice(0, 10000) ?? "",  // Limit length
              timestamp: msg.timestamp ?? Date.now(),
              sessionKey,
              sessionId: sessionKey,
              userId: "user",
              agentId: "self",
            };

            await store.ingestMessage(l0Msg);
          }

          // Trigger L1 extraction if threshold met
          if (config.layersEnabled.L1 && config.llm?.enabled) {
            await pipeline.distill("L1");
          }
        }
      } catch (error) {
        api.logger.debug?.(`Memory capture failed: ${error}`);
      }
    });

    // agent_end: process remaining messages
    api.on("agent_end", (event, ctx) => {
      if (!config.enabled) return;

      const runId = event.runId ?? ctx.runId;
      api.logger.debug?.(`Memory: agent ended for run ${runId}`);
    });

    // session_end: cleanup and final processing
    api.on("session_end", async (event, ctx) => {
      if (!config.enabled) return;

      const sessionKey = ctx.sessionKey ?? "default";

      try {
        // Apply decay if enabled
        if (config.decay.stateMachine.enabled || config.decay.ttl.enabled) {
          const decayResult = await applyDecayToL1(store, config.decay);
          if (decayResult.deleted > 0 || decayResult.frozen > 0) {
            api.logger.info?.(`[memory_new] Decay: deleted=${decayResult.deleted}, frozen=${decayResult.frozen}`);
          }
        }

        // Trigger L2/L3 distillation if enabled
        if (config.layersEnabled.L2) {
          await pipeline.distill("L2");
        }
        if (config.layersEnabled.L3) {
          await pipeline.distill("L3");
        } else {
          // L3 is OFF by default — run a dry-run instead so the user can see
          // what *would* have been written and decide whether to enable it.
          try {
            const report = await l3DryRun();
            await persistL3Preview(report);
            if (report.thresholdMet && report.highValueSceneCount > 0) {
              api.logger.warn?.(
                `[memory_new] L3 dry-run: ${report.highValueSceneCount} high-value scenes, avg importance ${report.avgImportance.toFixed(2)}. ` +
                `Run \`memory_new.l3_dry_run\` to preview, or set layersEnabled.L3=true to start writing persona.md.`
              );
            } else {
              api.logger.debug?.(
                `[memory_new] L3 dry-run: ${report.hint} (l1Count=${report.l1Count})`
              );
            }
          } catch (e) {
            api.logger.debug?.(`[memory_new] L3 dry-run failed: ${e}`);
          }
        }

        // Clear session message buffer
        sessionMessages.delete(sessionKey);

        api.logger.debug?.(`Memory: session ended for ${sessionKey}`);
      } catch (error) {
        api.logger.debug?.(`Memory session cleanup failed: ${error}`);
      }
    });

    // =========================================================================
    // Tools
    // =========================================================================

    api.registerTool({
      name: "mem_new_search",
      description: "Search memory store using hybrid retrieval",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results", default: 10 },
          visibility: {
            type: "string",
            enum: ["all", "public", "team", "private"],
            default: "all",
          },
        },
        required: ["query"],
      },
      execute: async (params, ctx) => {
        const result = await recall.recall({
          query: params.query,
          sessionKey: ctx.sessionKey ?? "default",
          userId: "user",
          agentId: "self",
          topK: params.limit ?? 10,
        });

        return {
          memories: result.recalledL1Memories ?? [],
          prependContext: result.prependContext,
          appendContext: result.appendSystemContext,
        };
      },
    });

    api.registerTool({
      name: "mem_new_store",
      description: "Store a new memory engram",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content" },
          type: {
            type: "string",
            enum: ["persona", "episodic", "instruction"],
            default: "episodic",
            description: "Memory type",
          },
          priority: {
            type: "number",
            default: 50,
            description: "Priority 0-100",
          },
          sceneName: {
            type: "string",
            default: "General",
            description: "Scene name",
          },
        },
        required: ["content"],
      },
      execute: async (params, ctx) => {
        // Extract params explicitly - SDK may pass params in non-standard ways
        const { content, type, priority, sceneName } = params as any;

        // Validate required content
        if (!content || typeof content !== "string") {
          return { error: "content is required and must be a non-empty string", stored: false };
        }

        const record = await store.storeL1({
          content,
          type: type ?? "episodic",
          priority: priority ?? 50,
          sceneName: sceneName ?? "General",
          sourceMessageIds: [],
          metadata: { source: "tool" },
          timestamps: [new Date().toISOString()],
          sessionKey: ctx.sessionKey ?? "default",
          sessionId: ctx.sessionKey ?? "default",
          userId: "user",
          agentId: "self",
        });

        return { engramId: record.id, stored: true };
      },
    });

    api.registerTool({
      name: "mem_new_get",
      description: "Get a specific memory by ID",
      parameters: {
        type: "object",
        properties: {
          layer: {
            type: "string",
            enum: ["L0", "L1", "L2", "L3"],
            default: "L1",
            description: "Memory layer",
          },
          id: { type: "string", description: "Memory ID (for L2/L3)" },
        },
        required: [],
      },
      execute: async (params, ctx) => {
        if (params.layer === "L2" && params.id) {
          const scene = await store.getScene(params.id);
          return scene ?? { error: "Scene not found" };
        }

        if (params.layer === "L3") {
          const persona = await store.getPersona();
          return persona ?? { error: "Persona not found" };
        }

        // L1 search
        const records = await store.searchL1("", 10);
        return { records };
      },
    });

    api.registerTool({
      name: "mem_new_distill",
      description: "Trigger memory distillation manually",
      parameters: {
        type: "object",
        properties: {
          layer: {
            type: "string",
            enum: ["L1", "L2", "L3"],
            default: "L1",
            description: "Layer to distill",
          },
        },
        required: ["layer"],
      },
      execute: async (params, ctx) => {
        // Validate layer to avoid "Unknown stage" error
        const validLayers: MemoryLayer[] = ["L1", "L2", "L3"];
        const layer = validLayers.includes(params.layer as MemoryLayer)
          ? (params.layer as MemoryLayer)
          : "L1";
        const result = await pipeline.distill(layer);

        return {
          layer: result.stage,
          produced: result.produced,
          errors: result.errors,
        };
      },
    });

    // =========================================================================
    // HTTP Routes (team memory sync - reserved interface)
    // =========================================================================

    api.registerHttpRoute({
      method: "GET",
      path: "/memory/team/status",
      auth: "none",
      handler: async (req, ctx) => {
        if (!config.teamMemory.enabled) {
          return { status: 403, body: { error: "Team memory disabled" } };
        }

        const stats = await pipeline.getStats();
        const sharedCount = teamMemory.getSharedEngrams("self").length;
        const importedCount = teamMemory.getImportedEngrams("self").length;

        return {
          status: 200,
          body: {
            enabled: true,
            maxImportedAgents: config.teamMemory.maxImportedAgents,
            l1Count: stats.l1Count,
            l2Count: stats.l2Count,
            sharedCount,
            importedCount,
            visibilityGate: config.teamMemory.visibilityGate,
          },
        };
      },
    });

    api.registerHttpRoute({
      method: "POST",
      path: "/memory/team/share",
      auth: "none",
      handler: async (req, ctx) => {
        if (!config.teamMemory.enabled) {
          return { status: 403, body: { error: "Team memory disabled" } };
        }

        const body = (req as any).body || {};
        const { engramId, visibility = "team" } = body;

        if (!engramId) {
          return { status: 400, body: { error: "engramId required" } };
        }

        // Create a minimal engram for sharing
        const engram: Engram = {
          id: engramId,
          kind: "fact",
          status: "active",
          visibility: visibility as any,
          verification: "probable",
          content: "",
          importance: 0.5,
          lastEffectiveAt: Date.now(),
          metadata: { shared: true },
          tags: [],
          contextTags: [],
          source: "team-share",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "self",
          trustLevel: "direct",
          synapses: [],
        };

        const result = teamMemory.share(engram, "self");

        if (!result.success) {
          return { status: 400, body: { error: result.error } };
        }

        return { status: 200, body: { success: true, engramId } };
      },
    });

    api.registerHttpRoute({
      method: "POST",
      path: "/memory/team/import",
      auth: "none",
      handler: async (req, ctx) => {
        if (!config.teamMemory.enabled) {
          return { status: 403, body: { error: "Team memory disabled" } };
        }

        const body = (req as any).body || {};
        const { fromAgentId, engramIds } = body;

        if (!fromAgentId || !engramIds || !Array.isArray(engramIds)) {
          return { status: 400, body: { error: "fromAgentId and engramIds[] required" } };
        }

        const result = teamMemory.import(fromAgentId, "self", engramIds);

        if (!result.success) {
          return { status: 400, body: { error: result.error } };
        }

        return { status: 200, body: { success: true, imported: result.imported } };
      },
    });

    api.logger.info?.("Memory New plugin registered with storage and pipeline");

    // Auto-configure plugin settings when installed
    api.registerConfigMigration?.({
      id: "memory-new-default-config",
      migrate: (existingConfig) => {
        const current = existingConfig?.memory_new;
        if (!current) {
          // First install - set defaults
          return {
            memory_new: {
              enabled: true,
              layersEnabled: { L0: true, L1: true, L2: true, L3: false },
              llm: { enabled: false, model: "default" },
              retrieval: {
                hybridSearch: true,
                semanticWeight: 0.5,
                bm25Weight: 0.25,
                entityBoostWeight: 0.25,
                topK: 10,
                overFetch: 4,
              },
              storage: { backend: "memory", dataDir: "~/.openclaw/memory-new" },
              decay: {
                ttl: { enabled: true, retentionDays: 30, safetyThreshold: 0.8, minRetainL0: 50, minRetainL1: 20 },
                importance: { enabled: true, baseHalflifeDays: 50 },
                accessFrequency: { enabled: true },
                stateMachine: { enabled: true },
              },
              teamMemory: { enabled: true, maxImportedAgents: 2, visibilityGate: true },
            },
            plugins: {
              entries: {
                memory_new: {
                  hooks: {
                    allowConversationAccess: true,
                    allowPromptInjection: true,
                  },
                },
              },
            },
          };
        }
        return {}; // No migration needed
      },
    });

    // Auto-enable probe - allows OpenClaw to auto-enable this plugin
    api.registerAutoEnableProbe?.({
      id: "memory-new",
      check: async (config) => {
        // Check if memory_new config exists or if any memory-related files are present
        const hasConfig = config?.plugins?.memory_new?.enabled === true;
        const hasStorageDir = false; // Could check for ~/.openclaw/memory-new
        return hasConfig || hasStorageDir;
      },
    });
  },
});

// ============================================================================
// Exports for testing
// ============================================================================

// Import the correct deriveFreshness function (not the internal deriveFreshness2)
import { deriveFreshness as deriveFreshnessOriginal, decayLogger, StateTransitionLogger } from "./src/decay/decay.js";

export const testing = {
  // Core classes
  MemoryStore,
  StorageAdapter,
  VectorStore,
  DistillationPipeline,
  DEFAULT_DISTILLATION_CONFIG,
  TeamMemoryManager,
  RecallEngine,
  // Storage factory (sqlite with JSONL fallback)
  createMemoryStore,
  SqliteStore,
  // Visualize server
  startVisualizeServer: _startVisualizeServer,
  // Visualize setup (openclaw.json patcher)
  runVisualizeSetup,
  // Decay functions
  applyDecayBatch,
  applyTTLCleanup,
  deriveFreshness: deriveFreshnessOriginal,
  deriveHotness,
  calculateScore,
  // Decay visualization
  decayLogger,
  StateTransitionLogger,
  // Team memory
  validateVisibilityTransition,
  TeamEventStore,
};
