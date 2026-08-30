/**
 * Self-contained dashboard HTML for the memory visualization server.
 *
 * No external CDNs, no build step — vanilla JS + inline SVG, designed to work
 * offline. Polls /api/* every 3s.
 *
 * Sections
 *   - Header: backend, uptime, refresh status
 *   - Stats grid: layer counts + decay totals
 *   - Decay reason bars: SVG bar chart of byReason
 *   - State transition flow: SVG sankey-ish diagram of byTransition counts
 *   - Scene graph: SVG nodes (scenes) + edges (L1 memories), one circle each
 *   - Recall test: text box that calls /api/recall and shows markers + memories
 *   - L3 dry-run: persona that would be written if L3 were enabled
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>memory_new · visualization</title>
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
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
  .chart { width: 100%; height: 160px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
  .row .label { width: 110px; color: var(--text-dim); }
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
    max-height: 240px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-dim);
    margin: 0;
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
</style>
</head>
<body>
<header>
  <h1>memory_new · visualization</h1>
  <div class="meta">
    <span id="meta-backend">backend: …</span>
    <span id="meta-uptime">uptime: …</span>
    <span id="meta-refresh">refresh: …</span>
  </div>
</header>

<main>
  <section class="grid grid-4">
    <div class="panel stat"><div class="v" id="stat-l0">–</div><div class="k">L0 (buffer)</div></div>
    <div class="panel stat"><div class="v" id="stat-l1">–</div><div class="k">L1 (atomic)</div></div>
    <div class="panel stat"><div class="v" id="stat-l2">–</div><div class="k">L2 (scenes)</div></div>
    <div class="panel stat"><div class="v" id="stat-l3">–</div><div class="k">L3 (persona)</div></div>
  </section>

  <section class="grid grid-2">
    <div class="panel">
      <h2>Decay — reason distribution</h2>
      <div id="decay-bars"></div>
    </div>
    <div class="panel">
      <h2>Decay — state transitions</h2>
      <div id="decay-transitions"></div>
    </div>
  </section>

  <section class="panel">
    <h2>Scene graph (L2 → L1)</h2>
    <svg id="scene-graph" class="chart" viewBox="0 0 600 440"></svg>
    <div class="hint" id="scene-graph-hint"></div>
  </section>

  <section class="grid grid-2">
    <div class="panel">
      <h2>Recall injection test</h2>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input type="text" id="recall-q" placeholder="search memories…" value="coffee">
        <button onclick="runRecall()">Search</button>
      </div>
      <div id="recall-result"></div>
    </div>
    <div class="panel">
      <h2>L3 dry-run preview</h2>
      <div id="l3-preview"></div>
    </div>
  </section>

  <section class="panel">
    <h2>Recent L1 memories</h2>
    <ul class="mem-list" id="mem-list"><li class="empty">loading…</li></ul>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
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

function renderDecayBars(byReason) {
  const host = $("decay-bars");
  if (!byReason || Object.keys(byReason).length === 0) {
    host.innerHTML = '<div class="empty">no transitions yet</div>';
    return;
  }
  const max = Math.max(...Object.values(byReason));
  const rows = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  host.innerHTML = rows.map(([k, v]) => {
    const pct = max ? (v / max * 100).toFixed(0) : 0;
    return '<div class="row"><span class="label">' + k + '</span><span class="bar"><span class="fill" style="width:' + pct + '%"></span></span><span class="count">' + v + '</span></div>';
  }).join("");
}

function renderDecayTransitions(byTransition) {
  const host = $("decay-transitions");
  if (!byTransition || Object.keys(byTransition).length === 0) {
    host.innerHTML = '<div class="empty">no transitions yet</div>';
    return;
  }
  const rows = Object.entries(byTransition).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(...rows.map(([, v]) => v));
  host.innerHTML = rows.map(([k, v]) => {
    const pct = max ? (v / max * 100).toFixed(0) : 0;
    return '<div class="row"><span class="label" style="font-family:monospace">' + k + '</span><span class="bar"><span class="fill" style="width:' + pct + '%"></span></span><span class="count">' + v + '</span></div>';
  }).join("");
}

function renderSceneGraph(graph) {
  const svg = $("scene-graph");
  const hint = $("scene-graph-hint");
  svg.innerHTML = "";
  if (!graph.nodes || graph.nodes.length === 0) {
    hint.textContent = "no scenes yet";
    return;
  }
  hint.textContent = graph.nodes.length + " scene(s), " + graph.edges.length + " link(s) to L1 memories";

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

function renderMemList(records) {
  const host = $("mem-list");
  if (!records || records.length === 0) {
    host.innerHTML = '<li class="empty">no L1 memories</li>';
    return;
  }
  host.innerHTML = records.slice(0, 30).map((r) =>
    '<li><span class="scene">' + escapeXml(r.sceneName || "General") + '</span><span class="type">' + escapeXml(r.type || "?") + '</span>' + escapeXml((r.content || "").slice(0, 120)) + '</li>'
  ).join("");
}

function renderL3Preview(p) {
  const host = $("l3-preview");
  if (!p || p.l1Count === 0) {
    host.innerHTML = '<div class="empty">no L1 records yet — keep chatting.</div>';
    return;
  }
  const cls = p.thresholdMet ? "good" : "warn";
  host.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px;">' +
      '<div><span style="color:var(--text-dim);font-size:11px">L1 records</span><br><strong>' + p.l1Count + '</strong></div>' +
      '<div><span style="color:var(--text-dim);font-size:11px">Avg importance</span><br><strong>' + p.avgImportance.toFixed(2) + '</strong></div>' +
      '<div><span style="color:var(--text-dim);font-size:11px">High-value scenes</span><br><strong class="v ' + cls + '">' + p.highValueSceneCount + '</strong></div>' +
    '</div>' +
    '<div class="hint" style="margin-bottom:8px">' + escapeXml(p.hint) + '</div>' +
    (p.previewPersona ? '<details><summary style="cursor:pointer;color:var(--link)">preview persona (DRY RUN — not written)</summary><pre>' + escapeXml(p.previewPersona) + '</pre></details>' : '');
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function poll() {
  try {
    const [health, s, scenes, dStats, sg, l3, l1] = await Promise.all([
      get("/api/health"),
      get("/api/stats"),
      get("/api/scenes"),
      get("/api/decay-stats"),
      get("/api/scene-graph"),
      get("/api/l3-preview"),
      get("/api/l1?limit=30"),
    ]);

    setMeta("meta-backend", "backend: " + health.backend);
    setMeta("meta-uptime", "uptime: " + Math.round(health.uptimeMs / 1000) + "s");
    setMeta("meta-refresh", "refresh: " + new Date().toLocaleTimeString());

    setStat("stat-l0", s.layers.l0Count);
    setStat("stat-l1", s.layers.l1Count, s.layers.l1Count > 0 ? "good" : "");
    setStat("stat-l2", s.layers.l2Count, s.layers.l2Count > 0 ? "good" : "");
    setStat("stat-l3", s.persona.present ? "✓" : "—", s.persona.present ? "good" : "");

    renderDecayBars(dStats.byReason);
    renderDecayTransitions(dStats.byTransition);
    // Use sg.nodes directly — the server already lays out scene nodes with x/y.
    // (Mapping scenes.scenes to x:0,y:0 would stack every node at the origin.)
    renderSceneGraph({ nodes: sg.nodes, edges: sg.edges, l1Preview: sg.l1Preview });
    renderL3Preview(l3);
    renderMemList(l1.records);
  } catch (e) {
    setMeta("meta-refresh", "refresh: error " + e.message);
  }
}

async function runRecall() {
  const q = $("recall-q").value.trim();
  if (!q) return;
  const host = $("recall-result");
  host.innerHTML = '<div class="empty">searching…</div>';
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
      '<div class="hint">strategy: ' + (r.strategy || "?") + " · " + (r.recalledL1Memories || []).length + " memories</div>" +
      (mems ? '<pre style="margin-top:8px">' + escapeXml(mems) + '</pre>' : '<div class="empty" style="margin-top:8px">no memories matched</div>');
  } catch (e) {
    host.innerHTML = '<div class="empty">error: ' + e.message + '</div>';
  }
}

poll();
pollTimer = setInterval(poll, 3000);
</script>
</body>
</html>`;