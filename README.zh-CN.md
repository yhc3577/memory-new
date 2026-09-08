# @openclaw/memory-new

一个为 OpenClaw 设计的全新分层记忆扩展。

## 安装

```bash
openclaw plugins install @openclaw/memory-new
```

插件会被安装到 `~/.openclaw/npm/projects/yhc3577-memory-new-*/`。
插件**默认不自动启用**可视化——这是刻意为之，因为启动时绑定 TCP 端口
（`127.0.0.1:4123`）可能会让用户感到意外。

## 可选：启用可视化面板

安装后，运行**一次**：

```bash
npx -p @yhc3577/memory-new memory-new-setup
# 或指定 profile：
OPENCLAW_PROFILE=test npx -p @yhc3577/memory-new memory-new-setup
```

它会：
1. 修改 `~/.openclaw/openclaw.json`，写入 `plugins.entries.memory_new.config.visualize = {enabled: true, autoStart: true}`
2. 一次性备份配置到 `openclaw.json.bak`
3. 重启 gateway，让 HTTP 服务在下次启动时生效

面板地址为 `http://127.0.0.1:4123`。使用 `memory-new-setup --reset` 可关闭。

面板为全中文界面，支持：
- **点击统计卡下钻**：点 L0/L1/L2/L3 数量卡即可展开该层完整记忆列表（L0 原始
  消息 / L1 原子记忆 / L2 场景 / L3 人物画像），可切换层级并按关键词过滤；
  L2 场景条目点击可展开正文。
- **人物画像（L3）**：可视化用户画像面板。开启真实写入时读取 `persona.md`；
  未开启（默认 dry-run）时展示 `l3-preview.json` 的预览并提示如何开启。

> **为什么用独立的 CLI bin，而不是 npm postinstall 钩子或 `openclaw` 命令？**
> - OpenClaw 出于安全会用 `npm install --ignore-scripts` 安装插件，所以
>   `package.json` 里的任何 `postinstall` 钩子在 `openclaw plugins install` /
>   `update` 时都会被静默跳过。
> - OpenClaw 的插件命令（`api.registerCommand`）只从聊天通道调度，无法从终端
>   调用——`openclaw memory_new.foo` 永远不会被解析。因此插件通过独立的
>   `bin`（`memory-new-setup`）在 shell 中直接调用同一套逻辑。

## 命令

- `memory_new status` — 查看插件状态
- `memory_new help` — 查看帮助
- `memory_new_visualize start|stop|status` — 独立 HTTP 面板（临时启动，不持久化；仅聊天通道）
- `memory-new-setup [--reset] [--no-restart]` — 在 `openclaw.json` 中持久化或移除 `config.visualize`（终端 CLI）
- `memory_new_verify_hooks` — 多层 E2E 钩子自检
- `memory_new_l3_dry_run` — 预览 L3 persona 会写入什么

## 配置

`openclaw.json` 示例：

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

> 插件私有字段必须放在 `config` 下，因为 `PluginEntrySchema` 是
> `strictObject`，顶层只允许 `enabled / hooks / subagent / llm / config`。

## 记忆流转管道（L0 → L1 → L2 → L3）

记忆通过 `DistillationPipeline` 自底向上蒸馏，经过四个层级：原始对话先变成
原子事实，再聚合成场景，最终沉淀为长期用户画像。

```
                          ┌─────────────────────────────────────────────┐
   会话内容                │             DistillationPipeline            │
 ┌────────────┐  session_end   ┌────────────┐       ┌────────────┐       │
 │  L0        │──────────────▶ │  L1        │──────▶│  L2        │       │
 │  原始消息   │  ingest()      │  原子记忆   │distill│  场景      │       │
 │  (JSONL)   │                │           │  L2   │  (Markdown)│       │
 └────────────┘                └────────────┘       └────────────┘       │
                                       │ distill L3  │  (从高价值场景)    │
                                       ▼              ▼                  │
                                   ┌────────────┐                          │
                                   │  L3        │  persona.md (可选开启)   │
                                   │  用户画像   │                          │
                                   └────────────┘                          │
                          └─────────────────────────────────────────────┘
```

### 层级说明

| 层级 | 内容 | 存储位置 | 触发时机 |
|------|------|---------|---------|
| **L0** | 用户/助手的原始消息 | `l0/<sessionKey>.jsonl` | `session_end` 钩子 → `pipeline.ingest()` |
| **L1** | 原子记忆（`persona` / `episodic` / `instruction`） | `l1/<sessionKey>.jsonl` | `session_end` 上的 `distill("L1")` + 空闲定时器 |
| **L2** | 从 L1 构建的场景摘要 | `scenes/<id>.md` + `index.json` | L1 存储后自动触发 + `session_end` |
| **L3** | 长期用户画像 | `persona.md` | `session_end`，**需手动开启**（见下） |

### 写入路径（session_end）

1. **L0 捕获** — `session_end` 钩子读取会话消息，通过 `MemoryStore.ingestMessage()`
   逐条写入 L0（每条截断到 10k 字符）。
