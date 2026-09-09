/**
 * Identity resolution for plugin hooks / commands / tools.
 *
 * OpenClaw plugins run as ONE process per gateway and are invoked per-call by
 * every agent registered in the gateway's openclaw.json. The runtime provides
 * identity per invocation via:
 *   - ctx.agentId   (most direct, but optional in some hooks)
 *   - ctx.sessionKey (always present; canonical form `agent:<agentId>:<...>`)
 *
 * The SDK exports `resolveAgentIdFromSessionKey` (openclaw/plugin-sdk/session-key-runtime)
 * which parses the agent name out of the session key when ctx.agentId is absent.
 *
 * For external (non-bundled) plugins, ctx.senderIsOwner is unreliable
 * (only bundled plugins see it populated), so we MUST NOT use it for permission
 * gating. Identity = ctx.agentId (or parsed equivalent) is the only safe signal.
 */

import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";

export interface AgentContextLike {
  agentId?: string;
  sessionKey?: string;
  userId?: string;
}

let warnedAmbiguous = false;

/**
 * Resolve the local agent id for the current invocation.
 * Order: ctx.agentId → parse from sessionKey → "self" (one-shot warn).
 */
export function resolveLocalAgentId(ctx?: AgentContextLike | null): string {
  if (ctx?.agentId && ctx.agentId.trim()) return ctx.agentId.trim();

  if (ctx?.sessionKey) {
    try {
      const parsed = resolveAgentIdFromSessionKey(ctx.sessionKey);
      if (parsed && parsed.trim()) return parsed.trim();
    } catch {
      // malformed key — fall through
    }
  }

  if (!warnedAmbiguous) {
    warnedAmbiguous = true;
    // Logger is unavailable here; the call sites are expected to log via api.logger.
    // The state flag guarantees we only nag once per process.
  }
  return "self";
}

/** Resolve the local user id (currently trivial; placeholder for future owner-tagged auth). */
export function resolveLocalUserId(ctx?: AgentContextLike | null): string {
  if (ctx?.userId && ctx.userId.trim()) return ctx.userId.trim();
  return "user";
}

/**
 * Sanitize an agentId for safe use as a filename.
 * Allows [A-Za-z0-9_-]; everything else becomes underscore.
 */
export function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** For tests: reset the once-per-process warn flag. */
export function _resetIdentityWarningsForTest(): void {
  warnedAmbiguous = false;
}
