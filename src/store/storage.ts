/**
 * Memory Storage - Complete L0/L1/L2/L3 Implementation
 *
 * Reference: TDB (TencentDB-Agent-Memory) storage architecture
 *
 * Storage model:
 * - L0: SQLite (messages) + FTS5 (search)
 * - L1: SQLite (atomic memories) + VectorStore (embeddings)
 * - L2: File system (Markdown scene blocks)
 * - L3: File system (persona.md)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";

// ============================================================================
// Types
// ============================================================================

export interface L0Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;       // epoch ms
  sessionKey: string;
  sessionId: string;
  teamId?: string;
  userId: string;
  agentId: string;
  taskId?: string;
  recordedAt: string;      // ISO timestamp
}

/** Decay status persisted on an L1 row (mirrors EngramStatus in ../index). */
export type L1MemoryStatus = "draft" | "active" | "frozen" | "forgotten";
/** Kind persisted on an L1 row (mirrors EngramKind in ../index). */
export type L1MemoryKind = "observation" | "fact" | "pattern" | "procedure" | "hypothesis";

export interface L1Record {
  id: string;
  content: string;
  type: "persona" | "episodic" | "instruction";
  priority: number;        // 0-100
  sceneName: string;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
  timestamps: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
  sessionKey: string;
  sessionId: string;
  teamId?: string;
  userId: string;
  agentId: string;
  // Decay state (Co-Engram semantics). All optional for backward compat with
  // rows written before decay was persisted. Backfill defaults at read/derive
  // time: status=active, importance=priority/100, kind from type,
  // lastEffectiveAt=createdAt epoch.
  status?: L1MemoryStatus;
  kind?: L1MemoryKind;
  importance?: number;      // 0-1
  lastEffectiveAt?: number; // epoch ms; drives freshness
  retrievalCount?: number;  // successful recall hits
  lastRetrievedAt?: number; // epoch ms of most recent recall hit
  // Vector embedding stored separately
}

/**
 * Minimum gap (ms) between two recall-hit refreshes of the same L1 row.
 * Repeated hits inside the window are dropped so per-turn recall across
 * before_prompt_build / mem search / mem_new_search doesn't inflate counts.
 */
export const L1_RECALL_DEBOUNCE_MS = 60_000;

