# BUILD_NOTES

Running log for the later writeup. Not the blog. Short entries; newest findings appended per phase.

## Environment
- Node v22.23.1 (SDK requires ≥22.22.3). ESM-only; `"type": "module"`.
- `@composio/core@0.27.0`, `@composio/anthropic@0.11.6`, `@composio/client@2.0.0-rc.19` (transitive).
- `@anthropic-ai/sdk` pinned to `~0.133.0`: latest is 1.3.0, but `@composio/anthropic@0.11.6` declares peer `^0.110 … ^0.133`. Installing latest would break the peer range.
- TypeScript pinned to 5.9.x (7.x is the new native compiler; avoided for a demo).
- `better-sqlite3` over `node:sqlite` (still experimental on Node 22).

## Doc vs SDK findings (Phase 0)
- **Session creation:** both `composio.create(userId, cfg)` (docs) and `composio.sessions.create(userId, cfg)` exist; `create` is typed as an alias of `sessions.create`. We use `composio.sessions.create` / `composio.sessions.use` everywhere.
- **`instant` config** (camelCase, strict): `false | { toolkits?: {enable}|{disable}, tools?: Record<toolkit, {enable}|{disable}>, returnInstantCharge?, returnPricesInSearch? }`. Matches docs.
- **`session.execute(slug, args, { account: "instant_account" })`**: matches docs. Typings note: on single-account projects the explicit account "must match one of the session's active connections for the toolkit".
- **`instantCharge`** is typed `unknown` on the execute response. Runtime passes the API object through unchanged, so the keys are snake_case: `{ amount: string, currency: "USD", charged_by }`. `amount` has up to **12 decimal places**, so micro-dollars (6 dp) would lose precision; the ledger uses bigint **pico-USD**.
- **402 wallet exhausted** has no dedicated error class. `@composio/client`'s `APIError.generate` maps 400/401/403/404/409/422/429/5xx to subclasses; 402 becomes a plain `APIError` (`status: 402`, `details.slug`). `APIError` is not re-exported by `@composio/core`. Detect it with `err.status === 402`.
- **AnthropicProvider.handleToolCalls(session, msg)** serialises only `data`/`error` into the tool_result. It **drops `instantCharge`** and never passes `account`. To gate budgets and record charges, tier 2 executes each `tool_use` itself.
- **`sessionPreset: "direct_tools"`** (not in the Instant docs): exposes every tool allowed by the session filters directly in `session.tools()` and turns off meta tools (search / multi-execute / manage-connections / workbench). Without it, `tools()` returns router meta tools and a model would call `COMPOSIO_MULTI_EXECUTE_TOOL` with nested slugs, which is much harder to budget. We use it for every session.
- **Pricing lookups:** core's `composio.tools.*` don't expose `include_pricing`; we use raw `composio.getClient().get('/api/v3.1/tools/{slug}', { query: { toolkit_versions: 'latest', include_pricing: true } })`.
- **Connected accounts:** `composio.connectedAccounts.list()` items (camelCased) drop `user_id`; the raw client `getClient().connectedAccounts.list()` keeps it.
- **Webhook verification:** the JSDoc example for `triggers.verifyWebhook` uses `webhookId`/`webhookTimestamp`, but the zod schema requires `id`/`timestamp` (unknown keys are stripped). Follow the schema.
- **Calendly:** there's no "invitee created" trigger; the slug is `CALENDLY_MEETING_SCHEDULED`.
- **Firewall:** session `hooks` with `{ type: "after_execute", handler: { type: "prompt_injection_check", action: "block" } }`. Paid plans, usage-priced, so it ships off by default (`FIREWALL_ENABLED`).
- **Serper slugs:** `SERPER_SEARCH_NEWS`, `SERPER_SEARCH_WEB`, `SERPER_SCRAPE_WEBPAGE`.