2. **L1 提取** — `DistillationPipeline.distill("L1")` 取缓冲区最后
   `l1.batchSize`（默认 **10**）条消息，拆分为 `newMessages`（最近 5 条）+ 背景消息，
   交给 LLM（subagent runner；未配置 LLM 时用本地 fallback 提取器）产出带
   类型 + 优先级 + 场景名的原子记忆，经 `storeL1()` 写入。
3. **L2 蒸馏** — 通过两种方式触发：
   - 即时触发：`store.setOnL1Stored()`（任何 L1 写入都会触发 `distill("L2")`）；
   - 定时触发：`l2.delayAfterL1Seconds`（默认 **30s**）后，由 `runL1Distillation`
     末尾调度。
   `runL2Distillation()` 将 L1 记录聚合成场景，以 Markdown 写入。
4. **L3 用户画像** — 开启后在 `session_end` 上运行。若
   `layersEnabled.L3 === false`（默认值），则改为运行 **dry-run**：它计算出
   相同的报告并写入 `memory/l3-preview.json`，让你在开启前先预览 `persona.md`
   *可能会写入*什么。要启用真实写入，设置 `layersEnabled.L3 = true`；只有当 L1
   平均优先级超过 `l3.importanceThreshold`（默认 **0.4**）时才会真正生成画像。
5. **记忆衰退** — `session_end` 还会运行 `applyDecayToL1()`：TTL 过期清理、
   Ebbinghaus 新鲜度计算，以及 `draft → active → frozen → forgotten` 状态机。

> L1 空闲定时器（`l1.idleSeconds`，默认 **30s**）保证即使 `session_end` 从未
> 触发（例如长时间运行的会话），也会强制执行提取。

### 存储结构

```
~/.openclaw/memory-new/memory/
├── l0/                # 原始消息，每个 sessionKey 一个 JSONL
├── l1/                # 原子记忆，每个 sessionKey 一个 JSONL
├── scenes/            # L2 场景（Markdown）+ index.json
└── persona.md         # L3 用户画像
```

## 召回过程

召回发生在**每一轮对话**的 `before_prompt_build` 钩子中：在模型看到 prompt
之前，把相关记忆注入进去。

```
 before_prompt_build
        │
        ▼
 ┌─────────────────┐    query = event.prompt[0..200]
 │ RecallEngine.   │
 │   recall()      │
 └────────┬────────┘
          │
          ├─▶ 1. L1 搜索（混合检索或纯文本）
          │        vectorStore.syncFromL1Records(全部 L1)
          │        vectorStore.hybridSearch({ query, topK, weights })
          │        ── BM25 + 语义 + 实体增强（权重：0.5 / 0.3 / 0.2）
          │        回退：StorageAdapter.searchL1(query) 纯文本扫描
          │
          ├─▶ 2. 读取 L2 场景索引（情境导航）
          ├─▶ 3. 读取 L3 用户画像
          │
          └─▶ 构建注入上下文
                 prependContext      → 注入到用户 prompt 之前
                 appendSystemContext → 追加到系统 prompt 之后
```

### 会注入什么

| 块 | 位置 | 内容 |
|----|------|------|
| `<relevant-memories>` | prependContext（每轮动态） | Top-K 命中的 L1 记忆，格式 `- [type] content` |
| `<user-persona>` | appendSystemContext（稳定） | L3 用户画像内容 |
| `<scene-navigation>` | appendSystemContext（稳定） | 场景索引，格式 `- [title](memory://scene/<id>): summary` |
| `<memory-tools-guide>` | appendSystemContext | 引导模型在注入记忆不足时调用 `memory_search` / `memory_get`（每轮最多 3 次） |

```js
// prependContext（用户 prompt 之前）：
<relevant-memories>
以下是与当前对话相关的记忆：

- [persona] 用户喜欢钻研某个领域/技术
- [episodic] 用户昨天讨论了项目X架构
</relevant-memories>

// appendSystemContext（追加到系统 prompt）：
<user-persona>…</user-persona>

<scene-navigation>
- [User Added](memory://scene/scene_xxx): 5 条记忆, 平均优先级 71
- [System](memory://scene/scene_yyy): 2 条记忆, 平均优先级 75
</scene-navigation>

<memory-tools-guide>…</memory-tools-guide>
```

### 关键参数

| 配置 | 默认值 | 含义 |
|------|--------|------|
| `retrieval.hybridSearch` | `true` | 使用 BM25+语义+实体混合检索 |
| `retrieval.semanticWeight` | `0.3` | 语义分数权重 |
| `retrieval.bm25Weight` | `0.5` | BM25 分数权重 |
| `retrieval.entityBoostWeight` | `0.2` | 实体匹配加成权重 |
| `retrieval.topK` | `10` | 每轮最多注入的记忆条数 |

如果 `hybridSearch` 没有命中，召回会回退到对 L1 的纯文本扫描，因此钩子
从不依赖向量后端可用。

## 开发

```bash
pnpm install
pnpm run build
node scripts/publish.mjs
```

## 许可

MIT
