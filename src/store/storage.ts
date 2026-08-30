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
  // Vector embedding stored separately
}

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
  l3: "persona.md",
  index: {
    l2: "memory/scenes/index.json",
    l3: "persona.md.meta",
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
    const filePath = this.resolve(key);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  async writeFile(key: string, content: string): Promise<void> {
    const filePath = this.resolve(key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }

  async appendFile(key: string, content: string): Promise<void> {
    const filePath = this.resolve(key);
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

    console.log(`[DEBUG searchL1] l1Dir: ${l1Dir}`);

    // Check if directory exists
    if (!existsSync(l1Dir)) {
      console.log(`[DEBUG searchL1] Directory does not exist: ${l1Dir}`);
      return [];
    }

    // Read all JSONL files in the directory
    let allRecords: L1Record[] = [];
    try {
      const files = readdirSync(l1Dir).filter(f => f.endsWith('.jsonl'));
      console.log(`[DEBUG searchL1] Found files: ${files}`);

      for (const file of files) {
        const filePath = `${STORAGE_PATHS.l1}${file}`;
        console.log(`[DEBUG searchL1] Reading file: ${filePath}`);
        const content = await this.readFile(filePath);
        if (content) {
          const lines = content.split("\n").filter(l => l.trim());
          const records = lines.map(line => {
            try {
              return JSON.parse(line) as L1Record;
            } catch {
              return null;
            }
          }).filter((r): r is L1Record => r !== null);
          allRecords = allRecords.concat(records);
        }
      }
      console.log(`[DEBUG searchL1] Total records found: ${allRecords.length}`);
    } catch (e) {
      console.log(`[DEBUG searchL1] Error: ${e}`);
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
    const frontmatterEnd = lines.findIndex(l => l === "---", 1);
    if (frontmatterEnd <= 1) return null;

    const frontmatter: Record<string, string> = {};
    for (let i = 1; i < frontmatterEnd; i++) {
      const [key, ...valueParts] = lines[i].split(":");
      if (key && valueParts.length > 0) {
        frontmatter[key.trim()] = valueParts.join(":").trim();
      }
    }

    return {
      id: scene.id,
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
    const frontmatterEnd = lines.findIndex(l => l === "---", 1);
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
// Recall Result (TDB's RecallResult pattern)
// ============================================================================

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (L2/L3, cacheable) */
  appendSystemContext?: string;
  /** L1 memories with scores (for metrics) */
  recalledL1Memories?: Array<{ content: string; score: number; type: string }>;
  /** L3 persona raw content */
  recalledL3Persona?: string | null;
  /** Search strategy used */
  recallStrategy?: string;
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
  }): Promise<RecallResult> {
    const { query, sessionKey, topK = 10, vectorStore } = params;

    let memories: L1Record[] = [];
    let recallStrategy = "text";

    // 1. Search L1 memories - use hybrid or text search
    if (vectorStore && this.options.hybridSearch) {
      // Hybrid semantic search using vector store
      const searchResults = await vectorStore.hybridSearch({
        query,
        topK,
        semanticWeight: this.options.semanticWeight!,
        bm25Weight: this.options.bm25Weight!,
        entityBoostWeight: this.options.entityBoostWeight!,
      });

      // Get full records from storage for matched IDs
      const matchedRecords: L1Record[] = [];
      for (const result of searchResults) {
        const records = await this.storage.searchL1("", 100);
        const record = records.find(r => r.id === result.id);
        if (record) {
          matchedRecords.push(record);
        }
      }
      memories = matchedRecords;
      recallStrategy = "hybrid";
    } else {
      // Text search fallback
      memories = await this.storage.searchL1(query, topK);
      recallStrategy = "text";
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

  constructor(baseDir: string = "~/.openclaw/memory-new") {
    this.storage = new StorageAdapter(baseDir);
    this.recall = new RecallEngine(this.storage);
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
    return fullRecord;
  }

  async searchL1(query: string, limit: number = 10): Promise<L1Record[]> {
    return this.storage.searchL1(query, limit);
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

  async recallMemories(query: string, sessionKey: string, userId: string, agentId: string, topK?: number): Promise<RecallResult> {
    return this.recall.recall({ query, sessionKey, userId, agentId, topK });
  }
}