- **`FIRECRAWL_MAP` doesn't exist** (404 `Tool_ToolNotFound`). The Instant map tool is `FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS`. Instant-eligible Firecrawl tools: SCRAPE, MAP_MULTIPLE_URLS_BASED_ON_OPTIONS, SEARCH, SEARCH_PEOPLE_APOLLO, SEARCH_PEOPLE_FULLENRICH.
- **Sheets/Slack slugs:** `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` and `SLACK_SEND_MESSAGE` exist (alternatives: `GOOGLESHEETS_CREATE_SPREADSHEET_ROW`, `SLACK_CHAT_POST_MESSAGE`). Neither is Instant, as expected.
- **Email validator:** `HUNTER_EMAIL_VERIFIER` output schema includes `disposable` and `webmail` flags; ZeroBounce's validate schema has neither. Hunter is also cheaper ($0.012 vs $0.019), so it's the tier-1 validator and ZeroBounce was dropped from the session.
- **Apollo enrichment** exposes no waterfall flag, only `reveal_phone_number` / `reveal_personal_emails` (both sent as false). The price string says "waterfall may cost more", so $0.18 is a bound we *verify* on reconcile rather than a guarantee.
- **API key scopes:** a project key with read-only `session_management` passes every discovery call but fails `sessions.create` with 403 `APIKey_InsufficientPermissions` (code 812). Sessions need `session_management: write`.

- **verify-sdk results (free, 2026-10-26):**
  - Sessions create and restore fine (`sessions.use(id)` returns the same id). No warnings.
  - The returned `session.config` is the snake_case wire shape: `instant.toolkits.enabled` / `tools.<tk>.enabled` (plural, past tense) and `return_instant_charge`, while the *input* is camelCase `enable` / `returnInstantCharge`.
  - With `sessionPreset: "direct_tools"`, `session.tools()` returns exactly the allowlisted slugs, with no meta tools. Confirmed for both the tier 1 and tier 2 policies.
  - Kill switch: `update({ instant: false })` returns `instant: false`.
  - **Re-enable gotcha, confirmed and worse than documented:** `update({ instant: { returnInstantCharge: true } })` after `false` re-enables Instant **and the toolkit/per-tool allowlist is gone**. The policy comes back as `{ return_instant_charge: true }` only, which permits *every* eligible toolkit. Re-enabling must always resend the full policy; `composio.ts#sessionConfig` is the single source for that.
  - `update({})` preserves the current policy.
  - Usage summary on a fresh project: `instantCharge: "0"`.
