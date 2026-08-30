# Memory New - OpenClaw Memory Plugin 开发指南

本文档详细介绍 Memory New 插件的设计与实现，参考 TDB (TencentDB-Agent-Memory) 架构。

## 概述

Memory New 是一个多层级记忆系统，具有以下核心能力：

- **记忆分层**: L0(原始) → L1(原子) → L2(场景) → L3(Persona)
- **持久化存储**: SQLite/JSONL + Markdown 文件
- **混合检索**: L1 搜索 + L2 场景导航 + L3 Persona
- **衰退机制**: TTL + 重要性驱动半衰期 + 访问频率 + 状态机
- **团队记忆**: Visibility ACL + borrow/import 限额 + 冲突仲裁

---

## 目录

- [项目结构](#项目结构)
- [记忆分层](#记忆分层)
- [存储架构](#存储架构)
- [蒸馏管线](#蒸馏管线)
- [召回流程](#召回流程)
- [团队记忆](#团队记忆)
- [插件 API](#插件-api)
- [配置参考](#配置参考)

---

## 项目结构

```
memory_new/
├── src/
│   ├── store/
│   │   ├── storage.ts      # 存储适配器 + MemoryStore + RecallEngine
│   │   └── sqlite-store.ts # SQLite FTS5 (预留)
│   ├── pipeline/
│   │   └── distillation.ts  # L0→L1→L2→L3 蒸馏管线
│   ├── team/
│   │   └── team-memory.ts  # 团队记忆 + 冲突仲裁
│   └── decay/
│       └── decay.ts        # 衰退机制
├── index.ts                # 插件入口
├── openclaw.plugin.json    # 插件配置
└── package.json
```

---

## 记忆分层

### L0: 原始对话

| 属性 | 说明 |
|------|------|
| 存储 | JSONL (append-only) |
| 路径 | `memory/l0/{sessionKey}.jsonl` |
| 触发 | 实时追加 |
| 内容 | user/assistant 消息原文 |

```
[user] 今天讨论项目X，决定用微服务架构
[assistant] 好的，我记录一下
[user] 记得发周报
```

### L1: 原子记忆

| 属性 | 说明 |
|------|------|
| 存储 | JSONL (append-only) |
| 路径 | `memory/l1/{sessionKey}.jsonl` |
| 触发 | 5条消息 或 60秒空闲 |
| LLM | 情境切分 + 记忆提取 |

```json
{
  "id": "l1_1234567890_abc",
  "content": "项目X决定采用微服务架构",
  "type": "episodic",
  "priority": 85,
  "sceneName": "项目X架构决策",
  "sourceMessageIds": ["msg_001"],
  "createdAt": "2024-01-15T10:00:00Z"
}
```

**Memory Type**:
- `persona`: 用户偏好、习惯
- `episodic`: 项目事件、决策
- `instruction`: 明确指令或需求

### L2: 场景块

| 属性 | 说明 |
|------|------|
| 存储 | Markdown + YAML frontmatter |
| 路径 | `memory/scenes/{id}.md` |
| 触发 | 15分钟后 + 至少3个相关L1 |
| 内容 | L1 按主题聚类的摘要文档 |

```markdown
---
id: scene_001
title: 项目X架构决策
summary: 团队决定采用微服务架构
tags: ["架构", "项目X"]
created_at: 2024-01-15T10:00:00Z
---

# 项目X架构决策

## Key Points
- [episodic] 项目X决定采用微服务架构
- [instruction] 用户要求每周发周报

## Summary
平均优先级: 77
共 5 条相关记忆
```

### L3: Persona

| 属性 | 说明 |
|------|------|
| 存储 | Markdown + YAML frontmatter |
| 路径 | `persona.md` |
| 触发 | 平均重要性 ≥ 0.6 |
| 内容 | Agent 自我模型 |

```markdown
---
id: persona_001
created_at: 2024-01-15T10:00:00Z
updated_at: 2024-01-20T14:00:00Z
---

# Agent Self-Model

## Core Knowledge
### 项目X架构决策
- 项目X决定采用微服务架构

## Behavioral Patterns
- 共 3 个高价值场景
- 平均重要性: 0.72

## Preferences
(从 persona 类型记忆中提取)
```

---

## 存储架构

### StorageAdapter

TDB 模式的统一存储接口：

```typescript
import { StorageAdapter } from "./src/store/storage.ts";

const storage = new StorageAdapter("~/.openclaw/memory-new");

// L0 操作
await storage.appendL0(message);      // 追加消息
await storage.readL0(sessionKey);     // 读取消息

// L1 操作
await storage.appendL1(record);       // 追加记忆
await storage.searchL1(query);       // 搜索记忆

// L2 操作
await storage.writeScene(scene);      // 写入场景
await storage.readScene(id);          // 读取场景
await storage.readSceneIndex();       // 读取场景索引

// L3 操作
await storage.writePersona(persona); // 写入 Persona
await storage.readPersona();          // 读取 Persona
```

### MemoryStore

高层存储接口，整合所有操作：

```typescript
import { MemoryStore } from "./src/store/storage.ts";

const store = new MemoryStore();

// L0
await store.ingestMessage(msg);       // 摄入消息
await store.getMessages(sessionKey);   // 获取消息

// L1
await store.storeL1(record);          // 存储记忆
await store.searchL1(query);         // 搜索记忆

// L2
await store.storeL2(scene);           // 存储场景
await store.getScene(id);             // 获取场景
await store.getSceneIndex();          // 获取场景索引

// L3
await store.storeL3(persona);        // 存储 Persona
await store.getPersona();            // 获取 Persona
```

### 文件结构

```
~/.openclaw/memory-new/
├── memory/
│   ├── l0/
│   │   └── session_001.jsonl      # L0 原始消息
│   ├── l1/
│   │   └── session_001.jsonl     # L1 原子记忆
│   └── scenes/
│       ├── index.json             # L2 场景索引
│       └── scene_001.md          # L2 场景 Markdown
└── persona.md                     # L3 Persona
```

---

## 蒸馏管线

### 流程图

```
消息输入
    ↓
ingest() → Storage.appendL0() → JSONL 文件
    ↓
L1 触发 (5条消息 或 60秒空闲)
    ↓
runL1Distillation()
    ├─ formatExtractionPrompt() → LLM
    ├─ parseExtractionOutput() → ExtractedMemory[]
    └─ Storage.storeL1() → JSONL 文件
    ↓
L2 触发 (15分钟后)
    ↓
runL2Distillation()
    ├─ Storage.searchL1() → 读取 L1
    ├─ 按 sceneName 分组
    └─ Storage.storeL2() → Markdown 文件
    ↓
L3 触发 (avgImportance ≥ 0.6)
    ↓
runL3Distillation()
    ├─ Storage.getSceneIndex() → 读取 L2
    └─ Storage.storeL3() → persona.md
```

### LLM Prompt (来自 TDB)

**System Prompt**:
```
你是专业的"工作情境切分与团队共享记忆提取专家"。
你的任务是分析工作消息，判断工作情境切换，并从中提取可在团队内共享的结构化工作记忆。
```

**User Prompt**:
```
【上一个情境】：{previousSceneName}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
{backgroundMessages}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】：
{newMessages}
```

### 使用示例

```typescript
import { DistillationPipeline, DEFAULT_DISTILLATION_CONFIG } from "./src/pipeline/distillation.ts";
import { MemoryStore } from "./src/store/storage.ts";

const store = new MemoryStore("~/.openclaw/memory-new");

const pipeline = new DistillationPipeline(
  DEFAULT_DISTILLATION_CONFIG,
  store,
  async (systemPrompt, userPrompt) => {
    // 调用 LLM
    const response = await llm.complete(`${systemPrompt}\n\n${userPrompt}`);
    return response.text;
  }
);

// 摄入消息
await pipeline.ingest([
  {
    role: "user",
    content: "今天讨论了项目X架构，决定用微服务",
    sessionKey: "session_001",
    sessionId: "sid_001",
    userId: "user_001",
    agentId: "agent_001",
    timestamp: Date.now(),
  }
]);

// 触发蒸馏
await pipeline.distill("L1");
```

---

## 召回流程

### RecallEngine

TDB 模式的召回引擎：

```typescript
const recall = new RecallEngine(storage);

const result = await recall.recall({
  query: "项目X",
  sessionKey: "session_001",
  userId: "user_001",
  agentId: "agent_001",
});
```

### 返回结构

```typescript
interface RecallResult {
  // L1 记忆 (动态, 每轮变化)
  prependContext?: string;

  // L2/L3 + 工具指南 (稳定, 可缓存)
  appendSystemContext?: string;

  // 结构化记忆 (用于指标)
  recalledL1Memories?: Array<{
    content: string;
    score: number;
    type: string;
  }>;

  // Persona 内容
  recalledL3Persona?: string | null;

  // 搜索策略
  recallStrategy?: string;
}
```

### 召回内容示例

```
<prependContext>
<relevant-memories>
以下是与当前对话相关的记忆：

- [episodic] 项目X决定采用微服务架构
- [instruction] 用户要求每周五同步进度
</relevant-memories>
</prependContext>

<appendSystemContext>
<user-persona>
# Agent Self-Model
## Core Knowledge
### 项目X架构决策
- 项目X决定采用微服务架构
</user-persona>

<scene-navigation>
## 情境导航
- [项目X架构决策](memory://scene/scene_001): 团队决定采用微服务架构
</scene-navigation>

<memory-tools-guide>
## 记忆工具调用指南
...
</memory-tools-guide>
</appendSystemContext>
```

---

## 团队记忆

### Visibility 层级

```
public → team → restricted → private
```

### Visibility Gate

**禁止**: 任何非 private → private (会变成隐性删除)

```typescript
validateVisibilityTransition(from, to) {
  if (from === to) return true;
  if (to === "private" && from !== "private") return false;
  return true;
}
```

### Borrow/Import 限额

```typescript
MAX_IMPORTED_AGENTS = 2;  // 最多借入 2 个 agent 的记忆
```

### 3阶段冲突仲裁

| 阶段 | 条件 | 处理 |
|------|------|------|
| 1. Auto | confidence ≥ 0.8 | LLM 自动裁决 |
| 2. Escalate | confidence < 0.8 | 升级归属人 |
| 3. Timeout | 7 天后 | 自动归档 |

---

## 插件 API

### 命令

| 命令 | 说明 |
|------|------|
| `memory add <content>` | 添加记忆 |
| `memory search <query>` | 搜索记忆 |
| `memory list` | 列出最近记忆 |
| `memory reinforce <id>` | LTP 强化 |
| `memory decay` | 应用衰退 |
| `team-memory share <id>` | 共享记忆 |
| `team-memory import <agentId>` | 借入记忆 |
| `team-memory status` | 团队状态 |

### 工具

| 工具 | 说明 |
|------|------|
| `memory_search` | 程序化搜索 |
| `memory_store` | 存储记忆 |
| `memory_get` | 获取特定记忆 |

### HTTP 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/memory/team/status` | 团队记忆状态 |
| POST | `/memory/team/share` | 共享记忆 |
| POST | `/memory/team/import` | 借入记忆 |

---

## 配置参考

```json
{
  "enabled": true,

  "layersEnabled": {
    "L0": true,
    "L1": true,
    "L2": true,
    "L3": false
  },

  "decay": {
    "ttl": {
      "enabled": true,
      "retentionDays": 30,
      "safetyThreshold": 0.8,
      "minRetainL0": 50,
      "minRetainL1": 20
    },
    "importance": {
      "enabled": true,
      "baseHalflifeDays": 50
    },
    "accessFrequency": {
      "enabled": true
    },
    "stateMachine": {
      "enabled": true
    }
  },

  "teamMemory": {
    "enabled": true,
    "maxImportedAgents": 2,
    "visibilityGate": true
  },

  "retrieval": {
    "hybridSearch": true,
    "semanticWeight": 0.5,
    "bm25Weight": 0.25,
    "entityBoostWeight": 0.25,
    "topK": 10,
    "overFetch": 4
  },

  "storage": {
    "backend": "sqlite",
    "dataDir": "~/.openclaw/memory-new"
  }
}
```

---

## 研究参考

本设计参考以下系统：

| 系统 | 参考点 |
|------|--------|
| TDB | L0-L3 蒸馏 + 存储架构 + 召回流程 |
| mem0 | 混合检索管线 + 元数据 DSL |
| dsh | 单 commit gate + 写后批 + 强制 flush |
| Co-Engram | 四轴分类 + Ebbinghaus 衰退 + visibility gate + 冲突仲裁 |

---

## 文件索引

| 文件 | 说明 |
|------|------|
| [index.ts](../index.ts) | 插件入口 |
| [src/store/storage.ts](../src/store/storage.ts) | 存储 + 召回 |
| [src/pipeline/distillation.ts](../src/pipeline/distillation.ts) | 蒸馏管线 |
| [src/team/team-memory.ts](../src/team/team-memory.ts) | 团队记忆 |
| [src/decay/decay.ts](../src/decay/decay.ts) | 衰退机制 |
| [openclaw.plugin.json](../openclaw.plugin.json) | 插件配置 |
