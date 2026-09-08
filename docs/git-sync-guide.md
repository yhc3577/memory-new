# memory-new 项目 Git 同步操作手册

> 适用场景：把本地项目代码同步到 GitHub 仓库 `yhc3577/memory-new`
> 记录时间：2026-08-30
> Git 版本：2.53.0

---

## 一、背景与目标

本地有一个开发完成的 OpenClaw 记忆插件（`memory-new`），需要推送到
`https://github.com/yhc3577/memory-new`。

实际遇到的两个典型问题：

1. **HTTPS 通道被网络阻断**：`github.com:443` 超时，无法用 `https://` 形式的
   remote 推送，但 SSH 通道（22 端口）可达。
2. **远程仓库非空**：GitHub 创建仓库时自动生成了 `LICENSE` + `README.md`
   模板（"Initial commit"），本地又是全新历史，直接推送会被拒绝。

下文按「排查 → 提交 → 合并 → 推送」四阶段，逐一详解本次使用的每条 Git 命令。

---

## 二、核心概念速览

| 概念 | 说明 |
|------|------|
| `remote` | 远程仓库地址，默认命名为 `origin` |
| `分支 branch` | 本地 `main`、远程 `origin/main` |
| `工作区` | 磁盘上实际的文件 |
| `暂存区 (index)` | `git add` 后的待提交集合 |
| `HEAD` | 当前分支最新一次提交 |
| `跟踪分支` | 本地分支与远程分支的对应关系（`-u` 建立） |

---

## 三、命令详解

### 阶段 1：状态诊断（只读命令）

#### 1. `git remote -v`

```bash
git remote -v
```

**用途**：查看当前配置的远程仓库地址。

**实际输出**：

```
origin	git@github.com:yhc3577/memory-new.git (fetch)
origin	git@github.com:yhc3577/memory-new.git (push)
```

**要点**：`-v` 显示完整 URL（不加只显示名字）。当时为**空**——说明本地仓库
还没有关联远程，这是后续 `git remote add` 的原因。

---

#### 2. `git status --short`

```bash
git status --short
```

**用途**：快速查看工作区改动。`--short` 每行一个文件，首列字母含义：

| 符号 | 含义 |
|------|------|
| `M` | 已修改（modified） |
| `D` | 已删除（deleted） |
| `A` | 已新增（added，已暂存） |
| `??` | 未跟踪（untracked，还没 `git add`） |

**实际输出（片段）**：

```
 M README.md
 M index.ts
 M openclaw.plugin.json
?? .codegraph/
?? docs/analysis-report.md
?? scripts/test.mjs
```

**要点**：首列空白 + 第二列 `M` = 已修改但未暂存；`??` = 全新文件。

---

#### 3. `git ls-files`

```bash
git ls-files dist node_modules
```

**用途**：查看指定路径下**已被 Git 跟踪**的文件。

**实际输出**：

```
（空）
```

**要点**：`dist/`（构建产物）和 `node_modules/`（依赖）已被 `.gitignore` 忽略，
不在版本控制内——这是正确做法，构建产物不应入库。

---

#### 4. 排查网络（辅助命令）

```bash
git config --global --get http.proxy   # 查看全局 HTTP 代理
env | grep -i proxy                     # 查看环境变量代理
```

**用途**：`git fetch` 报 `GnuTLS recv error` 时，先确认是否有代理配置。

---

### 阶段 2：远程仓库配置

#### 5. `git remote add`

```bash
git remote add origin https://github.com/yhc3577/memory-new.git
```

**用途**：添加远程仓库，命名为 `origin`（Git 惯例名）。

**参数**：
- `origin`：远程仓库的别名
- `https://github.com/yhc3577/memory-new.git`：远程地址（HTTPS 形式）

---

#### 6. `git remote set-url`（关键修复）

```bash
git remote set-url origin git@github.com:yhc3577/memory-new.git
```

**用途**：**替换**远程地址，不改别名。HTTPS 的 `github.com:443` 被网络阻断，
改用 SSH 协议（走 22 端口）。

**两种地址形式对比**：

```
HTTPS:  https://github.com/yhc3577/memory-new.git   ← 443 端口，需 token/密码
SSH:    git@github.com:yhc3577/memory-new.git        ← 22 端口，用 SSH key
```