export interface L2Scene {
  id: string;
  title: string;
  content: string;         // Markdown
  summary: string;
  tags: string[];
  metadata: {
    layer: "L2";
    heat: number;          // Number of related L1s
    sourceRecords: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface L3Persona {
  id: string;
  content: string;         // Markdown
  summary: string;
  metadata: {
    layer: "L3";
    sourceScenes: string[];
  };
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Storage Paths
// ============================================================================

export const STORAGE_PATHS = {
  l0: "memory/l0/",
  l1: "memory/l1/",
  l2: "memory/scenes/",
  l3: "memory/persona.md",
  index: {
    l2: "memory/scenes/index.json",
    l3: "memory/persona.md.meta",
  },
};

// ============================================================================
// Storage Adapter (TDB's StorageAdapter pattern)
// ============================================================================

export class StorageAdapter {
  private baseDir: string;

  constructor(baseDir: string = "~/.openclaw/memory-new") {
    this.baseDir = baseDir.replace("~", process.env.HOME || "/root");
    mkdirSync(this.baseDir, { recursive: true });
  }

  private resolve(path: string): string {
    return join(this.baseDir, path);
  }

  // ========== File Operations ==========

  async readFile(key: string): Promise<string | null> {
    // If key is absolute path, use directly; otherwise resolve relative to baseDir
    const filePath = key.startsWith("/") ? key : this.resolve(key);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  async writeFile(key: string, content: string): Promise<void> {
    const filePath = key.startsWith("/") ? key : this.resolve(key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }

  async appendFile(key: string, content: string): Promise<void> {
    const filePath = key.startsWith("/") ? key : this.resolve(key);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, content, "utf-8");
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.resolve(key));
  }

  // ========== L0 Operations (JSONL per session) ==========

  /**
   * L0: Append message to session's JSONL file (TDB pattern: append-only)
   */
  async appendL0(record: L0Message): Promise<void> {
    const sessionFile = `${STORAGE_PATHS.l0}${record.sessionKey}.jsonl`;
    const line = JSON.stringify(record) + "\n";
    await this.appendFile(sessionFile, line);
  }

  /**
   * L0: Batch read messages from session
   */
  async readL0(sessionKey: string, limit: number = 100): Promise<L0Message[]> {
    const sessionFile = `${STORAGE_PATHS.l0}${sessionKey}.jsonl`;
    const content = await this.readFile(sessionFile);
    if (!content) return [];

    const lines = content.split("\n").filter(l => l.trim());
    const messages = lines.slice(-limit).map(line => JSON.parse(line) as L0Message);
    return messages;
  }

  /**
   * L0: Read recent messages across ALL sessions, newest first.
   * Bounds memory by only reading the newest `limit` lines per session file,
   * then merging + slicing globally. Used by the visualization drill-down.
   */
  async listL0Recent(limit: number = 200): Promise<L0Message[]> {
    const l0Dir = this.resolve(STORAGE_PATHS.l0);
    if (!existsSync(l0Dir)) return [];

    const files = readdirSync(l0Dir).filter(f => f.endsWith('.jsonl'));
    const all: L0Message[] = [];
    for (const file of files) {
      const content = await this.readFile(`${STORAGE_PATHS.l0}${file}`);
      if (!content) continue;
      const lines = content.split("\n").filter(l => l.trim()).slice(-limit);
      for (const line of lines) {
        try {
          all.push(JSON.parse(line) as L0Message);
        } catch {
          // Skip malformed lines
        }
      }
    }

    all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return all.slice(0, limit);
  }

  // ========== L1 Operations (JSONL) ==========

  /**
   * L1: Append atomic memory to session's JSONL file
   */
  async appendL1(record: L1Record): Promise<void> {
    const sessionFile = `${STORAGE_PATHS.l1}${record.sessionKey}.jsonl`;
    const line = JSON.stringify(record) + "\n";
    await this.appendFile(sessionFile, line);
  }

  /**
   * L1: Search memories by content (simple full-text scan)
   */
  async searchL1(query: string, limit: number = 10): Promise<L1Record[]> {
    const l1Dir = this.resolve(STORAGE_PATHS.l1);

    // Check if directory exists
    if (!existsSync(l1Dir)) {
      return [];
    }

    // Read all JSONL files in the directory
    let allRecords: L1Record[] = [];
    try {
      const files = readdirSync(l1Dir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = join(l1Dir, file);
        const content = await this.readFile(filePath);
        if (content) {
          const lines = content.split("\n").filter(l => l.trim());
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line) as L1Record;
              allRecords.push(record);
            } catch (e) {
              // Skip malformed lines
            }
          }
        }
      }
    } catch (e) {
      // Directory might not exist
      return [];
    }

    // Filter by query if provided
    if (query) {
      const queryLower = query.toLowerCase();
      allRecords = allRecords.filter(r => r.content.toLowerCase().includes(queryLower));
    }

    // Sort by createdAt descending (newest first)
    allRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return allRecords.slice(0, limit);
  }