- The tier 2 session also sees Sheets and Slack (they're on its top-level allowlist for writing results back). The research loop must pass only the research slugs to the model, so the model can't post to Slack itself.

- **Phase 1 live findings (2026-10-26), each a free 400 or session error, nothing charged:**
  - **`account: "instant_account"` needs multi-account mode.** On a default project the API returns 400 `ToolRouterV2_BadRequest`: "The 'account' parameter is not supported for this project. Multi-account selection is not enabled." This contradicts the SDK JSDoc ("Accepted on every project"). Fix: `multiAccount: { enable: true }` in the session config.
  - **`multiAccount` and `preload` are mutually exclusive** (400: "preload is not supported when multi-account is enabled"). `sessionPreset: "direct_tools"` sets `preload: { tools: "all" }` implicitly, so **explicit Instant selection and the direct_tools preset can't be combined**. Fix: no preset. Tier 1 never calls `session.tools()`; tier 2 gets direct schemas via `composio.tools.get(userId, { tools: [...] })`.
  - **A project with Instant switched off gives no early warning.** Session creation accepts the full `instant` policy, echoes it back in `config.instant`, and returns `warnings: []`. The failure only appears at execute time as 400 `ToolRouterV2_NoActiveConnection` ("No active connection found for toolkit(s) 'hunter'… call COMPOSIO_MANAGE_CONNECTIONS"), which reads like a missing OAuth rather than "Instant is off". Free diagnostic: `session.search({ query, toolkits })` with `returnPricesInSearch`. When Instant serves a toolkit, its `toolkitConnectionStatuses[]` carries an `instantAccount`; here it was absent and `hasActiveConnection: false`.
  - **Explicit `account: "instant_account"` doesn't work on our project in either mode.** Probed with the $0 `HUNTER_EMAIL_COUNT`:

    | multiAccount | explicit account | result |
    |---|---|---|
    | on | yes | 400 `ToolRouterV2_NoActiveConnection` |
    | on | no | completed, `instantCharge` $0.000000 |
    | off | yes | 400 "account parameter is not supported" |
    | off | no | completed, `instantCharge` $0.000000 |

    So we rely on routing priority (own > shared > Instant). The guard is `assertInstantRouting()`: a free `session.toolkits()` check that refuses to run if the workspace has an ACTIVE own account on any paid toolkit. Every result is then verified via `instantCharge` / log `credential_source`. `INSTANT_EXPLICIT_ACCOUNT=true` re-enables the explicit path (plus multiAccount) for projects where it works.
  - **Project setting was off at first.** The user enabled "Instant Toolkits" on the dashboard's "default" project. Search then showed `instantAccount` and the statusMessage "Connected via the Composio instant account…".
  - **Search's `instantAccount.allowedToolSlugs` ignores our per-tool allowlist.** It listed all 8 Hunter Instant tools while the session's `instant.tools.hunter.enable` had 2. It describes toolkit eligibility, not the session's effective policy.
  - The budget initially treated any thrown error as "unresolved" (possibly billed). 4xx responses other than 408 are now released, since the tool never ran.

## Gotchas
- The CLI's own account already shows a **Serper** connection (plus a known private **Exa** connection). Under that user id, those calls would run on our keys with no Instant charge. Mitigation: a fresh `COMPOSIO_USER_ID=instant_demo_workspace`, an explicit `account: "instant_account"`, and `discoverTools` flags any own connection on an Instant toolkit.

## Design decisions
- **Session per lead run** (tier 1 and tier 2 separately), with session ids persisted per lead. Per-lead cost then reconciles directly via the `session_id` filter on execution logs and on the usage summary. Session creation is free. Restore with `composio.sessions.use(id)` for reconciliation and retries.
- **Price bounds** (`data/tool_price_bounds.json`): a hand-reviewed max USD per tool. Published prices are strings, not quotes. `discoverTools` fails if a bound is missing or the published description has changed since review.
- **Dev spend cap**: the wallet only has the $2 signup credit, so `DEV_SPEND_CAP_USD=1.50` is enforced against the local ledger (settled + reserved) before every reservation.

- **Enrichment choice:** `HUNTER_COMBINED_ENRICHMENT` ($0.004, person + company in one call) is primary. `APOLLO_PEOPLE_ENRICHMENT` ($0.02–$0.18) runs only when Hunter returns no match. Typical tier-1 wallet cost drops from roughly $0.04–$0.20 to about $0.02 per lead.
- **Slack channel:** `SLACK_SEND_MESSAGE` accepts a channel name or ID, but names fail on Enterprise Grid tokens (`team_not_found`), so `.env` asks for the ID.

- **Tier 2 design:** we run our own Messages API loop. Tool schemas come from `composio.tools.get(userId, { tools })` (direct tools only, no meta tools). Execution uses `composio.provider.executeToolCall(gatedSession, block)`: the *same* provider instance that wrapped the schemas, so sanitized keys are restored, while `gatedSession.execute` routes every call through `clampArgs` → `BudgetedExecutor`. The model only sees the 5 research tools, never Sheets or Slack.
- **Argument clamping is part of the price bound.** A bound only holds if the call matches what the published price describes. Exa: `type=auto`, ≤10 results, no inline `contents` (Instant restrictions anyway). Exa contents: ≤5 URLs, text only (each content type bills per page). Parallel: `mode=fast` (the price is "per Fast search"). Firecrawl scrape: markdown only, no actions/JSON. Firecrawl map: limit ≤100.
- **Budget exhausted mid-research:** the refused call goes back to the model as an `is_error` tool_result. Then one final call with `tool_choice: { type: "none" }` forces a brief from what was gathered.
- **Kill switch:** a persisted SQLite flag (seeded from `INSTANT_ENABLED`), checked before every paid call. New sessions get `instant: false`; in-flight sessions get `session.update({ instant: false })`. Re-enabling resends the full per-kind policy because of the "partial object drops the allowlist" gotcha.
- **Idempotency:** `events` table keyed by `event_id`, plus an email dedupe window (default 24h), claimed inside a `BEGIN IMMEDIATE` transaction. Calendly events use the invitee URI as `event_id`, so a redelivery under a new webhook id still dedupes.
- **Crash safety:** leads left `queued`/`processing`/`researching` at startup are marked `interrupted` and never auto-retried. A paid call may already have run, so reconcile first (`POST /admin/reconcile` or `npm run reconcile`).
- **Lead data is personal:** `GET /admin/leads/:id` sits behind `ADMIN_TOKEN`.
- **Hot threshold:** one value (`HOT_THRESHOLD`, default 75) drives both the tier-1 Slack alert and tier 2. The LLM's `tier` label is informational.

## Prices observed
Published (Get Tool API, `toolkit_versions=latest`, 2026-10-26):

| Tool | Published price | Our bound |
|---|---|---|
| HUNTER_EMAIL_VERIFIER | $0.012 per billed email verification | $0.012 |
| APOLLO_PEOPLE_ENRICHMENT | Estimated $0.02–$0.18 per person (1–9 credits; waterfall may cost more) | $0.18 |
| FIRECRAWL_SCRAPE | $0.003 per basic page scraped | $0.003 |
| SERPER_SEARCH_NEWS | $0.001 per credit | $0.002 |
| PARALLEL_SEARCH_WEB | $0.001 per Fast search (≤10 results) | $0.001 |
| EXA_SEARCH | $0.007 per search | $0.007 |
| EXA_GET_CONTENTS_ACTION | $0.001 per page per content type | $0.005 |
| FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS | $0.003 per basic Map call | $0.003 |

**Real charges** (tier 1, test lead = free-mail address + submitted domain composio.dev, two runs, identical):

| Tool | Published | Actually charged | credential_source |
|---|---|---|---|
| HUNTER_EMAIL_VERIFIER | $0.012 | **$0.00598** | instant_account |
| HUNTER_COMBINED_ENRICHMENT | $0.004 | $0 (failed: no match, not charged) | instant_account |
| FIRECRAWL_SCRAPE | $0.003 | **$0.000798** | instant_account |
| SERPER_SEARCH_NEWS | $0.001/credit | **$0.0003** | instant_account |
| GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND | n/a | $0 | connected_account (own OAuth) |

- **Per-lead tier-1 wallet cost: $0.007078.** Charges sit well below the published prices, consistent with the `discount` field in Get Tool (Hunter 50, Firecrawl 79, Serper 70). The published price acts as a ceiling, which makes it a safe reservation bound.
- **Ledger vs Composio:** the local ledger total ($0.014156 over 2 runs) equals the project usage summary `instant_charge` exactly. Per-session log search (`session_id` filter) shows 4 `instant_account` calls plus 1 `connected_account` call per lead: mixed credentials in one session, confirmed.
- **Bug that cost one extra run (~$0.007):** `JSON.stringify` on a result containing bigint pico-USD throws "Do not know how to serialize a BigInt". It happened after the CRM write, so both runs wrote Sheets rows but the CLI printed nothing. Fixed with a replacer in `store.upsertLead` and covered by a test.

**Live end-to-end test via the webhook server (2026-10-26).** Overrides: `HOT_THRESHOLD=0` to force tier 2, `TIER2_BUDGET_USD=0.10`.

| Tool | Tier | Charged | credential_source |
|---|---|---|---|
| HUNTER_EMAIL_VERIFIER | 1 | $0.00598 | instant_account |
| HUNTER_COMBINED_ENRICHMENT | 1 | $0 (400 invalid_email for a personal address, not charged) | instant_account |
| APOLLO_PEOPLE_ENRICHMENT (fallback) | 1 | **$0.02** (bottom of the $0.02–$0.18 range) | instant_account |
| FIRECRAWL_SCRAPE | 1 | $0.000798 | instant_account |
| SERPER_SEARCH_NEWS | 1 | $0.0003 | instant_account |
| EXA_SEARCH | 2 | $0.007 (no discount) | instant_account |
| EXA_GET_CONTENTS_ACTION | 2 | $0.001 per call (1 URL), $0.003 for 3 URLs | instant_account |

- **Tier 1 with the Apollo fallback: $0.027078.** Tier 1 when Hunter matches or there's no domain: ~$0.007.
- **Tier 2: $0.01 on the first run, $0.009 on the re-run**, so $0.019 total for this lead. Claude Sonnet used 2–3 turns, ~8–14k input and ~1.6–2.1k output tokens.
- **Mixed credentials, one lead:** 10 `instant_account` calls plus 6 `connected_account` calls (Sheets append, Sheets update, Slack alert, Slack thread reply, …).
- **Duplicates:** the same `event_id` returned `duplicate/event_id`; a new id with the same email (different case) returned `duplicate/email_window`. $0 spent on either.
- **Kill switch live:** `POST /admin/instant {"enabled":false}` → a demo booking was processed as `instant_disabled` with 0 ledger rows and $0. It still got its CRM row and a "demo booked, enrichment unavailable" Slack alert.
- **Reconciliation:** `npm run report` shows logs = ledger = usage summary = **$0.060234** for the whole dev run, with 0 unresolved reservations.
- **Bug found live:** tier 2's final JSON brief was truncated at `max_tokens: 1500` (stop_reason `max_tokens`), so no brief was parsed. Fix: 4000 max tokens, per-field length guidance in the prompt (under 350 words, at most 4 signals and 5 sources), and a note recorded when the answer is truncated. Re-ran with `npm run lead -- --research <leadId>` and got a valid cited brief.
- **Report fix:** a research re-run creates a new tier-2 session, so the report now sums every session id the ledger saw for a lead, not only the latest one stored on the lead.
- Scoring judged composio.dev a **competitor** (cold, 12/100) and the tier-2 brief advised not to sales-sequence it. That's a nice demo of the ICP rubric working, but use a real prospect-like lead for screenshots.

Tier-1 expected per lead before the real run (wallet only, excludes Anthropic): best case ≈ $0.036 (Apollo at 1 credit), worst-case reservation $0.197.
Interesting cheap alternatives seen in the sweep: `HUNTER_COMBINED_ENRICHMENT` $0.004, `HUNTER_COMPANY_ENRICHMENT` $0.004, `APOLLO_PEOPLE_SEARCH` $0 (no emails), `APOLLO_ORGANIZATION_ENRICHMENT` $0.02.

## Screenshot moments
- Dashboard → project Settings → "Instant Toolkits" toggle.
- API key permissions: `session_management: write`.
- `npm run discover` table output (eligibility + published price + our bound).
- `npm run lead` output: per-call charges with `source=instant_account`.
- Sheets row with `instant_cost_usd`; Slack hot-lead alert + research-brief thread.
- `npm run report`: logs vs ledger vs usage summary agreeing to the micro-dollar.
- Execution logs in the dashboard showing `credential_source` instant_account vs connected_account in one session.
- `POST /admin/instant {"enabled": false}` then a lead processed as `instant_disabled`.