**验证**：`ssh -T git@github.com` 返回 `Hi yhc3577! You've successfully
authenticated` 即说明 SSH key 已生效。

> **排查依据**：`/dev/tcp/github.com/443` 超时（阻断），而
> `/dev/tcp/github.com/22` 连通 → 走 SSH。

---

#### 7. `git ls-remote`

```bash
git ls-remote origin
```

**用途**：只读查看远程仓库的分支与提交引用，**不下载内容**。

**实际输出**：

```
3b19b8f542a8e985c3f94e067f3477d3333aa266	HEAD
3b19b8f542a8e985c3f94e067f3477d3333aa266	refs/heads/main
```

**要点**：发现远程 `main` 已有一个 commit（`3b19b8f`），这就是后续需要
`merge --allow-unrelated-histories` 的原因。

---

### 阶段 3：提交本地改动

#### 8. `git add -A`

```bash
git add -A
```

**用途**：暂存**所有**改动，包括：
- 修改的文件（`M`）
- 新增的文件（`A` / `??`）
- 删除的文件（`D`）

**其他形式**：
- `git add .`：暂存当前目录及子目录（不包含删除）
- `git add <文件>`：暂存单个文件

---

#### 9. `git diff --cached --name-only`

```bash
git diff --cached --name-only
```

**用途**：预览**已暂存**的文件名（不显示内容）。

**参数**：`--cached`（或 `--staged`）= 只看暂存区；`--name-only` = 只列文件名。

---

#### 10. `git commit -m`

```bash
git commit -m "feat: memory-new plugin - multi-layer memory with decay, team memory, and visualization

- L0/L1/L2/L3 layered memory storage (JSONL with optional SQLite backend)
- Hybrid retrieval (BM25 + semantic + entity boost + fuzzy + substring)
- ..."
```

**用途**：把暂存区内容固化为一次提交。

**要点**：
- `-m` 直接给提交信息；多行用 `$(cat <<'EOF' ... EOF)` 传参
- 提交信息规范：`type: 描述`（`feat`=新功能，`fix`=修复，`chore`=杂务）
- 本次附加 `Co-Authored-By: Claude Code` 协作署名

---

### 阶段 4：分支对齐与合并

#### 11. `git branch -m`

```bash
git branch -m master main
```

**用途**：把本地分支从 `master` **重命名**为 `main`，与 GitHub 默认分支一致。

**要点**：`-m`（move）原地改名，不改变提交历史。

---

#### 12. `git fetch`

```bash
git fetch origin
```

**用途**：把远程最新提交下载到本地跟踪分支 `origin/main`（不改动工作区）。

**实际输出**：

```
来自 github.com:yhc3577/memory-new
 * [新分支]          main       -> origin/main
```

**对比**：`git pull` = `fetch` + `merge`；`fetch` 更安全，先看再合。

---

#### 13. `git log origin/main --oneline`

```bash
git log origin/main --oneline
```

**用途**：查看远程 `origin/main` 分支的提交历史。

**实际输出**：

```
3b19b8f Initial commit
```

**要点**：确认远程只有一个模板 commit。

---

#### 14. `git ls-tree -r --name-only origin/main`

```bash
git ls-tree -r --name-only origin/main
```

**用途**：列出远程 `origin/main` 所包含的文件。

**实际输出**：

```
LICENSE
README.md
```

**要点**：确认远程是 GitHub 自动生成的模板（LICENSE + README）。

---

#### 15. `git merge --allow-unrelated-histories`

```bash
git merge origin/main --allow-unrelated-histories --no-edit
```

**用途**：把远程 `origin/main` 合并进本地 `main`。

**关键参数**：
- `--allow-unrelated-histories`：**必需**。本地与远程是两段无关历史
  （unrelated histories），Git 默认拒绝合并，必须显式放行。
- `--no-edit`：使用默认合并信息，不弹编辑器。

**合并结果**：
- 远程的 `LICENSE` 自动并入 ✅
- 远程的 `README.md` 与本地 `README.md` **冲突**（两边都新增）

---

#### 16. 解决冲突：`git checkout --ours` / `--theirs`

```bash
git checkout --ours README.md
```

**用途**：README.md 冲突时，`--ours` = 保留**当前分支（本地）**版本，
丢弃远程模板版本。

**参数语义**（合并中）：
- `--ours`：当前分支（HEAD，本地）的版本
- `--theirs`：被合并分支（远程）的版本