  /**
   * L1: Read ALL records across every session JSONL file — no cap, no sort,
   * malformed lines skipped. Used by decay runs which need the full population
   * (recall/search keep their own bounded, sorted views).
   */
  async readAllL1(): Promise<L1Record[]> {
    const l1Dir = this.resolve(STORAGE_PATHS.l1);
    if (!existsSync(l1Dir)) return [];

    const all: L1Record[] = [];
    const files = readdirSync(l1Dir).filter(f => f.endsWith(".jsonl"));
    for (const file of files) {
      const fileSessionKey = file.replace(/\.jsonl$/, "");
      let content: string | null = null;
      try {
        content = readFileSync(join(l1Dir, file), "utf-8");
      } catch {
        continue;
      }
      if (!content) continue;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as L1Record;
          if (rec && typeof rec.id === "string") {
            if (!rec.sessionKey) rec.sessionKey = fileSessionKey;
            all.push(rec);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    return all;
  }

  /**
   * L1: Apply per-record field patches and persist them durably.
   *
   * Each touched session file is rewritten SYNCHRONOUSLY in a single tick
   * (readFileSync → mutate matching lines by id → writeFileSync). This avoids
   * interleaving with concurrent appendL1 appends, which would otherwise lose
   * rows on an async read-modify-write with an await in between.
   *
   * Malformed lines are preserved verbatim; lines whose id does not match any
   * patch are returned unchanged. Absent/empty files are skipped. The patch is
   * intentionally a field-level set — callers decide what it mutates (e.g. only
   * { status } for decay flips, so updatedAt keeps meaning "content changed").
   */
  async persistL1Patches(
    patches: Array<{ sessionKey: string; id: string; patch: Partial<L1Record> }>
  ): Promise<number> {
    if (patches.length === 0) return 0;

    // Group by sessionKey and merge patches hitting the same id
    const grouped = new Map<string, Map<string, Partial<L1Record>>>();
    for (const p of patches) {
      if (!p.sessionKey || !p.id) continue;
      let byId = grouped.get(p.sessionKey);
      if (!byId) {
        byId = new Map();
        grouped.set(p.sessionKey, byId);
      }
      byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...p.patch });
    }

    let applied = 0;
    for (const [sessionKey, byId] of grouped) {
      const filePath = this.resolve(`${STORAGE_PATHS.l1}${sessionKey}.jsonl`);
      if (!existsSync(filePath)) continue;
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let rec: L1Record | null = null;
        try {
          rec = JSON.parse(line) as L1Record;
        } catch {
          continue; // malformed → keep verbatim
        }
        if (!rec || typeof rec.id !== "string") continue;
        const patch = byId.get(rec.id);
        if (!patch) continue;
        Object.assign(rec, patch);
        lines[i] = JSON.stringify(rec);
        byId.delete(rec.id);
        changed = true;
        applied++;
      }
      if (changed) {
        try {
          writeFileSync(filePath, lines.join("\n"), "utf-8");
        } catch {
          // leave as-is; a later decay run can retry
        }
      }
    }
    return applied;
  }

  /**
   * L1: Record a successful recall hit.
   *
   * Bumps retrievalCount and refreshes lastEffectiveAt/lastRetrievedAt — this
   * is what keeps a recalled memory "alive" (Co-Engram LTP is event-driven;
   * recall events are the reinforcement signal). Only status=active rows are
   * bumped; frozen/forgotten are skipped so recall can never resurrect a
   * memory behind the host's back. Debounced per row by `debounceMs` based on
   * the persisted lastRetrievedAt, so repeated hits in a short window don't
   * hammer the disk / inflate counts.
   */
  async bumpL1Recalled(
    hits: Array<{ sessionKey: string; id: string }>,
    debounceMs: number = L1_RECALL_DEBOUNCE_MS
  ): Promise<number> {
    if (hits.length === 0) return 0;

    const grouped = new Map<string, Set<string>>();
    for (const h of hits) {
      if (!h.sessionKey || !h.id) continue;
      if (!grouped.has(h.sessionKey)) grouped.set(h.sessionKey, new Set());
      grouped.get(h.sessionKey)!.add(h.id);
    }

    const now = Date.now();
    let applied = 0;
    for (const [sessionKey, ids] of grouped) {
      const filePath = this.resolve(`${STORAGE_PATHS.l1}${sessionKey}.jsonl`);
      if (!existsSync(filePath)) continue;
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let rec: L1Record | null = null;
        try {
          rec = JSON.parse(line) as L1Record;
        } catch {
          continue;
        }
        if (!rec || typeof rec.id !== "string" || !ids.has(rec.id)) continue;
        if ((rec.status ?? "active") !== "active") {
          ids.delete(rec.id); // never resurrect frozen/forgotten
          continue;
        }
        const lastRetrieved = rec.lastRetrievedAt ?? 0;
        if (now - lastRetrieved < debounceMs) {
          ids.delete(rec.id);
          continue;
        }
        const bumped: L1Record = {
          ...rec,
          retrievalCount: (rec.retrievalCount ?? 0) + 1,
          lastEffectiveAt: now,
          lastRetrievedAt: now,
        };
        lines[i] = JSON.stringify(bumped);
        ids.delete(rec.id);
        changed = true;
        applied++;
      }
      if (changed) {
        try {
          writeFileSync(filePath, lines.join("\n"), "utf-8");
        } catch {
          // leave as-is; a later recall can retry
        }
      }
    }
    return applied;
  }

  // ========== L2 Operations (Markdown files) ==========

  /**
   * L2: Write scene block as Markdown file
   */
  async writeScene(scene: L2Scene): Promise<void> {
    const sceneFile = `${STORAGE_PATHS.l2}${scene.id}.md`;
    const frontmatter = `---
id: ${scene.id}
title: ${scene.title}
summary: ${scene.summary}
tags: ${JSON.stringify(scene.tags)}
created_at: ${scene.createdAt}
updated_at: ${scene.updatedAt}
---

`;
    await this.writeFile(sceneFile, frontmatter + scene.content);
    await this.updateSceneIndex(scene);
  }

  /**
   * L2: Read scene block
   */
  async readScene(sceneId: string): Promise<L2Scene | null> {
    const content = await this.readFile(`${STORAGE_PATHS.l2}${sceneId}.md`);
    if (!content) return null;

    // Parse frontmatter (simplified)
    const lines = content.split("\n");
    const frontmatterEnd = lines.findIndex((l, i) => l === "---" && i > 0);
    if (frontmatterEnd <= 1) return null;

    const frontmatter: Record<string, string> = {};
    for (let i = 1; i < frontmatterEnd; i++) {
      const [key, ...valueParts] = lines[i].split(":");
      if (key && valueParts.length > 0) {
        frontmatter[key.trim()] = valueParts.join(":").trim();
      }
    }

    return {
      id: sceneId,
      title: frontmatter.title || "",
      content: lines.slice(frontmatterEnd + 1).join("\n"),
      summary: frontmatter.summary || "",
      tags: JSON.parse(frontmatter.tags || "[]"),
      metadata: { layer: "L2", heat: 0, sourceRecords: [] },
      createdAt: frontmatter.created_at || "",
      updatedAt: frontmatter.updated_at || "",
    };
  }

  /**
   * L2: Maintain scene index for navigation
   */
  private async updateSceneIndex(scene: L2Scene): Promise<void> {
    const indexFile = STORAGE_PATHS.index.l2;
    let index: Record<string, { id: string; title: string; summary: string; tags: string[] }> = {};

    const existing = await this.readFile(indexFile);
    if (existing) {
      try {
        index = JSON.parse(existing);
      } catch { /* ignore */ }
    }

    index[scene.id] = {
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      tags: scene.tags,
    };

    await this.writeFile(indexFile, JSON.stringify(index, null, 2));
  }

  /**
   * L2: Read scene index for navigation
   */
  async readSceneIndex(): Promise<Array<{ id: string; title: string; summary: string }>> {
    const indexFile = STORAGE_PATHS.index.l2;
    const content = await this.readFile(indexFile);
    if (!content) return [];

    try {
      const index = JSON.parse(content);
      return Object.values(index);
    } catch {
      return [];
    }
  }

  // ========== L3 Operations (persona.md) ==========

  /**
   * L3: Write persona file
   */
  async writePersona(persona: L3Persona): Promise<void> {
    const frontmatter = `---
id: ${persona.id}
created_at: ${persona.createdAt}
updated_at: ${persona.updatedAt}
---

`;
    await this.writeFile(STORAGE_PATHS.l3, frontmatter + persona.content);
  }

  /**
   * L3: Read persona file
   */
  async readPersona(): Promise<L3Persona | null> {
    const content = await this.readFile(STORAGE_PATHS.l3);
    if (!content) return null;

    const lines = content.split("\n");
    const frontmatterEnd = lines.findIndex((l, i) => l === "---" && i > 0);
    if (frontmatterEnd <= 1) return null;

    const frontmatter: Record<string, string> = {};
    for (let i = 1; i < frontmatterEnd; i++) {
      const [key, ...valueParts] = lines[i].split(":");
      if (key && valueParts.length > 0) {
        frontmatter[key.trim()] = valueParts.join(":").trim();
      }
    }

    return {
      id: frontmatter.id || "",
      content: lines.slice(frontmatterEnd + 1).join("\n"),
      summary: "",
      metadata: { layer: "L3", sourceScenes: [] },
      createdAt: frontmatter.created_at || "",
      updatedAt: frontmatter.updated_at || "",
    };
  }
}

