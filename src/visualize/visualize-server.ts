/**
 * Standalone HTTP visualization server for the memory plugin.
 *
 * Listens on its own port (default 4123, env MEMORY_NEW_PORT overrides).
 * No external deps — uses node:http + node:url only.
 *
 * Endpoints:
 *   GET  /                       → self-contained HTML dashboard (SVG + vanilla JS)
 *   GET  /api/stats              → layer counts (L0/L1/L2/L3) + decay summary
 *   GET  /api/scenes             → L2 scene index with size metadata
 *   GET  /api/decay-stats        → decayLogger.getStats() summary
 *   GET  /api/decay-logs         → recent state transitions (most recent first)
 *   GET  /api/l1?limit=N         → recent L1 records (across all sessions)
 *   GET  /api/recall?q=...       → dry-run recall, returns injection markers
 *   GET  /api/l3-preview         → L3 dry-run report (persona that would have been written)
 *   GET  /api/scene-graph        → nodes/edges payload for SVG scene graph
 *   GET  /api/health             → { ok, backend, port, uptimeMs }
 *
 * Browser uses a 3 s polling loop. No WebSocket dependency for v1.
 */

import http from "node:http";
import { URL } from "node:url";
import { DASHBOARD_HTML } from "./dashboard-html.js";

export interface VisualizeServerOptions {
  /** Things the server queries to render data. Injected so we can unit-test dispatch. */
  store: {
    searchL1: (q: string, limit: number) => Promise<any[]>;
    getSceneIndex: () => Promise<Array<{ id: string; title: string; summary: string }>>;
    getPersona: () => Promise<any>;
  };
  recall: {
    recall: (params: any) => Promise<{
      prependContext?: string;
      appendSystemContext?: string;
      recalledL1Memories?: Array<{ content: string; score: number; type: string }>;
      recallStrategy?: string;
    }>;
  };
  pipeline: {
    getStats: () => Promise<{ l0Count: number; l1Count: number; l2Count: number; l3Count: number }>;
  };
  decayLogger: {
    getStats: () => { total: number; byReason: Record<string, number>; byTransition: Record<string, number>; recent: any[] };
    getLogs: (engramId?: string, since?: number) => any[];
  };
  l3DryRun: () => Promise<{
    timestamp: string;
    l1Count: number;
    avgImportance: number;
    thresholdMet: boolean;
    highValueSceneCount: number;
    previewPersona: string;
    hint: string;
  }>;
  /** Where data lives, surfaced in /api/health for debugging */
  dataDir: string;
  /** Storage backend actually in use (after fallback). */
  backend: "memory" | "sqlite";
}

export interface VisualizeServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Find a free TCP port in [start, start + 9]. Skips ports already bound so
 * multiple instances don't collide. The chosen port is reported back to the
 * caller for logging / CLI status.
 */
async function pickFreePort(start: number): Promise<number> {
  const net = await import("node:net");
  for (let p = start; p < start + 10; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error(`No free port in [${start}, ${start + 9}]`);
}

export async function startVisualizeServer(
  opts: VisualizeServerOptions
): Promise<VisualizeServerHandle> {
  // Port resolution: env override → 4123 → scan
  let port: number;
  const envPort = process.env.MEMORY_NEW_PORT ? Number(process.env.MEMORY_NEW_PORT) : NaN;
  if (Number.isInteger(envPort) && envPort > 0) {
    port = envPort;
  } else {
    port = await pickFreePort(4123);
  }

  const startedAt = Date.now();
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, opts, startedAt);
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: VisualizeServerOptions,
  startedAt: number
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // CORS for local dev convenience (browser may be served from gateway).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return;
  }

  switch (pathname) {
    case "/":
      return html(res, DASHBOARD_HTML);
    case "/api/health":
      return json(res, 200, {
        ok: true,
        backend: opts.backend,
        dataDir: opts.dataDir,
        port: addressPort(res),
        uptimeMs: Date.now() - startedAt,
      });
    case "/api/stats":
      return json(res, 200, await stats(opts));
    case "/api/scenes":
      return json(res, 200, { scenes: await opts.store.getSceneIndex() });
    case "/api/decay-stats":
      return json(res, 200, opts.decayLogger.getStats());
    case "/api/decay-logs":
      return json(res, 200, { logs: opts.decayLogger.getLogs().slice(-100).reverse() });
    case "/api/l1": {
      const limit = clampInt(url.searchParams.get("limit"), 1, 500, 50);
      const records = await opts.store.searchL1("", limit);
      return json(res, 200, { count: records.length, records });
    }
    case "/api/recall": {
      const q = url.searchParams.get("q") ?? "";
      if (!q) return json(res, 400, { error: "missing q" });
      const result = await opts.recall.recall({
        query: q,
        sessionKey: "__viz__",
        userId: "__viz__",
        agentId: "__viz__",
        topK: 10,
      });
      return json(res, 200, {
        strategy: result.recallStrategy,
        prependContext: result.prependContext,
        appendSystemContext: result.appendSystemContext,
        markers: {
          relevantMemories: (result.prependContext ?? "").includes("<relevant-memories>")
            || (result.appendSystemContext ?? "").includes("<relevant-memories>"),
          persona: (result.appendSystemContext ?? "").includes("<user-persona>"),
          sceneNavigation: (result.appendSystemContext ?? "").includes("<scene-navigation>"),
        },
        recalledL1Memories: result.recalledL1Memories ?? [],
      });
    }
    case "/api/l3-preview":
      return json(res, 200, await opts.l3DryRun());
    case "/api/scene-graph":
      return json(res, 200, await sceneGraph(opts));
    default:
      json(res, 404, { error: "not found", path: pathname });
  }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

