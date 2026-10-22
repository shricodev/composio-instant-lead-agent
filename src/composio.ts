import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";
import type { ToolRouterCreateSessionConfig } from "@composio/core";
import { loadConfig } from "./config.js";
import { OUTPUT_TOOLS, TIER1_TOOLS, TIER2_TOOLS, instantToolsByToolkit, type ToolSpec } from "./tools.js";

export const INSTANT_ACCOUNT = "instant_account";

let client: Composio<AnthropicProvider> | undefined;

export function getComposio(): Composio<AnthropicProvider> {
  if (client) return client;
  const cfg = loadConfig();
  client = new Composio({
    apiKey: cfg.COMPOSIO_API_KEY,
    provider: new AnthropicProvider({ cacheTools: true }),
  });
  return client;
}

export type SessionKind = "tier1" | "tier2" | "outputs";
export type LeadSession = Awaited<ReturnType<Composio<AnthropicProvider>["sessions"]["create"]>>;

/**
 * Build the session config for one kind of run.
 *
 * - Top-level `tools` decides what the session can SEE: only the slugs declared in tools.ts.
 * - `instant` decides what it can PAY for: the same toolkits, narrowed per tool.
 * - Routing relies on Composio's priority (own account > shared > Instant):
 *   `assertInstantRouting` refuses to run if the workspace has its own account on
 *   a paid toolkit. Explicit `account: "instant_account"` is off by default because
 *   the live API rejects it (see BUILD_NOTES.md); set INSTANT_EXPLICIT_ACCOUNT=true
 *   to try it (that also turns on multiAccount, which it requires).
 * - We never hand `session.tools()` to a model: tier 1 calls fixed slugs, and
 *   tier 2 gets direct schemas from `directTools()` below.
 */
export function sessionConfig(
  kind: SessionKind,
  opts: { instantEnabled: boolean; firewall?: boolean; explicitAccount?: boolean },
): ToolRouterCreateSessionConfig {
  const paid = kind === "tier1" ? TIER1_TOOLS : kind === "tier2" ? TIER2_TOOLS : [];
  const visible: ToolSpec[] = [...paid, ...OUTPUT_TOOLS];

  const tools: Record<string, string[]> = {};
  for (const t of visible) (tools[t.toolkit] ??= []).push(t.slug);

  const instantByToolkit = instantToolsByToolkit(paid);
  const instantToolkits = Object.keys(instantByToolkit);

  const config: ToolRouterCreateSessionConfig = {
    // Explicit account selection is only accepted in multi-account mode.
    ...(opts.explicitAccount ? { multiAccount: { enable: true } } : {}),
    toolkits: Object.keys(tools),
    tools,
    // `instant: false` is the kill switch; otherwise allow only our paid toolkits and tools.
    instant:
      opts.instantEnabled && instantToolkits.length > 0
        ? {
            toolkits: { enable: instantToolkits },
            tools: Object.fromEntries(
              Object.entries(instantByToolkit).map(([tk, slugs]) => [tk, { enable: slugs }]),
            ),
            returnInstantCharge: true,
          }
        : false,
  };

  if (opts.firewall) {
    // Scraped pages and search results flow into an LLM: block prompt injection
    // in tool OUTPUT before the model sees it.
    config.hooks = [
      {
        id: "block_injection",
        type: "after_execute",
        appliesTo: "all",
        handler: { type: "prompt_injection_check", action: "block" },
      },
    ];
  }
  return config;
}

export async function createSession(kind: SessionKind, opts?: { instantEnabled?: boolean }): Promise<LeadSession> {
  const cfg = loadConfig();
  return getComposio().sessions.create(
    cfg.COMPOSIO_USER_ID,
    sessionConfig(kind, {
      instantEnabled: opts?.instantEnabled ?? cfg.INSTANT_ENABLED,
      firewall: kind === "tier2" && cfg.FIREWALL_ENABLED,
      explicitAccount: cfg.INSTANT_EXPLICIT_ACCOUNT,
    }),
  );
}

/**
 * Free pre-flight: an ACTIVE own connection on a paid toolkit would outrank
 * Instant and silently run on that account (no charge, someone else's quota).
 */
export async function assertInstantRouting(session: LeadSession, paidToolkits: string[]): Promise<void> {
  const { items } = await session.toolkits();
  const hijacked = items.filter((t) => paidToolkits.includes(t.slug) && t.connection?.isActive && t.connection.connectedAccount);
  if (hijacked.length > 0) {
    throw new Error(
      `Own connected account(s) would take priority over Instant for: ${hijacked.map((t) => t.slug).join(", ")}. ` +
        "Use a different COMPOSIO_USER_ID or disconnect them.",
    );
  }
}

/**
 * Anthropic-formatted schemas for exactly these slugs (no meta tools), for the
 * tier-2 model. Execution still goes through the session + BudgetedExecutor.
 */
export async function directTools(slugs: string[]) {
  const cfg = loadConfig();
  return getComposio().tools.get(cfg.COMPOSIO_USER_ID, { tools: slugs });
}

export async function restoreSession(sessionId: string): Promise<LeadSession> {
  return getComposio().sessions.use(sessionId);
}
