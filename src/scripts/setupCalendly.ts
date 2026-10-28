// Optional input source: Calendly "meeting scheduled" -> /webhooks/composio.
// 1. Connects Calendly for COMPOSIO_USER_ID (own OAuth, not Instant) if needed.
// 2. Creates the CALENDLY_MEETING_SCHEDULED trigger instance.
// Composio then delivers signed events to the webhook URL configured for the
// project (dashboard -> Settings -> Webhooks); point it at <public-url>/webhooks/composio
// and put the signing secret in COMPOSIO_WEBHOOK_SECRET.
//
//   npm run calendly

import { getComposio } from "../composio.js";
import { loadConfig } from "../config.js";

const TRIGGER = "CALENDLY_MEETING_SCHEDULED";

async function main() {
  const cfg = loadConfig();
  const composio = getComposio();

  const accounts = await composio.connectedAccounts.list({ userIds: [cfg.COMPOSIO_USER_ID], toolkitSlugs: ["calendly"], statuses: ["ACTIVE"] });
  let accountId = accounts.items[0]?.id;
  if (!accountId) {
    const session = await composio.sessions.create(cfg.COMPOSIO_USER_ID, { toolkits: ["calendly"], instant: false });
    const req = await session.authorize("calendly");
    console.log(`Connect Calendly:\n  ${req.redirectUrl}\nWaiting up to 10 min...`);
    accountId = (await req.waitForConnection(10 * 60_000)).id;
  }
  console.log(`Calendly connected account: ${accountId}`);

  const trigger = await composio.triggers.create(cfg.COMPOSIO_USER_ID, TRIGGER, {
    connectedAccountId: accountId,
    triggerConfig: { scope: "user" },
  });
  console.log(`Trigger created: ${trigger.triggerId} (${TRIGGER})`);
  console.log("\nNext: set the project webhook URL to <your-public-url>/webhooks/composio and COMPOSIO_WEBHOOK_SECRET to its signing secret.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
