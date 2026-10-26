import { restoreSession, sessionConfig, type SessionKind } from "./composio.js";
import { loadConfig } from "./config.js";
import type { Store } from "./store.js";

// The Instant kill switch has two layers:
//   1. A persisted flag (SQLite, seeded from INSTANT_ENABLED). Every BudgetedExecutor
//      checks it before each paid call, and new sessions are created with `instant: false`.
//   2. For sessions still in flight, `session.update({ instant: false })` so Composio
//      itself refuses Instant routing even if a call was already queued.
// Own connected accounts (Sheets, Slack) keep working either way.

const KEY = "instant_enabled";

export function isInstantEnabled(store: Store): boolean {
  const v = store.getSetting(KEY);
  return v === undefined ? loadConfig().INSTANT_ENABLED : v === "true";
}

/** In-flight paid sessions, so the switch can reach them. */
const active = new Map<string, SessionKind>();

export function trackSession(sessionId: string, kind: SessionKind): () => void {
  active.set(sessionId, kind);
  return () => active.delete(sessionId);
}

export async function setInstantEnabled(
  store: Store,
  enabled: boolean,
): Promise<{ enabled: boolean; sessionsUpdated: string[]; errors: string[] }> {
  store.setSetting(KEY, String(enabled));
  const sessionsUpdated: string[] = [];
  const errors: string[] = [];
  for (const [id, kind] of active) {
    try {
      const session = await restoreSession(id);
      // GOTCHA: any `instant` object re-enables Instant AND replaces the policy. A partial
      // object (e.g. only returnInstantCharge) drops the per-tool allowlist, so re-enabling
      // always resends the full policy for that session kind.
      const instant = enabled ? sessionConfig(kind, { instantEnabled: true }).instant : false;
      await session.update({ instant: instant ?? false });
      sessionsUpdated.push(id);
    } catch (err) {
      errors.push(`${id}: ${String(err).slice(0, 200)}`);
    }
  }
  return { enabled, sessionsUpdated, errors };
}