async function stats(opts: VisualizeServerOptions) {
  const pipelineStats = await opts.pipeline.getStats();
  const decay = opts.decayLogger.getStats();
  const scenes = await opts.store.getSceneIndex();
  const persona = await opts.store.getPersona();
  return {
    layers: pipelineStats,
    scenes: { count: scenes.length, avgHeat: sceneAvgHeat(scenes) },
    persona: { present: persona != null, length: persona?.content?.length ?? 0 },
    decay: {
      totalTransitions: decay.total,
      byReason: decay.byReason,
      byTransition: decay.byTransition,
    },
  };
}

function sceneAvgHeat(scenes: Array<{ id: string }>): number {
  // Heat isn't loaded here (would require reading every scene .md); use count as proxy.
  return scenes.length;
}

async function sceneGraph(opts: VisualizeServerOptions) {
  // We don't have edges persisted today (L2 metadata.sourceRecords exists but
  // isn't loaded into SceneIndex). Build a one-to-many fan-out from each
  // scene to its first N L1 records so the dashboard has something to draw.
  const scenes = await opts.store.getSceneIndex();
  const l1 = await opts.store.searchL1("", 200);
  const nodes = scenes.map((s, i) => ({
    id: s.id,
    label: s.title,
    summary: s.summary,
    // Spread nodes around a circle (radius 200) — deterministic so re-renders
    // don't jitter.
    x: 300 + 200 * Math.cos((2 * Math.PI * i) / Math.max(scenes.length, 1)),
    y: 220 + 200 * Math.sin((2 * Math.PI * i) / Math.max(scenes.length, 1)),
    type: "scene",
  }));

  // L1 records written by the init path (metadata.source === "init") predate
  // storeL1's id generation and have NO `id` field. Derive a stable id so
  // edges / l1Preview stay JSON-serializable (undefined `to`/`id` would be
  // dropped by JSON.stringify, leaving the dashboard's scene graph unlinked).
  const l1WithId = l1.map((r: any, i: number) => {
    const stableId =
      r.id ?? `l1_${i}_${String(r.content ?? "").slice(0, 12).replace(/[^\w]/g, "_")}`;
    return { ...r, id: stableId };
  });

  const edges: Array<{ from: string; to: string }> = [];
  for (const r of l1WithId) {
    const scene = scenes.find((s) => s.title === r.sceneName);
    if (scene) edges.push({ from: scene.id, to: r.id });
  }
  return {
    nodes,
    edges,
    l1Preview: l1WithId.slice(0, 60).map((r: any) => ({
      id: r.id,
      label: (r.content ?? "").slice(0, 40),
      sceneName: r.sceneName,
      type: "memory",
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function addressPort(res: http.ServerResponse): number {
  // server.address() is on the Server, not the response; fall back to "".
  // The handle already returns the port separately for logging.
  return (res.socket as any)?.server?.address?.()?.port ?? 0;
}