// ============================================================================
// Storage factory (sqlite with JSONL fallback)
// ============================================================================

export interface MemoryNewStorageConfig {
  /** "memory" = JSONL/Markdown (default, zero deps). "sqlite" = better-sqlite3 (optionalDependency). */
  backend: "memory" | "sqlite";
  dataDir: string;
}

export interface MemoryStoreInitResult {
  store: MemoryStore;
  backend: "memory" | "sqlite";
  /** Set when backend was requested but a fallback happened (e.g. missing native binary). */
  warning?: string;
}

/**
 * Build a MemoryStore based on config. When sqlite is requested but
 * better-sqlite3 cannot be loaded (missing optionalDependency or native
 * binary mismatch), falls back to the JSONL backend and surfaces a warning
 * so the host (DoctorContract.configRepair) can persist the repair.
 */
export async function createMemoryStore(
  config: MemoryNewStorageConfig
): Promise<MemoryStoreInitResult> {
  const baseDir = config.dataDir ?? "~/.openclaw/memory-new";

  if (config.backend === "sqlite") {
    try {
      // Late import so JSONL-only deployments don't even resolve the module
      const { SqliteStore } = await import("./sqlite-store.js");
      const result = await SqliteStore.tryInit({
        dataDir: baseDir,
        filename: "memory.db",
      });
      if (result.ok) {
        // SqliteStore shares no API surface with MemoryStore yet (only put/get/etc on Engrams).
        // The pipeline still drives the JSONL path through MemoryStore, so we wrap it.
        // Note: SqliteStore is reserved for future migrations; today's recall goes through MemoryStore.
        const memory = new MemoryStore(baseDir);
        return { store: memory, backend: "sqlite" };
      }
      const hint =
        result.code === "MODULE_NOT_FOUND"
          ? "better-sqlite3 optionalDependency not installed. Run `pnpm install` or `npm install` to fetch it."
          : result.code === "NATIVE_BINARY_MISMATCH"
            ? "better-sqlite3 native binary does not match the current Node version. Reinstall with `npm rebuild better-sqlite3` or pin Node version."
            : "SQLite backend failed to initialize.";
      return {
        store: new MemoryStore(baseDir),
        backend: "memory",
        warning: `[memory_new] backend=sqlite requested but fell back to memory: ${hint} (${result.error})`,
      };
    } catch (e: any) {
      return {
        store: new MemoryStore(baseDir),
        backend: "memory",
        warning: `[memory_new] backend=sqlite threw on import: ${e?.message ?? e}. Falling back to memory.`,
      };
    }
  }

  return { store: new MemoryStore(baseDir), backend: "memory" };
}

