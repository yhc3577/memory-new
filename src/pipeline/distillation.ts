/**
 * Memory Distillation Pipeline with Storage Integration
 *
 * Reference: TDB (TencentDB-Agent-Memory) L0→L1→L2→L3 distillation model
 *
 * This version integrates with:
 * - OpenClaw LLM runtime for L1 extraction via subagent
 * - Vector store for semantic search
 */

import type { Engram, EngramKind, MemoryLayer } from "../index.js";
import { StorageAdapter, MemoryStore, type L0Message, type L1Record, type L2Scene, type L3Persona } from "../store/storage.js";
import { VectorStore } from "../vector/vector-store.js";

export interface DistillationConfig {
  l1: {
    messageThreshold: number;      // Extract after N messages (default: 5)
    idleSeconds: number;         // Or after N seconds of idle (default: 60)
    batchSize: number;           // Max messages per extraction (default: 10)
    enableDedup: boolean;
    maxMemoriesPerSession: number;
  };
  l2: {
    minIntervalMs: number;
    maxIntervalMs: number;
    topicThreshold: number;
    delayAfterL1Seconds: number;
  };
  l3: {
    conditions: Array<"explicit_request" | "cold_start" | "restore" | "first_scene" | "threshold">;
    importanceThreshold: number;
  };
  // LLM extraction config
  llm?: {
    provider?: string;
    model?: string;
  };
}

export const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
  l1: {
    messageThreshold: 5,
    idleSeconds: 60,
    batchSize: 10,
    enableDedup: true,
    maxMemoriesPerSession: 50,
  },
  l2: {
    minIntervalMs: 15 * 60 * 1000,
    maxIntervalMs: 60 * 60 * 1000,
    topicThreshold: 3,
    delayAfterL1Seconds: 90,
  },
  l3: {
    conditions: ["explicit_request", "cold_start", "restore", "first_scene", "threshold"],
    importanceThreshold: 0.6,
  },
};

// ============================================================================
// LLM Prompt Templates (from TDB)
// ============================================================================

const L1_EXTRACTION_SYSTEM_PROMPT = `你是专业的"工作情境切分与团队共享记忆提取专家"。
你的任务是分析工作消息，判断工作情境切换，并从中提取可在团队内共享的结构化工作记忆。

## 输出要求

严格按以下JSON数组格式输出，不要输出任何额外的 Markdown 代码块修饰符（如 \`\`\`json）或解释文本：

[
  {
    "scene_name": "情境名称（简洁，1-10个字）",
    "memories": [
      {
        "content": "记忆内容（完整句子，20-200字）",
        "type": "persona | episodic | instruction",
        "priority": 优先级(0-100, 越高越重要),
        "source_message_ids": ["相关消息ID"],
        "metadata": {}
      }
    ]
  }
]

## Memory Type 定义

- **persona**: 关于用户偏好、习惯、工作方式的记忆（如"用户喜欢在上午处理复杂任务"）
- **episodic**: 具体的项目事件、决策、讨论要点（如"项目X决定使用微服务架构"）
- **instruction**: 用户的明确指令或需求（如"用户要求每周五同步进度"）

## 场景切换判断

当出现以下情况时，应该切换到新场景：
1. 话题发生实质性变化
2. 参与人员发生明显变化
3. 任务目标发生切换
4. 时间间隔超过30分钟`;

