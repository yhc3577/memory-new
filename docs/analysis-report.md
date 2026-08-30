# memory_new 插件功能分析报告

> 生成时间：2026-08-30
> 最后更新：2026-08-30 (Decay + Team Memory 集成完成)

## 一、已实现功能

### 1.1 记忆分层存储 (L0/L1/L2/L3)

| 层级 | 状态 | 说明 |
|------|------|------|
| L0 | ✅ 已实现 | 原始消息 JSONL 存储，`session_end` 钩子触发 |
| L1 | ✅ 已实现 | 原子记忆，搜索/召回核心层 |
| L2 | ✅ 已实现 | 场景记忆，自动从 L1 蒸馏（存储后自动触发） |
| L3 | ✅ 框架有 | 用户画像，从高价值场景构建 |

**存储路径**：`~/.openclaw/memory-new/memory/`

```
memory/
├── l0/           # 原始消息（按 sessionKey 分组）
├── l1/           # 原子记忆（按 sessionKey 分组）
│   ├── default.jsonl
│   └── agent:main:session-id.jsonl
├── scenes/      # L2 场景（Markdown）
│   └── index.json
└── persona.md   # L3 用户画像
```

### 1.2 记忆存储工具 (Tools)

| 工具名 | 状态 | 功能 |
|--------|------|------|
| `mem_new_store` | ✅ | 存储新记忆到 L1 |
| `mem_new_search` | ✅ | 搜索记忆（混合检索） |
| `mem_new_get` | ✅ | 获取特定记忆（支持 L2/L3） |
| `mem_new_distill` | ✅ | 手动触发蒸馏 |

### 1.3 记忆召回钩子 (Hooks)

| 钩子 | 状态 | 功能 |
|------|------|------|
| `before_prompt_build` | ✅ 已注册 | 注入相关记忆到 prompt |
| `session_end` | ✅ | 触发蒸馏 + Decay + L2/L3 |
| `agent_end` | ✅ | 备用消息记录 |

### 1.4 检索系统

| 功能 | 状态 | 说明 |
|------|------|------|
| BM25 文本搜索 | ✅ | 完整实现，包含 IDF 计算 |
| 语义向量搜索 | ✅ | 支持 OpenAI key 或伪向量 fallback |
| 实体增强 | ✅ | 中英文实体提取 + 匹配 |
| 模糊搜索 | ✅ | Levenshtein 距离匹配 |
| 子串搜索 | ✅ | 部分匹配支持 |
| 同义词扩展 | ✅ | 中英文同义词映射 |
| 混合搜索 | ✅ | BM25 + 语义 + 实体 + 模糊 + 子串 |

**混合搜索权重**：
```typescript
semanticWeight: 0.3      // 语义向量
bm25Weight: 0.5         // BM25 (主要)
entityBoostWeight: 0.2  // 实体增强
fuzzyWeight: 0.15       // 模糊匹配
substringWeight: 0.1     // 子串匹配
```

### 1.5 蒸馏管道 (DistillationPipeline)

| 方法 | 状态 | 说明 |
|------|------|------|
| `ingest()` | ✅ | 摄入 L0 消息 |
| `triggerL1Extraction()` | ✅ | 自动触发 L1 蒸馏（带防抖） |
| `runL1Distillation()` | ✅ | L0→L1 原子记忆提取 |
| `runL2Distillation()` | ✅ | L1→L2 场景蒸馏（自动触发） |
| `runL3Distillation()` | ✅ | L1→L3 用户画像（从高价值场景） |

### 1.6 团队记忆 (Team Memory)

| 接口 | 状态 | 说明 |
|------|------|------|
| `GET /memory/team/status` | ✅ | 返回状态、共享数、导入数 |
| `POST /memory/team/share` | ✅ | 共享记忆给团队 |
| `POST /memory/team/import` | ✅ | 从其他 agent 导入记忆 |

**核心类**：`TeamMemoryManager`
- `share()` - 共享记忆
- `import()` - 导入记忆（限制 maxImportedAgents）
- `canAccess()` - 权限检查
- `getSharedEngrams()` / `getImportedEngrams()` - 查询

**Visibility Gate**：
- `public` → `team`, `restricted`, `public`
- `team` → `public`, `restricted`, `team`
- `restricted` → `public`, `team`, `restricted`
- `private` → 任何可见性（禁止反向转换）

### 1.7 记忆衰退 (Decay)