**要点**：选择依据——本地 README 是完整插件文档（约 90 行），远程只是一行
描述，保留本地更有价值。`LICENSE` 则两边不冲突，自动保留。

**补充**：也可手动编辑冲突文件（删除 `<<<<<<< / ======= / >>>>>>>` 标记后
保留所需内容），再 `git add`。

---

#### 17. 提交合并结果

```bash
git add README.md LICENSE
git commit -m "merge: keep local plugin README, retain remote LICENSE"
```

**用途**：暂存冲突解决结果并生成 **merge commit**（一个双亲提交，记录合并动作）。

---

### 阶段 5：推送与验证

#### 18. `git push -u`

```bash
git push -u origin main
```

**用途**：推送本地 `main` 到远程 `main`。

**关键参数**：`-u`（`--set-upstream`）——**建立跟踪关系**，之后直接 `git push`
/ `git pull` 不再需要指定远程和分支。

**实际输出**：

```
To github.com:yhc3577/memory-new.git
   3b19b8f..469069e  main -> main
分支 'main' 设置为跟踪 'origin/main'。
```

**要点**：`3b19b8f..469069e` 表示远程从模板 commit 前进到合并后 commit。

---

#### 19. `git status -sb`

```bash
git status -sb
```

**用途**：`-s`（short）+ `-b`（branch）——一行显示分支与远程同步状态。

**实际输出**：

```
## main...origin/main
```

**要点**：`## main...origin/main` 且无 `[ahead N]` / `[behind N]` 后缀 =
本地与远程**完全同步**。

---

## 四、完整操作流程（时序）

```bash
# ── 1. 诊断 ─────────────────────────────────────────────
git remote -v                  # 发现无远程
git status --short             # 查看改动
git ls-files dist node_modules # 确认产物未被跟踪

# ── 2. 配置远程（HTTPS 失败后切 SSH）──────────────────
git remote add origin https://github.com/yhc3577/memory-new.git
ssh -T git@github.com          # 验证 SSH key（输出 Hi yhc3577!）
git remote set-url origin git@github.com:yhc3577/memory-new.git
git ls-remote origin           # 发现远程 main 已有模板 commit

# ── 3. 提交 ─────────────────────────────────────────────
git add -A
git diff --cached --name-only  # 预览 23 个文件
git commit -m "feat: ..."

# ── 4. 对齐分支 ─────────────────────────────────────────
git branch -m master main

# ── 5. 合并远程模板 ─────────────────────────────────────
git fetch origin
git log origin/main --oneline
git ls-tree -r --name-only origin/main
git merge origin/main --allow-unrelated-histories --no-edit
git checkout --ours README.md  # 解决冲突：保留本地 README
git add README.md LICENSE
git commit -m "merge: ..."

# ── 6. 推送 ─────────────────────────────────────────────
git push -u origin main
git status -sb                 # 验证同步：## main...origin/main
```

---

## 五、常见问题速查

| 报错 | 原因 | 解决 |
|------|------|------|
| `GnuTLS recv error (-110)` | HTTPS 443 端口被阻断 | 改用 SSH remote：`git remote set-url origin git@github.com:用户/仓库.git` |
| `refusing to merge unrelated histories` | 两段独立历史 | `git merge origin/main --allow-unrelated-histories` |
| `更新被拒绝：非快进` | 远程有新提交而本地没有 | `git pull --rebase origin main` 后重推，或用 `git push --force`（慎用） |
| `Automatic merge failed` | 两边改了同一文件 | 编辑冲突文件 → `git add` → `git commit` |
| `Please tell me who you are` | 未配置身份 | `git config --global user.name "..."` + `user.email "..."` |

---

## 六、当前状态备忘

```bash
# 远程
origin → git@github.com:yhc3577/memory-new.git (SSH)

# 分支跟踪
main → origin/main（已设置 upstream）

# 提交历史
469069e  merge: keep local plugin README, retain remote LICENSE
92f5c49  feat: memory-new plugin - multi-layer memory with decay, team memory, and visualization
3b19b8f  Initial commit

# 已推送 28 个文件（源码 / 脚本 / 配置 / 文档 / LICENSE）
```

以后提交只需两步：

```bash
git add -A
git commit -m "描述"
git push          # 无需再带 origin main
```