function formatExtractionPrompt(
  newMessages: L0Message[],
  backgroundMessages: L0Message[],
  previousSceneName: string
): { systemPrompt: string; userPrompt: string } {
  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map(m => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "无";

  const newText = newMessages
    .map(m => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  const userPrompt = `**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 \`scene_name\` 和 memory \`content\`。

【上一个情境】：${previousSceneName || "无"}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
${newText}`;

  return {
    systemPrompt: L1_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
  };
}

// ============================================================================
// Pipeline with Storage Integration
// ============================================================================

export class DistillationPipeline {
  private config: DistillationConfig;
  private store: MemoryStore;
  private vectorStore: VectorStore;
  private llmRunner?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  private subagentRunner?: (message: string) => Promise<string>;

  private lastL1At: number | null = null;
  private lastL2At: number | null = null;
  private lastL3At: number | null = null;

  private pendingL1Extraction: ReturnType<typeof setTimeout> | null = null;

  // In-memory buffers (TDB uses VectorStore + JSONL)
  private messageBuffer: L0Message[] = [];

  constructor(
    config: DistillationConfig = DEFAULT_DISTILLATION_CONFIG,
    store?: MemoryStore,
    vectorStore?: VectorStore,
    llmRunner?: (systemPrompt: string, userPrompt: string) => Promise<string>
  ) {
    this.config = config;
    this.store = store || new MemoryStore();
    this.vectorStore = vectorStore || new VectorStore();
    this.llmRunner = llmRunner;
  }

  /**
   * Set LLM runner for simple prompt-completion style extraction
   */
  setLLMRunner(runner: (systemPrompt: string, userPrompt: string) => Promise<string>): void {
    this.llmRunner = runner;
  }

  /**
   * Set subagent runner for L1 extraction via OpenClaw subagent runtime
   */
  setSubagentRunner(runner: (message: string) => Promise<string>): void {
    this.subagentRunner = runner;
  }

  /**
   * Set vector store for embedding-based search
   */
  setVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  // ============================================================================
  // Ingestion (L0)
  // ============================================================================

  /**
   * Ingest messages into L0 layer (TDB's captureAtomic pattern)
   */
  async ingest(messages: Array<Omit<L0Message, "id" | "recordedAt">>): Promise<L0Message[]> {
    const records: L0Message[] = [];

    for (const msg of messages) {
      // Quality gate
      if (!shouldExtractL1(msg.content)) continue;

      const record = await this.store.ingestMessage(msg);
      records.push(record);
      this.messageBuffer.push(record);
    }

    // Check L1 trigger
    if (this.messageBuffer.length >= this.config.l1.messageThreshold) {
      await this.triggerL1Extraction();
    } else {
      this.scheduleL1Extraction();
    }

    return records;
  }

  private scheduleL1Extraction(): void {
    if (this.pendingL1Extraction) return;

    this.pendingL1Extraction = setTimeout(async () => {
      this.pendingL1Extraction = null;
      if (this.messageBuffer.length > 0) {
        await this.distill("L1");
      }
    }, this.config.l1.idleSeconds * 1000);
  }

  private async triggerL1Extraction(): Promise<void> {
    if (this.pendingL1Extraction) {
      clearTimeout(this.pendingL1Extraction);
      this.pendingL1Extraction = null;
    }

    await this.distill("L1");
  }

  // ============================================================================
  // Distillation
  // ============================================================================

  async distill(stage: MemoryLayer): Promise<{ stage: MemoryLayer; produced: number; errors: string[] }> {
    switch (stage) {
      case "L1":
        return this.runL1Distillation();
      case "L2":
        return this.runL2Distillation();
      case "L3":
        return this.runL3Distillation();
      default:
        return { stage, produced: 0, errors: ["Unknown stage"] };
    }
  }

  /**
   * L1 Distillation: Extract atomic memories from L0 messages
   * (Reference: TDB's extractL1Memories)
   */
  private async runL1Distillation(): Promise<{ stage: MemoryLayer; produced: number; errors: string[] }> {
    const errors: string[] = [];
    let produced = 0;

    try {
      // Get batch of messages
      const messages = this.messageBuffer.slice(-this.config.l1.batchSize);
      if (messages.length === 0) {
        return { stage: "L1", produced: 0, errors: [] };
      }

      // Get previous scene name for continuity
      const lastScene = await this.getLastSceneName();

      // Split into new + background
      const maxNew = 5;
      const newMessages = messages.slice(-maxNew);
      const backgroundMessages = messages.slice(0, -maxNew);

      // Format prompt
      const { systemPrompt, userPrompt } = formatExtractionPrompt(
        newMessages,
        backgroundMessages,
        lastScene
      );

      // Call LLM via subagent runner, llmRunner, or use fallback
      let extractionOutput = "";
      if (this.subagentRunner) {
        // Use OpenClaw subagent runtime for LLM extraction
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
        extractionOutput = await this.subagentRunner(fullPrompt);
      } else if (this.llmRunner) {
        extractionOutput = await this.llmRunner(systemPrompt, userPrompt);
      } else {
        extractionOutput = this.fallbackExtract(messages, lastScene);
      }

      // Parse output
      const extractedMemories = parseExtractionOutput(extractionOutput);

      // Store L1 records
      for (const mem of extractedMemories) {
        await this.store.storeL1({
          content: mem.content,
          type: mem.type,
          priority: mem.priority,
          sceneName: mem.scene_name,
          sourceMessageIds: mem.source_message_ids,
          metadata: mem.metadata,
          timestamps: messages.map(m => new Date(m.timestamp).toISOString()),
          sessionKey: messages[0]?.sessionKey || "default",
          sessionId: messages[0]?.sessionId || "",
          teamId: messages[0]?.teamId,
          userId: messages[0]?.userId || "",
          agentId: messages[0]?.agentId || "",
        });
        produced++;
      }

      // Clear processed messages
      this.messageBuffer = this.messageBuffer.slice(0, Math.max(0, this.messageBuffer.length - messages.length));

      this.lastL1At = Date.now();

      // Schedule L2 after L1 completes (TDB's delayAfterL1Seconds)
      setTimeout(() => this.distill("L2"), this.config.l2.delayAfterL1Seconds * 1000);

    } catch (e) {
      errors.push(String(e));
    }

    return { stage: "L1", produced, errors };
  }

  private async getLastSceneName(): Promise<string> {
    // Try to get from L1 records
    const recent = await this.store.searchL1("", 1);
    return recent[0]?.sceneName || "无";
  }

  /**
   * L2 Distillation: Cluster L1 memories into scene blocks
   * (Reference: TDB's SceneExtractor)
   */
  private async runL2Distillation(): Promise<{ stage: MemoryLayer; produced: number; errors: string[] }> {
    const errors: string[] = [];
    let produced = 0;

    try {
      // Check time constraints
      const now = Date.now();
      if (this.lastL2At && now - this.lastL2At < this.config.l2.minIntervalMs) {
        return { stage: "L2", produced: 0, errors: ["Too soon since last L2"] };
      }

      // Search all L1 records
      const l1Records = await this.store.searchL1("", 100);
      if (l1Records.length < this.config.l2.topicThreshold) {
        return { stage: "L2", produced: 0, errors: ["Not enough L1 records"] };
      }

      // Group by scene name
      const sceneGroups = new Map<string, typeof l1Records>();
      for (const record of l1Records) {
        if (!sceneGroups.has(record.sceneName)) {
          sceneGroups.set(record.sceneName, []);
        }
        sceneGroups.get(record.sceneName)!.push(record);
      }

      // Create scene blocks
      for (const [sceneName, records] of sceneGroups) {
        if (records.length < this.config.l2.topicThreshold) continue;

        const avgPriority = records.reduce((sum, r) => sum + r.priority, 0) / records.length;
        const content = this.buildSceneContent(sceneName, records);

        await this.store.storeL2({
          title: sceneName,
          content,
          summary: `平均优先级: ${avgPriority.toFixed(0)}`,
          tags: [sceneName],
          metadata: {
            layer: "L2" as const,
            heat: records.length,
            sourceRecords: records.map(r => r.id),
          },
        });
        produced++;
      }

      this.lastL2At = now;

      // Schedule L3 after L2
      setTimeout(() => this.distill("L3"), 5000);

    } catch (e) {
      errors.push(String(e));
    }

    return { stage: "L2", produced, errors };
  }

  private buildSceneContent(sceneName: string, records: L1Record[]): string {
    const points = records.map(r => `- [${r.type}] ${r.content}`).join("\n");
    const avgPriority = records.reduce((sum, r) => sum + r.priority, 0) / records.length;

    return `# ${sceneName}

## Key Points
${points}

## Summary
平均优先级: ${avgPriority.toFixed(0)}
共 ${records.length} 条相关记忆

---
Generated: ${new Date().toISOString()}
`;
  }

  /**
   * L3 Distillation: Build persona from high-value scenes
   * (Reference: TDB's PersonaExtractor)
   */
  private async runL3Distillation(): Promise<{ stage: MemoryLayer; produced: number; errors: string[] }> {
    const errors: string[] = [];
    let produced = 0;

    try {
      // Check if threshold met
      const l1Records = await this.store.searchL1("", 100);
      if (l1Records.length === 0) {
        return { stage: "L3", produced: 0, errors: ["No L1 records"] };
      }

      const avgImportance = l1Records.reduce((sum, r) => sum + r.priority, 0) / l1Records.length / 100;
      if (avgImportance < this.config.l3.importanceThreshold) {
        return { stage: "L3", produced: 0, errors: ["Avg importance below threshold"] };
      }

      // Get high-value scenes
      const sceneIndex = await this.store.getSceneIndex();
      const highValueScenes = sceneIndex.filter(s => {
        const avg = l1Records
          .filter(r => r.sceneName === s.title)
          .reduce((sum, r) => sum + r.priority, 0) / Math.max(1, l1Records.filter(r => r.sceneName === s.title).length);
        return avg >= this.config.l3.importanceThreshold * 100;
      });

      if (highValueScenes.length === 0) {
        return { stage: "L3", produced: 0, errors: ["No high-value scenes"] };
      }

      // Build persona
      const personaContent = this.buildPersona(highValueScenes, l1Records);

      await this.store.storeL3({
        content: personaContent,
        summary: "Agent Self-Model",
        metadata: {
          layer: "L3" as const,
          sourceScenes: highValueScenes.map(s => s.id),
        },
      });

      produced = 1;
      this.lastL3At = Date.now();

    } catch (e) {
      errors.push(String(e));
    }

    return { stage: "L3", produced, errors };
  }

  private buildPersona(
    scenes: Array<{ id: string; title: string; summary: string }>,
    l1Records: L1Record[]
  ): string {
    const sceneContents = scenes.map(scene => {
      const relatedMemories = l1Records.filter(r => r.sceneName === scene.title);
      return `### ${scene.title}\n${relatedMemories.map(m => `- ${m.content}`).join("\n")}`;
    }).join("\n\n");

    const avgImportance = l1Records.reduce((sum, r) => sum + r.priority, 0) / l1Records.length / 100;

    return `# Agent Self-Model

## Core Knowledge
${sceneContents}

## Behavioral Patterns
- 共 ${scenes.length} 个高价值场景
- 平均重要性: ${avgImportance.toFixed(2)}

## Preferences
(从 persona 类型记忆中提取)

## Communication Style
(从交互模式中学习)

---
Generated: ${new Date().toISOString()}
`;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private fallbackExtract(messages: L0Message[], previousSceneName: string): string {
    const contents = messages.map(m => m.content).join("\n");
    const facts: string[] = [];

    // Simple patterns
    const patterns = [
      /(?:decided|决定)(.+)/gi,
      /(?:learned|学习)(.+)/gi,
      /(?:remember|记住)(.+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(contents)) !== null) {
        facts.push(match[1].trim());
      }
    }

    if (facts.length === 0 && messages[0]) {
      const content = messages[0].content;
      if (content.length > 20) {
        facts.push(content.slice(0, 100));
      }
    }

    const sceneName = previousSceneName || "General";

    return JSON.stringify([{
      scene_name: sceneName,
      memories: facts.slice(0, 3).map((content, i) => ({
        content,
        type: "episodic",
        priority: 50 + i * 10,
        source_message_ids: [messages[0]?.id || "unknown"],
        metadata: {},
      })),
    }]);
  }

  checkTriggers(): { l1: boolean; l2: boolean; l3: boolean } {
    const now = Date.now();

    return {
      l1: this.messageBuffer.length >= this.config.l1.messageThreshold,
      l2: this.lastL2At ? now - this.lastL2At >= this.config.l2.minIntervalMs : this.messageBuffer.length >= this.config.l2.topicThreshold,
      l3: this.lastL3At === null,
    };
  }

  async getStats(): Promise<{
    l0Count: number;
    l1Count: number;
    l2Count: number;
    l3Count: number;
  }> {
    const l1Records = await this.store.searchL1("", 1000);
    const l2Scenes = await this.store.getSceneIndex();
    const persona = await this.store.getPersona();

    return {
      l0Count: this.messageBuffer.length,
      l1Count: l1Records.length,
      l2Count: l2Scenes.length,
      l3Count: persona ? 1 : 0,
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function shouldExtractL1(content: string): boolean {
  if (content.length < 10) return false;
  if (content.length > 10000) return false;
  return true;
}

interface ExtractedMemory {
  content: string;
  type: "persona" | "episodic" | "instruction";
  priority: number;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
  scene_name: string;
}

function parseExtractionOutput(output: string): ExtractedMemory[] {
  try {
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      const objMatch = output.match(/\{[\s\S]*\}/);
      if (objMatch) {
        return JSON.parse(objMatch[0]);
      }
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.scene_name) {
      return (parsed.memories || []).map((m: any) => ({
        content: m.content,
        type: normalizeMemoryType(m.type),
        priority: Math.min(100, Math.max(0, Number(m.priority) || 50)),
        source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids : [],
        metadata: m.metadata || {},
        scene_name: parsed.scene_name,
      }));
    }

    const memories: ExtractedMemory[] = [];
    for (const scene of parsed) {
      for (const m of scene.memories || []) {
        memories.push({
          content: m.content,
          type: normalizeMemoryType(m.type),
          priority: Math.min(100, Math.max(0, Number(m.priority) || 50)),
          source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids : [],
          metadata: m.metadata || {},
          scene_name: scene.scene_name,
        });
      }
    }
    return memories;
  } catch (e) {
    console.error("Failed to parse LLM output:", e);
    return [];
  }
}

function normalizeMemoryType(type: string): "persona" | "episodic" | "instruction" {
  const t = type?.toLowerCase();
  if (t === "persona" || t === "episodic" || t === "instruction") {
    return t as "persona" | "episodic" | "instruction";
  }
  return "episodic";
}