| 机制 | 状态 | 说明 |
|------|------|------|
| TTL 过期 | ✅ | 基于时间戳的安全删除 |
| 重要性衰减 | ✅ | Ebbinghaus 曲线（halflife 计算） |
| 访问频率热度 | ✅ | Hotness = sigmoid(ln(1+count)) × exp(-age/7days) |
| 状态机 | ✅ | draft→active→frozen→forgotten |

**Ebbinghaus 曲线**：
```typescript
halflife = BASE × (importance + 0.1)^1.5 × kindMultiplier
freshness = "fresh" | "aging" | "stale" | "forgotten"
```

**状态转换**：
- `fresh` → 正常
- `aging` → 正常
- `stale` + importance < 0.2 → `frozen`
- `stale` + importance ≥ 0.2 → 正常
- `forgotten` → 删除

### 1.8 CLI 命令

| 命令 | 状态 | 说明 |
|------|------|------|
| `mem add <content>` | ✅ | 添加记忆 |
| `mem list` | ✅ | 列出记忆 |
| `mem search <query>` | ✅ | 搜索记忆 |
| `mem stats` | ✅ | 显示统计 |
| `memory_new_visualize start|stop|status` | ✅ | 独立 HTTP dashboard (127.0.0.1:4123, 默认关闭) |
| `memory_new_visualize_setup [--reset] [--no-restart]` | ✅ | 把 `config.visualize` 持久化到 openclaw.json；plugin 进程内执行，绕开 openclaw 的 `--ignore-scripts` |
| `memory_new_verify_hooks` | ✅ | 三层 E2E 自检（inProcess / injection markers / sideEffects） |
| `memory_new_l3_dry_run` | ✅ | 预览 L3 persona（不写文件，写到 `memory/l3-preview.json`） |

### 1.10 配置持久化机制

