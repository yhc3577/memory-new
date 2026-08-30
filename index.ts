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
import { MemoryStore, StorageAdapter, RecallEngine, type L0Message } from "./src/store/storage.js";
import { DistillationPipeline, DEFAULT_DISTILLATION_CONFIG } from "./src/pipeline/distillation.js";
import { VectorStore } from "./src/vector/vector-store.js";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";

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

  // LLM for extraction
  llm?: {
    enabled: boolean;
    model?: string;
  };
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
// Memory Plugin
// ============================================================================

export default definePluginEntry({
  id: "memory_new",
  name: "Memory New",
  description: "Multi-layered memory system with L0→L1→L2→L3 distillation, persistent storage, and recall",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? DEFAULT_CONFIG) as MemoryNewConfig;

    // Ensure storage config exists
    const storageConfig = config.storage ?? { backend: "memory", dataDir: "~/.openclaw/memory-new" };

    // Initialize storage
    const storage = new StorageAdapter(storageConfig.dataDir);
    const store = new MemoryStore(storageConfig.dataDir);
    const recall = new RecallEngine(storage);

    // Initialize vector store for semantic search
    const vectorStore = new VectorStore();

    // Initialize distillation pipeline
    const pipeline = new DistillationPipeline(DEFAULT_DISTILLATION_CONFIG, store, vectorStore);

    // Wire up vector store to memory store
    store.setVectorStore(vectorStore);

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
        const query = event.prompt?.slice(0, 200) ?? "";
        const recallResult = await recall.recall({
          query,
          sessionKey,
          userId,
          agentId: "self",
          topK: config.retrieval.topK,
          vectorStore: config.retrieval.hybridSearch ? vectorStore : undefined,
        });

        // If no memories, skip
        if (!recallResult.prependContext && !recallResult.appendSystemContext) {
          return undefined;
        }

        return {
          prependContext: recallResult.prependContext,
          appendContext: recallResult.appendSystemContext,
        };
      } catch (error) {
        api.logger.debug?.(`Memory recall failed: ${error}`);
        return undefined;
      }
    });

    // after_prompt_build: capture messages to L0
    api.on("after_prompt_build", async (event, ctx) => {
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
        // Trigger L2/L3 distillation if enabled
        if (config.layersEnabled.L2) {
          await pipeline.distill("L2");
        }
        if (config.layersEnabled.L3) {
          await pipeline.distill("L3");
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
        const record = await store.storeL1({
          content: params.content,
          type: params.type as "persona" | "episodic" | "instruction" ?? "episodic",
          priority: params.priority ?? 50,
          sceneName: params.sceneName ?? "General",
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
        const layer = params.layer as MemoryLayer;
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
        return {
          status: 200,
          body: {
            enabled: true,
            maxImportedAgents: config.teamMemory.maxImportedAgents,
            l1Count: stats.l1Count,
            l2Count: stats.l2Count,
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
        return { status: 501, body: { error: "Not implemented" } };
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
        return { status: 501, body: { error: "Not implemented" } };
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

export const testing = {
  deriveFreshness,
  deriveHotness,
  calculateScore,
  validateVisibilityTransition,
};