/**
 * Synchronous variant of createMemoryStore.
 *
 * OpenClaw's plugin loader requires `register()` to be synchronous
 * (see loader-module-runtime.ts:86 — `plugin register must be synchronous`).
 * `createMemoryStore()` is async because better-sqlite3's lazy import is
 * async, but we can keep the storage init lazy in this build: SQLite detection
 * is deferred to first use via SqliteStore.tryInitSync(); for register() we
 * just decide between SQLite and JSONL *presence* by trying a synchronous
 * `createRequire` for the module. If it's resolvable we treat the backend
 * as "sqlite-eligible" but still default to the JSONL MemoryStore instance
 * for actual writes (the pipeline drives JSONL today; SqliteStore is reserved
 * for future migrations).
 */
export function createMemoryStoreSync(
  config: MemoryNewStorageConfig
): MemoryStoreInitResult {
  const baseDir = config.dataDir ?? "~/.openclaw/memory-new";

  if (config.backend === "sqlite") {
    let sqliteImportable = false;
    let importError: string | undefined;
    try {
      // createRequire is the sync sibling of `await import()`. We just need
      // the resolution check here — the actual native handle is opened later,
      // lazily, in SqliteStore.tryInitSync (called from the first write).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = createRequire(import.meta.url);
      // resolve throws if the module is missing; require would throw on the
      // missing native binding. We only care about presence here.
      req.resolve("better-sqlite3");
      sqliteImportable = true;
    } catch (e: any) {
      importError = e?.message ?? String(e);
    }

    if (sqliteImportable) {
      return { store: new MemoryStore(baseDir), backend: "sqlite" };
    }
    return {
      store: new MemoryStore(baseDir),
      backend: "memory",
      warning: `[memory_new] backend=sqlite requested but better-sqlite3 is not installed. ${importError ?? ""} Falling back to memory.`,
    };
  }

  return { store: new MemoryStore(baseDir), backend: "memory" };
}