**为什么不走 npm postinstall？** OpenClaw 的 [install-managed-npm-state.ts:100](https://example.com) 在执行 `openclaw plugins install|update` 时强制使用 `npm install --ignore-scripts`，任何写在 `package.json > scripts.postinstall` 的钩子都会被静默跳过。

**真正落地的方案**：`memory_new_visualize_setup` 命令在 plugin 进程内直接修改 `~/.openclaw/openclaw.json`，路径：
- 写入 `plugins.entries.memory_new.config.visualize`（必须在 `config` 下面，因为 `PluginEntrySchema` 是 `strictObject`，顶层只允许 `enabled / hooks / subagent / llm / config`）
- 原子写（tmp + rename）
- 一次性 `.bak` 备份
- 调用 `openclaw gateway restart`（除非 `--no-restart`）
- 幂等（已配置则 no-op）

### 1.9 可视化（HTTP dashboard）

| 端点 | 说明 |
|------|------|
| `GET /` | 单文件 HTML dashboard（内嵌 SVG + vanilla JS，零依赖） |
| `GET /api/health` | 后端 / 数据目录 / 端口 / uptime |
| `GET /api/stats` | L0/L1/L2/L3 计数 + decay 汇总 |
| `GET /api/scenes` | L2 scene 索引 |
| `GET /api/decay-stats` | decayLogger.getStats() 全量 |
| `GET /api/decay-logs` | 最近 100 条状态转换 |
| `GET /api/l1?limit=N` | 最近 L1 记录 |
| `GET /api/recall?q=...` | 注入契约验证（断言 `<relevant-memories>` / `<user-persona>` / `<scene-navigation>`） |
| `GET /api/l3-preview` | L3 dry-run 报告 |
| `GET /api/scene-graph` | SVG 关系图 nodes/edges 数据 |

**Dashboard 内容**：
- 4 张统计卡（L0/L1/L2/L3）
- Decay 衰退理由分布 SVG bar
- 状态转换 (active→forgotten 等) SVG bar
- 场景关系图（L2 节点 → L1 边）
- Recall 注入测试框（输入 query → 实时查 → 显示 markers）
- L3 dry-run 预览面板
- 最近 L1 记忆列表

**启动方式**：
- CLI：`memory_new_visualize start`
- 配置：`openclaw.plugin.json` 设 `visualize.enabled=true` + `autoStart=true`
- 环境变量：`MEMORY_NEW_PORT=5000` 自定义端口

---

## 二、最近更新 (2026-08-30)

### 2.1 Decay 集成到 session_end

- `session_end` 钩子触发时自动应用 decay
- TTL 清理 + 状态机转换
- 日志记录删除/冻结数量

### 2.2 Team Memory HTTP 接口完善

- `GET /memory/team/status` - 返回完整状态
- `POST /memory/team/share` - 共享记忆
- `POST /memory/team/import` - 导入记忆

### 2.3 检索系统完善

- 新增文本记录支持（`addTextRecords`）
- BM25 优化 IDF 计算
- 模糊搜索 + 子串搜索
- 同义词扩展

---

## 三、配置现状

### 3.1 插件配置 (`~/.openclaw-test/openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "memory-core": { "enabled": false },
      "memory_new": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

### 3.2 记忆插件配置 (DEFAULT_CONFIG)

```typescript
{
  enabled: true,
  layersEnabled: { L0: true, L1: true, L2: true, L3: false },
  retrieval: {
    hybridSearch: true,
    semanticWeight: 0.3,
    bm25Weight: 0.5,
    entityBoostWeight: 0.2,
    topK: 10,
  },
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
}
```

---

## 四、待实现 / 问题

| 功能 | 优先级 | 状态 | 说明 |
|------|--------|------|------|
| before_prompt_build 验证 | 高 | ✅ 已完成 | `memory_new_verify_hooks` CLI 函数 + 自测机制 |
| 团队记忆同步 | 中 | ✅ 已完成 | `TeamEventStore` 事件日志 + `readEvents`/`getLatestState` |
| 衰退可视化 | 低 | ✅ 已完成 | `StateTransitionLogger` + `decayLogger` 全局实例 |

---

## 五、最近更新 (2026-08-30 下午)

### 5.1 Hook 验证机制
- 新增 `verifyHooks()` 函数用于运行时验证钩子是否正常工作
- 通过 `recall.recall()` 测试查询验证 `before_prompt_build` 钩子
- 暴露 `memory_new_verify_hooks` CLI 函数

### 5.2 团队事件同步
- `TeamEventStore` 类支持多机器事件日志同步
- `append()` 方法追加事件到每日分片文件
- `readEvents()` 方法读取日期范围内的所有事件
- `getLatestState()` 获取指定记忆的最新状态

### 5.3 衰退可视化
- 新增 `StateTransitionLogger` 类记录所有状态转换
- 全局 `decayLogger` 实例 (`decayLogger.getStats()`)
- `applyDecayBatch` 和 `applyTTLCleanup` 集成日志记录
- 记录原因: `ttl` | `importance` | `access_frequency` | `manual` | `reinforcement`

---

## 六、文件结构

```
memory_new/
├── index.ts                    # 插件入口
├── openclaw.plugin.json        # 插件清单
├── package.json
├── scripts/
│   ├── build.mjs               # 构建脚本
│   └── test.mjs                # 自动化测试 (18 个测试)
├── src/
│   ├── store/
│   │   ├── storage.ts          # 存储适配器 + MemoryStore
│   │   └── index.ts
│   ├── pipeline/
│   │   └── distillation.ts     # 蒸馏管道 (L1/L2/L3)
│   ├── vector/
│   │   └── vector-store.ts     # 向量存储 + BM25 + 模糊搜索
│   ├── decay/
│   │   └── decay.ts            # 衰退计算 + 状态转换日志
│   └── team/
│       └── team-memory.ts      # 团队记忆 + 事件同步
├── dist/                       # 编译输出
└── docs/
    └── analysis-report.md      # 本报告
```

---

## 七、自动化测试

运行: `npm test` (18 个测试全部通过)

| 测试类别 | 测试项 | 状态 |
|----------|--------|------|
| Storage | L1 读写 | ✅ |
| Storage | L2 场景 | ✅ |
| Storage | L3 画像 | ✅ |
| Vector | BM25 搜索 | ✅ |
| Vector | 模糊搜索 | ✅ |
| Vector | 子串搜索 | ✅ |
| Vector | 混合搜索 | ✅ |
| Vector | 伪向量生成 | ✅ |
| Distillation | L2 场景蒸馏 | ✅ |
| Distillation | 统计信息 | ✅ |
| Decay | Ebbinghaus 新鲜度 | ✅ |
| Decay | 热度计算 | ✅ |
| Decay | 状态机转换 | ✅ |
| Decay | 状态转换日志 | ✅ |
| Decay | 日志集成 | ✅ |
| Team | 事件存储 | ✅ |
| Team | 共享与访问 | ✅ |
| Team | 导入限制 | ✅ |
