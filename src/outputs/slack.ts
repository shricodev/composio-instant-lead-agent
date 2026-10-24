import { loadConfig } from "../config.js";
import type { LeadSession } from "../composio.js";

// Slack alerts run on the workspace's OWN Slack connection (not Instant).

export type SlackResult = { ok: true; ts?: string } | { ok: false; error: string };

export async function postSlack(session: LeadSession, markdown: string, threadTs?: string): Promise<SlackResult> {
  const cfg = loadConfig();
  if (!cfg.SLACK_CHANNEL) return { ok: false, error: "SLACK_CHANNEL not set" };
  const res = await session.execute("SLACK_SEND_MESSAGE", {
    channel: cfg.SLACK_CHANNEL,
    markdown_text: markdown,
    unfurl_links: false,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  if (res.error) return { ok: false, error: res.error };
  const ts = (res.data.ts ?? (res.data as { message?: { ts?: string } }).message?.ts) as string | undefined;
  return { ok: true, ...(ts ? { ts } : {}) };
}
