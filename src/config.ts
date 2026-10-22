import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  COMPOSIO_API_KEY: z.string().min(1, "COMPOSIO_API_KEY is required"),
  ANTHROPIC_API_KEY: z.string().optional(),
  COMPOSIO_USER_ID: z.string().min(1).default("instant_demo_workspace"),

  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_RESEARCH_MODEL: z.string().default("claude-sonnet-5-5"),

  // USD amounts stay strings here; budget.ts converts them to exact pico-USD.
  TIER1_BUDGET_USD: z.string().regex(/^\d+(\.\d+)?$/).default("0.30"),
  TIER2_BUDGET_USD: z.string().regex(/^\d+(\.\d+)?$/).default("0.50"),
  TIER2_MAX_ITERATIONS: z.coerce.number().int().positive().default(6),
  DEV_SPEND_CAP_USD: z.string().regex(/^\d+(\.\d+)?$/).default("1.50"),
  HOT_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  INSTANT_ENABLED: bool.default(true),
  // Pass account: "instant_account" on every paid call (requires multi-account mode).
  INSTANT_EXPLICIT_ACCOUNT: bool.default(false),

  CRM: z.enum(["sheets", "hubspot"]).default("sheets"),
  GOOGLE_SHEET_ID: z.string().optional(),
  GOOGLE_SHEET_TAB: z.string().default("Leads"),
  SLACK_CHANNEL: z.string().optional(),

  FIREWALL_ENABLED: bool.default(false),
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  // Shared secret the signup form sends as `x-webhook-secret` (optional but recommended).
  SIGNUP_WEBHOOK_SECRET: z.string().optional(),
  // Same email within this window is treated as a duplicate (no second spend).
  DEDUPE_WINDOW_MINUTES: z.coerce.number().int().min(0).default(1440),
  // Leads processed concurrently by the server; 1 keeps spend predictable.
  CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  ADMIN_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().default(3000),
  DB_PATH: z.string().default("data/enrichment.db"),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  // Treat empty strings from .env as unset so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
