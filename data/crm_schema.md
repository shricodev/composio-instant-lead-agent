# CRM sheet columns

One row per lead in the `Leads` tab (`GOOGLE_SHEET_TAB`). Column order matches
`CRM_COLUMNS` in `src/outputs/crm.ts`; write the header once with
`npm run lead -- --header --yes`.

| Col | Name | Filled by | Notes |
|---|---|---|---|
| A | received_at | tier 1 | ISO timestamp the row was written |
| B | lead_id | tier 1 | Local id; use with `GET /admin/leads/:id` |
| C | source | intake | `signup`, `demo_booking`, `calendly`, `manual` |
| D | email | intake | |
| E | name | tier 1 | Enriched full name, else submitted name |
| F | company | tier 1 | Enriched company name, else submitted |
| G | domain | tier 1 | Work-email domain, else submitted domain (free-mail ignored) |
| H | title | tier 1 | From Hunter/Apollo |
| I | seniority | tier 1 | |
| J | company_size | tier 1 | Employee count / range |
| K | industry | tier 1 | |
| L | score | tier 1 | 0–100, LLM vs `data/icp.md` |
| M | tier | tier 1 | `hot` / `warm` / `cold` |
| N | summary | tier 1 | 2–3 sentences |
| O | fit_reasons | tier 1 | `;`-separated |
| P | risks | tier 1 | `;`-separated |
| Q | enrichment_status | tier 1 | `enriched`, `partial`, `rejected_email`, `unenriched` (wallet 402), `instant_disabled` |
| R | enrichment_provider | tier 1 | `hunter` or `apollo` |
| S | instant_cost_usd | tier 1 | Actual tier-1 Instant charges for this lead (exact decimal) |
| T | tier2_cost_usd | tier 2 | Actual tier-2 Instant charges (only for hot leads) |
| U | research_brief | tier 2 | Cited brief: what they do, use case, signals, opener, sources |
