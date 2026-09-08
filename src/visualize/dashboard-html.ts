/**
 * Self-contained dashboard HTML for the memory visualization server.
 *
 * No external CDNs, no build step — vanilla JS + inline SVG, designed to work
 * offline. Polls /api/* every 3s.
 *
 * Sections
 *   - Header: backend, uptime, refresh status
 *   - Stats grid: layer counts (click a card to drill into that layer)
 *   - Drill-down browser: click a stat card → full list of that layer's
 *     memories (L0 raw msgs / L1 atomic memories / L2 scenes / L3 persona),
 *     with layer tabs + keyword filter
 *   - Decay reason bars: bar rows of byReason
 *   - State transition flow: bar rows of byTransition counts
 *   - Scene graph: SVG nodes (scenes) + edges (L1 memories)
 *   - Persona panel: L3 人物画像 (real persona.md or dry-run preview)
 *   - Recall test: text box that calls /api/recall and shows markers + memories
 *   - Recent L1: truncated list of latest L1 memories
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>memory_new · 可视化面板</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #0f1419;
    --panel: #161b22;
    --panel-2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --good: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
    --link: #79c0ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { color: var(--text-dim); font-size: 12px; }
  header .meta span + span::before { content: " · "; color: var(--border); }
  main { padding: 24px; display: grid; gap: 20px; }
  .grid { display: grid; gap: 16px; }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .grid-4, .grid-2 { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .panel h2 {
    margin: 0 0 12px 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  .stat { display: flex; flex-direction: column; gap: 4px; }
  .stat .v { font-size: 28px; font-weight: 600; color: var(--accent); }
  .stat .k { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .v.good { color: var(--good); }
  .stat .v.warn { color: var(--warn); }
  .stat .v.bad { color: var(--bad); }
  .card { cursor: pointer; transition: border-color 0.15s; }
  .card:hover { border-color: var(--accent); }
  .card .open-hint { margin-top: 6px; font-size: 11px; color: var(--text-dim); opacity: 0.85; }
  .chart { width: 100%; height: 160px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
  .row .label { width: 110px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .bar { flex: 1; height: 16px; background: var(--panel-2); border-radius: 3px; overflow: hidden; position: relative; }
  .row .fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  .row .count { width: 48px; text-align: right; font-variant-numeric: tabular-nums; }
  input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: inherit;
  }
  button {
    padding: 6px 14px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  .tab {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border);
    font-weight: 500;
    padding: 5px 12px;
  }
  .tab.active { background: var(--panel-2); color: var(--text); border-color: var(--accent); }
  .btn-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }
  .drill-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .drill-head h2 { margin: 0; }
  .drill-tools { display: flex; gap: 8px; align-items: center; flex: 1 1 300px; max-width: 520px; }
  .marker {
    display: inline-block;
    padding: 2px 8px;
    margin: 2px 4px 2px 0;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .marker.ok { background: rgba(63, 185, 80, 0.15); color: var(--good); }
  .marker.no { background: rgba(248, 81, 73, 0.15); color: var(--bad); }
  pre {
    background: var(--panel-2);
    padding: 12px;
    border-radius: 4px;
    overflow: auto;
    max-height: 320px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  ul.mem-list { list-style: none; padding: 0; margin: 0; max-height: 200px; overflow: auto; }
  ul.mem-list li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  ul.mem-list li .scene { color: var(--link); margin-right: 8px; }
  ul.mem-list li .type { color: var(--text-dim); margin-right: 8px; font-size: 11px; }
  .hint { color: var(--text-dim); font-size: 12px; }
  .empty { color: var(--text-dim); font-style: italic; }
  .entries { display: flex; flex-direction: column; gap: 8px; max-height: 440px; overflow: auto; padding-right: 4px; }
  .entry { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: var(--panel-2); }
  .entry.scene-entry { cursor: pointer; }
  .entry.scene-entry:hover { border-color: var(--accent); }
  .entry-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .type-a { background: rgba(88, 166, 255, 0.15); color: #79c0ff; }
  .type-e { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
  .type-i { background: rgba(210, 153, 34, 0.15); color: #d29922; }
  .type-f { background: rgba(139, 148, 158, 0.2); color: #8b949e; }
  .role-user { background: rgba(88, 166, 255, 0.15); color: #79c0ff; }
  .role-assistant { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
  .scene-tag { color: var(--link); font-size: 11px; }
  .pri { color: var(--warn); font-size: 11px; font-weight: 600; }
  .time { color: var(--text-dim); font-size: 11px; margin-left: auto; }
  .entry-body { font-size: 12.5px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
  .scene-body { margin-top: 6px; }
  .chip {
    display: inline-block;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 12px;
    background: var(--panel-2);
    color: var(--text-dim);
  }
  .chip b { color: var(--text); font-variant-numeric: tabular-nums; }
  .chip.good b { color: var(--good); }
  .chip.warn b { color: var(--warn); }
  .md { font-size: 13px; line-height: 1.7; }
  .md-h1 { font-size: 16px; font-weight: 700; margin: 6px 0 6px; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  .md-h2 { font-size: 14px; font-weight: 700; margin: 12px 0 4px; color: var(--link); }
  .md-h3 { font-size: 13px; font-weight: 600; margin: 10px 0 2px; color: var(--text); }
  .md-h4 { font-size: 12.5px; font-weight: 600; margin: 8px 0 2px; color: var(--text-dim); }
  .md-li { padding: 1px 0 1px 12px; position: relative; }
  .md-li::before { content: "•"; position: absolute; left: 0; color: var(--accent); }
  .md-p { padding: 2px 0; }
</style>
</head>
<body>
<header>
  <h1>memory_new · 记忆可视化面板</h1>
  <div class="meta">
    <span id="meta-backend">后端: …</span>
    <span id="meta-uptime">运行时长: …</span>
    <span id="meta-refresh">刷新: …</span>
  </div>
</header>

<main>
  <section class="grid grid-4">
    <div class="panel stat card" onclick="openDrill('l0')" title="点击查看 L0 原始消息详情">
      <div class="v" id="stat-l0">–</div><div class="k">L0 · 原始消息</div>
      <div class="open-hint">点击查看全部消息 ▾</div>
    </div>
    <div class="panel stat card" onclick="openDrill('l1')" title="点击查看 L1 原子记忆详情">
      <div class="v" id="stat-l1">–</div><div class="k">L1 · 原子记忆</div>
      <div class="open-hint">点击查看全部记忆 ▾</div>
    </div>
    <div class="panel stat card" onclick="openDrill('l2')" title="点击查看 L2 场景详情">
      <div class="v" id="stat-l2">–</div><div class="k">L2 · 场景</div>
      <div class="open-hint">点击查看全部场景 ▾</div>
    </div>
    <div class="panel stat card" onclick="openDrill('l3')" title="点击查看 L3 人物画像">
      <div class="v" id="stat-l3">–</div><div class="k">L3 · 用户画像</div>
      <div class="open-hint">点击查看人物画像 ▾</div>
    </div>
  </section>

  <section class="panel" id="drill" hidden>
    <div class="drill-head">
      <h2 id="drill-title"></h2>
      <div class="tabs" id="drill-tabs" style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="tab" data-layer="l0" onclick="openDrill('l0')">L0 原始消息</button>
        <button class="tab" data-layer="l1" onclick="openDrill('l1')">L1 原子记忆</button>
        <button class="tab" data-layer="l2" onclick="openDrill('l2')">L2 场景</button>
        <button class="tab" data-layer="l3" onclick="openDrill('l3')">L3 画像</button>
      </div>
      <div class="drill-tools">
        <input type="text" id="drill-q" placeholder="过滤当前层…" oninput="loadDrill()">
        <button class="btn-ghost" onclick="closeDrill()">关闭</button>
      </div>
    </div>
    <div class="hint" id="drill-status" style="margin-bottom:8px;"></div>
    <div id="drill-list"></div>
  </section>

  <section class="grid grid-2">
    <div class="panel">
      <h2>记忆衰退 · 原因分布</h2>
      <div id="decay-bars"></div>
    </div>
    <div class="panel">
      <h2>记忆衰退 · 状态流转</h2>
      <div id="decay-transitions"></div>
    </div>
  </section>

  <section class="panel">
    <h2>场景关系图（L2 → L1）</h2>
    <svg id="scene-graph" class="chart" viewBox="0 0 600 440"></svg>
    <div class="hint" id="scene-graph-hint"></div>
  </section>

  <section class="panel" id="persona-panel">
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;justify-content:space-between;margin-bottom:10px;">
      <h2 style="margin:0;">人物画像 · L3</h2>
      <div class="hint" id="persona-meta"></div>
    </div>
    <div id="persona-metrics" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;"></div>
    <div id="persona-body" class="md"></div>
  </section>

  <section class="grid grid-2">
    <div class="panel">
      <h2>召回注入测试</h2>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input type="text" id="recall-q" placeholder="输入关键词搜索记忆…" value="">
        <button onclick="runRecall()">搜索</button>
      </div>
      <div id="recall-result"></div>
    </div>
    <div class="panel">
      <h2>最近 L1 记忆</h2>
      <ul class="mem-list" id="mem-list"><li class="empty">加载中…</li></ul>
    </div>
  </section>
</main>

<script>
// getElementById helper. Accepts an id with or without a "#" prefix (the
// dashboard styles the drill-down rows like CSS selectors elsewhere, so a bare
// "#" here is an easy mistake — normalize it instead of relying on call sites).
const $ = (id) => document.getElementById(String(id).replace(/^#/, ""));
let pollTimer = null;

async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " → " + r.status);
  return r.json();
}

function setStat(id, val, cls) {
  const el = $(id);
  el.textContent = val;
  el.className = "v" + (cls ? " " + cls : "");
}

function setMeta(id, val) { $(id).textContent = val; }

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtWhen(v) {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Date.parse(v);
  if (Number.isNaN(n)) return "";
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

const TYPE_META = {
  persona: { label: "画像", cls: "type-a" },
  episodic: { label: "事件", cls: "type-e" },
  instruction: { label: "指令", cls: "type-i" },
  fact: { label: "事实", cls: "type-f" },
};

function typeBadge(t) {
  const m = TYPE_META[t] || { label: t || "?", cls: "type-f" };
  return '<span class="badge ' + m.cls + '">' + escapeXml(m.label) + '</span>';
}

// ---------------------------------------------------------------------------
// Decay panels
// ---------------------------------------------------------------------------

function renderDecayBars(byReason) {
  const host = $("decay-bars");
  if (!byReason || Object.keys(byReason).length === 0) {
    host.innerHTML = '<div class="empty">暂无衰退记录</div>';
    return;
  }
  const max = Math.max(...Object.values(byReason));
  const rows = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  host.innerHTML = rows.map(([k, v]) => {
    const pct = max ? (v / max * 100).toFixed(0) : 0;
    return '<div class="row"><span class="label" title="' + escapeXml(k) + '">' + escapeXml(k) + '</span><span class="bar"><span class="fill" style="width:' + pct + '%"></span></span><span class="count">' + v + '</span></div>';
  }).join("");
}

function renderDecayTransitions(byTransition) {
  const host = $("decay-transitions");
  if (!byTransition || Object.keys(byTransition).length === 0) {
    host.innerHTML = '<div class="empty">暂无状态流转</div>';
    return;
  }
  const rows = Object.entries(byTransition).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(...rows.map(([, v]) => v));
  host.innerHTML = rows.map(([k, v]) => {
    const pct = max ? (v / max * 100).toFixed(0) : 0;
    return '<div class="row"><span class="label" style="font-family:monospace" title="' + escapeXml(k) + '">' + escapeXml(k) + '</span><span class="bar"><span class="fill" style="width:' + pct + '%"></span></span><span class="count">' + v + '</span></div>';
  }).join("");
}

// ---------------------------------------------------------------------------
// Scene graph
// ---------------------------------------------------------------------------

function renderSceneGraph(graph) {
  const svg = $("scene-graph");
  const hint = $("scene-graph-hint");
  svg.innerHTML = "";
  if (!graph.nodes || graph.nodes.length === 0) {
    hint.textContent = "暂无场景";
    return;
  }
  hint.textContent = graph.nodes.length + " 个场景，" + graph.edges.length + " 条 L1 关联记忆";

  // Edges first so nodes overlap them
  for (const e of graph.edges) {
    const from = graph.nodes.find((n) => n.id === e.from);
    const to = graph.l1Preview.find((m) => m.id === e.to);
    if (!from || !to) continue;
    const tx = 580 - (graph.l1Preview.indexOf(to) % 6) * 14;
    const ty = 60 + Math.floor(graph.l1Preview.indexOf(to) / 6) * 14;
    svg.insertAdjacentHTML("beforeend",
      '<line x1="' + from.x + '" y1="' + from.y + '" x2="' + tx + '" y2="' + ty + '" stroke="#30363d" stroke-width="0.5" opacity="0.6"/>'
    );
  }
  for (const n of graph.nodes) {
    svg.insertAdjacentHTML("beforeend",
      '<g><circle cx="' + n.x + '" cy="' + n.y + '" r="22" fill="#1f6feb" stroke="#58a6ff" stroke-width="1.5"/>' +
      '<text x="' + n.x + '" y="' + (n.y + 4) + '" text-anchor="middle" fill="#fff" font-size="11" font-weight="600">' + escapeXml(n.label.slice(0, 8)) + '</text></g>'
    );
  }
}

// ---------------------------------------------------------------------------
// Recent L1 (side list)
// ---------------------------------------------------------------------------

function renderMemList(records) {
  const host = $("mem-list");
  if (!records || records.length === 0) {
    host.innerHTML = '<li class="empty">暂无 L1 记忆</li>';
    return;
  }
  host.innerHTML = records.slice(0, 30).map((r) =>
    '<li><span class="scene">' + escapeXml(r.sceneName || "通用") + '</span><span class="type">' + escapeXml(r.type || "?") + '</span>' + escapeXml((r.content || "").slice(0, 120)) + '</li>'
  ).join("");
}

// ---------------------------------------------------------------------------
// Drill-down: click a stat card to browse a layer's full records
// ---------------------------------------------------------------------------

let activeDrill = "l0";
const drillData = { l0: null, l1: null, l2: null, l3: null }; // cached per-layer payloads
const sceneBodies = {}; // sceneId → fetched scene content

const DRILL_TITLES = {
  l0: "L0 · 原始消息详情",
  l1: "L1 · 原子记忆详情",
  l2: "L2 · 场景详情",
  l3: "L3 · 人物画像",
};

function setActiveTab() {
  for (const b of document.querySelectorAll("#drill-tabs .tab")) {
    b.classList.toggle("active", b.dataset.layer === activeDrill);
  }
}

async function openDrill(layer) {
  activeDrill = layer;
  $("#drill").hidden = false;
  setActiveTab();
  $("#drill-q").value = "";
  $("#drill").scrollIntoView({ behavior: "smooth", block: "nearest" });
  await loadDrill();
}

function closeDrill() { $("#drill").hidden = true; }

async function fetchDrill(layer) {
  if (layer === "l0") return (await get("/api/l0?limit=500")).records || [];
  if (layer === "l1") return (await get("/api/l1?limit=500")).records || [];
  if (layer === "l2") return (await get("/api/scenes")).scenes || [];
  return await get("/api/persona"); // { present, content, summary, updatedAt }
}

async function loadDrill() {
  const list = $("#drill-list");
  const status = $("#drill-status");
  const q = $("#drill-q").value.trim().toLowerCase();
  $("#drill-title").textContent = DRILL_TITLES[activeDrill] || "";

  if (drillData[activeDrill] === null) {
    list.innerHTML = '<div class="empty">加载中…</div>';
    status.textContent = "";
    try {
      drillData[activeDrill] = await fetchDrill(activeDrill);
    } catch (e) {
      drillData[activeDrill] = { __error: e.message };
    }
  }

  const data = drillData[activeDrill];
  if (data && data.__error) {
    status.textContent = "";
    list.innerHTML = '<div class="empty">加载失败: ' + escapeXml(data.__error) + '</div>';
    return;
  }

  const out = { html: "", status: "" };
  if (activeDrill === "l0") renderDrillL0(data, q, out);
  else if (activeDrill === "l1") renderDrillL1(data, q, out);
  else if (activeDrill === "l2") renderDrillL2(data, q, out);
  else renderDrillL3(data, q, out);

  status.textContent = out.status;
  list.innerHTML = out.html || '<div class="empty">无匹配内容</div>';
}

function filtered(data, q, keys) {
  if (!q) return data;
  return (data || []).filter((it) => {
    const hay = keys.map((k) => String(it[k] ?? "")).join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderDrillL0(records, q, out) {
  const items = filtered(records, q, ["content", "role", "sessionKey", "sessionId"]);
  out.status = "共 " + records.length + " 条 L0 原始消息" + (q ? "，匹配 " + items.length : "") + "（按时间倒序，最多展示最近 500 条）";
  out.html = items.map((r) =>
    '<div class="entry">' +
      '<div class="entry-top">' +
        '<span class="badge ' + (r.role === "assistant" ? "role-assistant" : "role-user") + '">' + (r.role === "assistant" ? "助手" : "用户") + '</span>' +
        (r.sessionKey ? '<span class="scene-tag">' + escapeXml(r.sessionKey) + '</span>' : "") +
        '<span class="time">' + fmtWhen(r.timestamp) + '</span>' +
      '</div>' +
      '<div class="entry-body">' + escapeXml(r.content || "") + '</div>' +
    '</div>'
  ).join("");
}

function renderDrillL1(records, q, out) {
  const items = filtered(records, q, ["content", "type", "sceneName", "sessionKey"]);
  out.status = "共 " + records.length + " 条 L1 原子记忆" + (q ? "，匹配 " + items.length : "") + "（按时间倒序，最多展示最近 500 条）";
  out.html = items.map((r) =>
    '<div class="entry">' +
      '<div class="entry-top">' +
        typeBadge(r.type) +
        (r.sceneName ? '<span class="scene-tag">' + escapeXml(r.sceneName) + '</span>' : "") +
        (r.priority != null ? '<span class="pri">优先级 ' + r.priority + '</span>' : "") +
        '<span class="time">' + fmtWhen(r.createdAt || (r.timestamps && r.timestamps[0]) || "") + '</span>' +
      '</div>' +
      '<div class="entry-body">' + escapeXml(r.content || "") + '</div>' +
    '</div>'
  ).join("");
}

function renderDrillL2(scenes, q, out) {
  const items = filtered(scenes, q, ["title", "summary", "id", "tags"]);
  out.status = "共 " + scenes.length + " 个 L2 场景" + (q ? "，匹配 " + items.length : "") + "（点击条目展开正文）";
  out.html = items.map((s) =>
    '<div class="entry scene-entry" onclick="toggleScene(this, \\'' + s.id + '\\')">' +
      '<div class="entry-top">' +
        '<span class="badge type-f">场景</span>' +
        '<span class="scene-tag">' + escapeXml(s.title || "") + '</span>' +
        '<span class="time">' + escapeXml(s.id || "") + '</span>' +
      '</div>' +
      '<div class="entry-body">' + escapeXml(s.summary || "") + '</div>' +
      '<div class="scene-body" hidden></div>' +
    '</div>'
  ).join("");
}

async function toggleScene(elm, id) {
  const body = elm.querySelector(".scene-body");
  if (!body) return;
  if (!body.hidden) { body.hidden = true; return; }
  body.hidden = false;
  body.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const sc = sceneBodies[id] || (await get("/api/scene?id=" + encodeURIComponent(id)));
    sceneBodies[id] = sc;
    body.innerHTML = sc && sc.content
      ? '<pre>' + escapeXml(sc.content) + '</pre>'
      : '<div class="empty">该场景无正文内容</div>';
  } catch (e) {
    body.innerHTML = '<div class="empty">加载失败: ' + escapeXml(e.message) + '</div>';
  }
}

function renderDrillL3(persona, q, out) {
  if (q && !((persona && persona.content) || "").toLowerCase().includes(q)) {
    out.status = "共 1 份画像（过滤无匹配）";
    return;
  }
  const content = persona && persona.content ? persona.content : "";
  out.status = persona && persona.present
    ? "persona.md 真实写入 · 最近更新 " + fmtWhen(persona.updatedAt)
    : "暂无 persona.md —— 可在下方人物画像面板查看 dry-run 预览";
  out.html = content
    ? '<div class="entry"><div class="md">' + mdToHtml(content) + '</div></div>'
    : "";
}

// ---------------------------------------------------------------------------
// Persona panel (L3 人物画像)
// ---------------------------------------------------------------------------

// Tiny, dependency-free Markdown → HTML for the persona file. Headings are
// rendered as blocks and bullet lines as list rows; everything else becomes a
// paragraph. Input is escaped first, so content can never inject markup.
function mdToHtml(md) {
  if (!md) return "";
  const lines = String(md).split(/\\r?\\n/);
  const out = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const h = /^(#{1,4})\\s+(.*)$/.exec(t);
    if (h) {
      const lvl = h[1].length;
      out.push('<div class="md-h' + lvl + '">' + escapeXml(h[2]) + '</div>');
      continue;
    }
    if (/^[-*•]\\s+/.test(t)) {
      out.push('<div class="md-li">' + escapeXml(t.replace(/^[-*•]\\s+/, "")) + '</div>');
      continue;
    }
    out.push('<div class="md-p">' + escapeXml(t) + '</div>');
  }
  return out.join("");
}

async function renderPersona() {
  const metrics = $("persona-metrics");
  const body = $("persona-body");
  const meta = $("persona-meta");
  const hintEl = $("persona-hint");
  if (hintEl) hintEl.remove(); // stale hint from a previous poll tick
  try {
    const pp = await get("/api/persona");
    let l3 = null;
    try { l3 = await get("/api/l3-preview"); } catch (e) { /* non-fatal */ }

    const content = (pp && pp.content) || (l3 && l3.previewPersona) || "";
    const isReal = !!(pp && pp.present && pp.content);
    const chips = [];

    chips.push(isReal
      ? '<span class="chip good"><b>真实写入</b> · persona.md</span>'
      : '<span class="chip warn"><b>dry-run 预览</b> · 未写入 persona.md</span>');

    if (l3) {
      chips.push('<span class="chip">L1 记录 <b>' + l3.l1Count + '</b></span>');
      chips.push('<span class="chip">平均优先级 <b>' + Number(l3.avgImportance).toFixed(3) + '</b></span>');
      chips.push('<span class="chip">高价值场景 <b class="' + (l3.thresholdMet ? "" : "") + '">' + l3.highValueSceneCount + '</b></span>');
    }

    metrics.innerHTML = chips.join("");
    meta.textContent = pp && pp.updatedAt
      ? "生成于 " + fmtWhen(pp.updatedAt)
      : (l3 && l3.timestamp ? "预览生成于 " + fmtWhen(l3.timestamp) : "");

    if (content) {
      body.innerHTML = mdToHtml(content);
    } else {
      body.innerHTML = '<div class="empty">暂无画像内容 —— 继续对话积累记忆后，L3 会在此汇总用户画像。</div>';
    }
    // When only a dry-run preview exists, tell the user how to enable real writes.
    if (!isReal && l3) {
      const h = document.createElement("div");
      h.id = "persona-hint";
      h.className = "hint";
      h.style.marginTop = "8px";
      h.textContent = "提示：当前 L3 为 dry-run 预览，未实际写入 persona.md。设置 openclaw.json 中 layersEnabled.L3 = true 后将真实生成。";
      body.parentNode.insertBefore(h, body.nextSibling);
    }
  } catch (e) {
    metrics.innerHTML = "";
    meta.textContent = "";
    body.innerHTML = '<div class="empty">人物画像加载失败: ' + escapeXml(e.message) + '</div>';
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function poll() {
  try {
    const [health, s, dStats, sg, l1] = await Promise.all([
      get("/api/health"),
      get("/api/stats"),
      get("/api/decay-stats"),
      get("/api/scene-graph"),
      get("/api/l1?limit=30"),
    ]);

    setMeta("meta-backend", "后端: " + health.backend);
    setMeta("meta-uptime", "运行时长: " + Math.round(health.uptimeMs / 1000) + " 秒");
    setMeta("meta-refresh", "刷新: " + new Date().toLocaleTimeString());

    setStat("stat-l0", s.layers.l0Count);
    setStat("stat-l1", s.layers.l1Count, s.layers.l1Count > 0 ? "good" : "");
    setStat("stat-l2", s.layers.l2Count, s.layers.l2Count > 0 ? "good" : "");
    setStat("stat-l3", s.persona.present ? "✓" : "—", s.persona.present ? "good" : "");

    renderDecayBars(dStats.byReason);
    renderDecayTransitions(dStats.byTransition);
    // Use sg.nodes directly — the server already lays out scene nodes with x/y.
    // (Mapping scenes.scenes to x:0,y:0 would stack every node at the origin.)
    renderSceneGraph({ nodes: sg.nodes, edges: sg.edges, l1Preview: sg.l1Preview });
    renderMemList(l1.records);
  } catch (e) {
    setMeta("meta-refresh", "刷新失败: " + e.message);
  }
  // Persona panel is best-effort; failures must not break the other panels.
  try { await renderPersona(); } catch (e) { /* non-fatal */ }
}

async function runRecall() {
  const q = $("recall-q").value.trim();
  if (!q) return;
  const host = $("recall-result");
  host.innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const r = await get("/api/recall?q=" + encodeURIComponent(q));
    const markers = [
      '<span class="marker ' + (r.markers.relevantMemories ? "ok" : "no") + '">&lt;relevant-memories&gt;</span>',
      '<span class="marker ' + (r.markers.persona ? "ok" : "no") + '">&lt;user-persona&gt;</span>',
      '<span class="marker ' + (r.markers.sceneNavigation ? "ok" : "no") + '">&lt;scene-navigation&gt;</span>',
    ].join("");
    const mems = (r.recalledL1Memories || []).map((m) => "- [" + m.type + "] " + m.content).join("\\n");
    host.innerHTML =
      '<div style="margin-bottom:8px">' + markers + '</div>' +
      '<div class="hint">召回策略: ' + (r.strategy || "?") + " · " + (r.recalledL1Memories || []).length + " 条记忆</div>" +
      (mems ? '<pre style="margin-top:8px">' + escapeXml(mems) + '</pre>' : '<div class="empty" style="margin-top:8px">无匹配记忆</div>');
  } catch (e) {
    host.innerHTML = '<div class="empty">出错: ' + e.message + '</div>';
  }
}

poll();
pollTimer = setInterval(poll, 3000);
</script>
</body>
</html>`;