// ============================================================================
// Recall Result (TDB's RecallResult pattern)
// ============================================================================

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (L2/L3, cacheable) */
  appendSystemContext?: string;
  /** L1 memories with scores + id/sessionKey (so hits can be reinforced) */
  recalledL1Memories?: Array<{
    content: string;
    score: number;
    type: string;
    id: string;
    sessionKey: string;
  }>;
  /** L3 persona raw content */
  recalledL3Persona?: string | null;
  /** Search strategy used */
  recallStrategy?: string;
}

/**
 * Whether an L1 row may be surfaced in recall. Status defaults to "active" for
 * rows written before decay persistence; only frozen/forgotten are excluded —
 * the same default the Co-Engram retrieval filter applies (archived/forgotten
 * are not returned unless explicitly requested).
 */
export function isL1Recallable(r: Pick<L1Record, "status">): boolean {
  const status = r.status ?? "active";
  return status !== "frozen" && status !== "forgotten";
}

const RECALL_LINE_SEPARATOR = "\n";

/**
 * Memory tools usage guide (TDB's MEMORY_TOOLS_GUIDE)
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **memory_get**：获取特定记忆详情。

### 调用次数限制
每轮对话中，记忆搜索工具**合计最多调用 3 次**。
</memory-tools-guide>`;

/**
 * Scene navigation template (TDB's generateSceneNavigation)
 */
function generateSceneNavigation(scenes: Array<{ id: string; title: string; summary: string }>): string {
  if (scenes.length === 0) return "";

  const lines = scenes.map(s =>
    `- [${s.title}](memory://scene/${s.id}): ${s.summary}`
  );

  return `## 情境导航\n${lines.join(RECALL_LINE_SEPARATOR)}`;
}

// ============================================================================
// Recall Engine (TDB's performAutoRecall pattern)
// ============================================================================

export interface RecallEngineOptions {
  hybridSearch?: boolean;
  semanticWeight?: number;
  bm25Weight?: number;
  entityBoostWeight?: number;
}

export class RecallEngine {
  private storage: StorageAdapter;
  private options: RecallEngineOptions;

  constructor(storage: StorageAdapter, options: RecallEngineOptions = {}) {
    this.storage = storage;
    this.options = {
      hybridSearch: options.hybridSearch ?? true,
      semanticWeight: options.semanticWeight ?? 0.5,
      bm25Weight: options.bm25Weight ?? 0.25,
      entityBoostWeight: options.entityBoostWeight ?? 0.25,
    };
  }

