// Screenshots of every judge-facing surface, against the running stack.
//
//   docker compose -f deploy/compose.yaml up -d     # the stack must be up
//   npm run capture
//
// A judge who will not clone the repo still needs to see it, so these are
// committed. That makes them a claim like any other, and a raster is a claim no
// `grep` can audit — the architecture diagram in this repo outlived two prose
// corrections for exactly that reason. Look at every image before committing.
//
// **Waiting is the whole difficulty.** These pages read Sepolia, Privy and
// Circle Gateway on each request, so a screenshot taken on load shows a page
// that is structurally complete and empty of the thing it exists to show. Each
// shot therefore waits on text that only appears once real data has landed, and
// FAILS rather than shooting if it does not arrive. A blank screenshot that
// looks fine in a file listing is worse than no screenshot.

import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const BASE = process.env['CAPTURE_BASE'] ?? 'http://localhost';
const OUT = 'docs/screenshots';

interface Shot {
  file: string;
  path: string;
  /** Text that exists only after the page's live data has arrived. */
  settled: RegExp;
  description: string;
  /**
   * Full page, or a bounded height?
   *
   * `fullPage` on the market is a trap: it renders all 197 agents into one
   * image 84,110 pixels tall and 9.2 MB, which is unreadable as a figure and
   * too heavy to commit. A judge needs the top of the table, not all of it.
   */
  clipHeight?: number;
}

const SHOTS: Shot[] = [
  {
    file: 'market.png',
    path: '/',
    settled: /agents?/i,
    description: 'the market, reading real ERC-8004 registrations across three chains',
    clipHeight: 1600,
  },
  {
    file: 'seller.png',
    path: '/seller/liquidity.turnstile.eth',
    settled: /read at block/i,
    description: 'one seller, resolved live from Sepolia — the block number moves on reload',
  },
  {
    file: 'mandate.png',
    path: '/mandate',
    settled: /Settled to date/i,
    description: 'the warm tier: live Privy quorums, and what the agent actually spent',
  },
  {
    file: 'mandate-new.png',
    path: '/mandate/new',
    settled: /Generate keys here/i,
    description: 'creating a mandate, with operator keys generated in the browser',
  },
  {
    file: 'onboard.png',
    path: '/onboard',
    settled: /Selfie Check|not configured/i,
    description: 'World Selfie Check as an abuse control rather than a login',
  },
];

async function capture(page: Page, shot: Shot): Promise<void> {
  const url = `${BASE}${shot.path}`;
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

  if (!response || response.status() >= 400) {
    throw new Error(`${url} returned ${response?.status() ?? 'no response'} — is the stack up?`);
  }

  // Not a timeout. A fixed sleep passes on a fast day and silently captures a
  // skeleton on a slow one, which is the failure this is written to avoid.
  await page.getByText(shot.settled).first().waitFor({ state: 'visible', timeout: 60_000 });

  await page.screenshot(
    shot.clipHeight === undefined
      ? { path: `${OUT}/${shot.file}`, fullPage: true }
      : { path: `${OUT}/${shot.file}`, clip: { x: 0, y: 0, width: 1440, height: shot.clipHeight } },
  );
  console.log(`  ${shot.file.padEnd(18)} ${shot.description}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await context.newPage();

await mkdir(OUT, { recursive: true });
console.log(`capturing ${SHOTS.length} surfaces from ${BASE}\n`);

let failed = 0;
for (const shot of SHOTS) {
  try {
    await capture(page, shot);
  } catch (error) {
    failed += 1;
    console.error(`  ${shot.file.padEnd(18)} FAILED — ${(error as Error).message.split('\n')[0]}`);
  }
}

await browser.close();

if (failed > 0) {
  console.error(`\n${failed} of ${SHOTS.length} failed. Nothing was written for those.`);
  process.exit(1);
}
console.log(`\n${SHOTS.length} written to ${OUT}/. Look at them before committing.`);
