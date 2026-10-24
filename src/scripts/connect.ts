// One-time OAuth for the outputs that run on the workspace's OWN accounts
// (Google Sheets + Slack). Prints a link per toolkit and waits for completion.
//
//   npm run connect

import { createSession } from "../composio.js";
import { OUTPUT_TOOLS } from "../tools.js";

const WAIT_MS = 15 * 60_000;

async function main() {
  // Instant off: this session only exists to hold the OAuth flow.
  const session = await createSession("outputs", { instantEnabled: false });
  const toolkits = [...new Set(OUTPUT_TOOLS.map((t) => t.toolkit))];

  const pending = [];
  for (const tk of toolkits) {
    const req = await session.authorize(tk);
    if (!req.redirectUrl) {
      console.log(`${tk}: already connected (${req.status ?? "ACTIVE"})`);
      continue;
    }
    console.log(`\n${tk}: open this link to connect\n  ${req.redirectUrl}`);
    pending.push(
      req
        .waitForConnection(WAIT_MS)
        .then((acc) => console.log(`✓ ${tk} connected (${acc.id})`))
        .catch((err: unknown) => console.error(`✗ ${tk} not connected: ${String(err)}`)),
    );
  }
  console.log(`\nWaiting up to ${WAIT_MS / 60_000} min for the OAuth flows to finish...`);
  await Promise.all(pending);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