  /**
   * Perform recall: search L1 + read L2 + read L3
   * (Reference: TDB's performAutoRecallCore)
   *
   * Uses hybrid search when vector store is available via hybridSearch option.
   */
  async recall(params: {
    query: string;
    sessionKey: string;
    userId: string;
    agentId: string;
    topK?: number;
    vectorStore?: import("../vector/vector-store.js").VectorStore;
    /** Reader's imported agent ids (max 2). Used by filterByScope. */
    importedAgentIds?: string[];
    /** Tighten visibility to self ∪ imported (default true). Set false to fall back to legacy global recall. */
    filterByScope?: boolean;
  }): Promise<RecallResult> {
    const { query, sessionKey, topK = 10, vectorStore } = params;
    const importedAgentIds = params.importedAgentIds ?? [];
    const filterByScope = params.filterByScope !== false; // default true
    const allowedAgents = new Set<string>(
      filterByScope ? [params.agentId, ...importedAgentIds] : [],
    );

    let memories: L1Record[] = [];
    let recallStrategy = "text";

    // 1. Search L1 memories - use hybrid or text search
    if (vectorStore) {
      // First, sync recallable L1 records to the vector store for BM25 search.
      // frozen/forgotten are never indexed so hybrid recall can't resurrect them.
      // When filterByScope is on, ONLY sync self+imported rows so hybrid search
      // can never return a row the scope filter would drop anyway.
      const allL1Records = (await this.storage.searchL1("", 1000))
        .filter(isL1Recallable)
        .filter((r) => !filterByScope || allowedAgents.has(r.agentId ?? "self"));
      vectorStore.syncFromL1Records(allL1Records.map(r => ({
        id: r.id,
        content: r.content,
        metadata: { type: r.type, sceneName: r.sceneName, agentId: r.agentId },
      })));

      // Use hybrid search (BM25 + semantic + entity boost)
      const searchResults = await vectorStore.hybridSearch({
        query,
        topK,
        semanticWeight: this.options.semanticWeight!,
        bm25Weight: this.options.bm25Weight!,
        entityBoostWeight: this.options.entityBoostWeight!,
      });

      // Get full records from search results
      const matchedIds = new Set(searchResults.map(r => r.id));
      memories = allL1Records.filter(r => matchedIds.has(r.id));

      // If hybrid search returned results, use them; otherwise fall back to text search
      if (memories.length > 0) {
        recallStrategy = "hybrid";
      } else {
        memories = await this.storage.searchL1(query, topK);
        recallStrategy = "text";
      }
    } else {
      // Text search fallback
      memories = await this.storage.searchL1(query, topK);
      recallStrategy = "text";
    }

    // 1b. Recallability filter — memories from any strategy must be active-ish.
    memories = memories.filter(isL1Recallable);

    // 1c. Team-scope filter — only rows whose agentId ∈ {self, imported}.
    // Default on (filterByScope !== false). When off, every recallable row is
    // visible (legacy escape hatch).
    if (filterByScope) {
      memories = memories.filter((m) => allowedAgents.has(m.agentId ?? "self"));
    }

    // 2. Read L2 scene navigation
    const sceneIndex = await this.storage.readSceneIndex();

    // 3. Read L3 persona
    const persona = await this.storage.readPersona();

    // Build prependContext (L1 - dynamic, per-turn)
    let prependContext: string | undefined;
    if (memories.length > 0) {
      const memoryLines = memories.map(m =>
        `- [${m.type}] ${m.content}`
      );
      prependContext = `<relevant-memories>
以下是与当前对话相关的记忆：

${memoryLines.join(RECALL_LINE_SEPARATOR)}
</relevant-memories>`;
    }

    // Build appendSystemContext (L2/L3 + tools guide - stable, cacheable)
    const stableParts: string[] = [];

    if (persona) {
      stableParts.push(`<user-persona>
${persona.content}
</user-persona>`);
    }

    if (sceneIndex.length > 0) {
      stableParts.push(`<scene-navigation>
${generateSceneNavigation(sceneIndex)}
</scene-navigation>`);
    }

    if (stableParts.length > 0 || prependContext) {
      stableParts.push(MEMORY_TOOLS_GUIDE);
    }

    const appendSystemContext = stableParts.length > 0
      ? stableParts.join("\n\n")
      : undefined;

    return {
      prependContext,
      appendSystemContext,
      recalledL1Memories: memories.map(m => ({
        content: m.content,
        score: 0.5, // TODO: calculate real score
        type: m.type,
        id: m.id,
        sessionKey: m.sessionKey,
      })),
      recalledL3Persona: persona?.content ?? null,
      recallStrategy,
    };
  }
}

// ============================================================================
// Memory Store (combining all layers)
// ============================================================================

export class MemoryStore {
  private storage: StorageAdapter;
  private recall: RecallEngine;
  private _vectorStore?: import("../vector/vector-store.js").VectorStore;
  private _onL1Stored?: () => void;

  constructor(baseDir: string = "~/.openclaw/memory-new") {
    this.storage = new StorageAdapter(baseDir);
    this.recall = new RecallEngine(this.storage, {
      hybridSearch: true,
      semanticWeight: 0.3,
      bm25Weight: 0.5,
      entityBoostWeight: 0.2,
    });
  }

  // Callback for L1 storage (used by pipeline to trigger L2)
  setOnL1Stored(callback: () => void): void {
    this._onL1Stored = callback;
  }

  private notifyL1Stored(): void {
    if (this._onL1Stored) {
      this._onL1Stored();
    }
  }

  // ========== Vector Store (for semantic search) ==========

  get vectorStore(): import("../vector/vector-store.js").VectorStore | undefined {
    return this._vectorStore;
  }

  setVectorStore(store: import("../vector/vector-store.js").VectorStore): void {
    this._vectorStore = store;
  }

  // ========== L0 Operations ==========

  async ingestMessage(message: Omit<L0Message, "id" | "recordedAt">): Promise<L0Message> {
    const record: L0Message = {
      ...message,
      id: `l0_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      recordedAt: new Date().toISOString(),
    };
    await this.storage.appendL0(record);
    return record;
  }

  async getMessages(sessionKey: string, limit: number = 100): Promise<L0Message[]> {
    return this.storage.readL0(sessionKey, limit);
  }

  /** L0 across all sessions, newest first (for the visualization drill-down). */
  async listL0Recent(limit: number = 200): Promise<L0Message[]> {
    return this.storage.listL0Recent(limit);
  }

  // ========== L1 Operations ==========

  async storeL1(record: Omit<L1Record, "id" | "createdAt" | "updatedAt" | "version">): Promise<L1Record> {
    const now = new Date().toISOString();
    const fullRecord: L1Record = {
      ...record,
      id: `l1_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await this.storage.appendL1(fullRecord);
    this.notifyL1Stored();
    return fullRecord;
  }

  async searchL1(query: string, limit: number = 10): Promise<L1Record[]> {
    return this.storage.searchL1(query, limit);
  }

  /** L1 rows across ALL sessions (uncapped) — the decay run's population. */
  async listAllL1(): Promise<L1Record[]> {
    return this.storage.readAllL1();
  }

  /** Persist per-row field patches (used by decay runs to flip status). */
  async applyDecayStatus(
    updates: Array<{ sessionKey: string; id: string; patch: Partial<L1Record> }>
  ): Promise<number> {
    return this.storage.persistL1Patches(updates);
  }

  /**
   * Reinforce successfully recalled L1 rows (bump count + refresh effective
   * time). Active-only; debounced by L1_RECALL_DEBOUNCE_MS unless overridden.
   */
  async markRecalled(
    hits: Array<{ sessionKey: string; id: string }>,
    debounceMs: number = L1_RECALL_DEBOUNCE_MS
  ): Promise<number> {
    return this.storage.bumpL1Recalled(hits, debounceMs);
  }

  // ========== L2 Operations ==========

  async storeL2(scene: Omit<L2Scene, "id" | "createdAt" | "updatedAt">): Promise<L2Scene> {
    const now = new Date().toISOString();
    const fullScene: L2Scene = {
      ...scene,
      id: `scene_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.writeScene(fullScene);
    return fullScene;
  }

  async getScene(sceneId: string): Promise<L2Scene | null> {
    return this.storage.readScene(sceneId);
  }

  async getSceneIndex(): Promise<Array<{ id: string; title: string; summary: string }>> {
    return this.storage.readSceneIndex();
  }

  // ========== L3 Operations ==========

  async storeL3(persona: Omit<L3Persona, "id" | "createdAt" | "updatedAt">): Promise<L3Persona> {
    const now = new Date().toISOString();
    const fullPersona: L3Persona = {
      ...persona,
      id: `persona_${Date.now()}`,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.writePersona(fullPersona);
    return fullPersona;
  }

  async getPersona(): Promise<L3Persona | null> {
    return this.storage.readPersona();
  }

  // ========== Recall ==========

  async recallMemories(
    query: string,
    sessionKey: string,
    userId: string,
    agentId: string,
    topK?: number,
    importedAgentIds?: string[],
    filterByScope?: boolean,
  ): Promise<RecallResult> {
    return this.recall.recall({ query, sessionKey, userId, agentId, topK, importedAgentIds, filterByScope });
  }
}
