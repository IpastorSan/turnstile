// A silent, scripted walkthrough of the product.
//
//   docker compose -f deploy/compose.yaml up -d
//   npm run video
//
// Scripted rather than performed, so it can be re-recorded after any change
// instead of re-acted. There is no audio and no narration: this is a reference
// a judge can scrub, **not** a submission video. Hedera wants ≤5 minutes with a
// paid request on camera and The Graph wants 2–4 minutes; those are
// performances and are still to record. Nothing here satisfies them.
//
// **Pacing is the entire difficulty.** Playwright moves far faster than anyone
// can read, so every beat has an explicit, generous pause. A recording that is
// technically correct and unwatchable is worse than none, because it looks like
// a deliverable in a file listing.

import { mkdir, rename, rm } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const BASE = process.env['CAPTURE_BASE'] ?? 'http://localhost';
const RAW = 'docs/.video-raw';
const OUT = 'docs/walkthrough.webm';

/** Long enough to read the thing that just appeared. */
const READ = 3_500;
const BEAT = 1_600;

async function settle(page: Page, text: RegExp, timeout = 60_000): Promise<void> {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout });
}

/** Scroll at a readable speed instead of teleporting to the bottom. */
async function creep(page: Page, distance: number, steps = 14): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, distance / steps);
    await page.waitForTimeout(140);
  }
}

await rm(RAW, { recursive: true, force: true });
await mkdir(RAW, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  recordVideo: { dir: RAW, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

console.log('recording…');

// 1. The market. The claim the whole project rests on is the headline here:
//    197 registrations, one readable price.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60_000 });
await settle(page, /agents?/i);
await page.waitForTimeout(READ + 1_500);
await creep(page, 900);
await page.waitForTimeout(BEAT);

// 2. One seller, resolved live. The block number is the point: nothing cached.
await page.goto(`${BASE}/seller/liquidity.turnstile.eth`, { waitUntil: 'networkidle', timeout: 60_000 });
await settle(page, /read at block/i);
await page.waitForTimeout(READ);
await creep(page, 1_400);
await page.waitForTimeout(BEAT);

// 3. The mandate: who may authorise what, then what was actually spent.
await page.goto(`${BASE}/mandate`, { waitUntil: 'networkidle', timeout: 60_000 });
await settle(page, /Settled to date/i);
await page.waitForTimeout(READ);
await creep(page, 1_500);
await page.waitForTimeout(BEAT);
await creep(page, 1_800);
await page.waitForTimeout(READ);

// 4. The best beat in the product: ask Privy to raise the cap with one
//    signature against a threshold of two, and let the refusal land. Pause
//    hard here — this is the shot worth stopping on.
const probe = page.getByRole('button', { name: /Attempt a cap raise/i });
await probe.scrollIntoViewIfNeeded();
await page.waitForTimeout(BEAT);
await probe.click();
await settle(page, /does not match the wallet's authorization threshold|Refused/i, 45_000);
await page.waitForTimeout(READ + 2_500);

// 5. Anyone can create their own, with keys that never leave their browser.
await page.goto(`${BASE}/mandate/new`, { waitUntil: 'networkidle', timeout: 60_000 });
await settle(page, /Generate keys here/i);
await page.waitForTimeout(READ);

// 6. And the abuse control that keeps the registry from being a Sybil farm.
await page.goto(`${BASE}/onboard`, { waitUntil: 'networkidle', timeout: 60_000 });
await settle(page, /Selfie Check|not configured/i);
await page.waitForTimeout(READ);

await context.close();
await browser.close();

// Playwright names the file by an internal id; give it a stable one.
const { readdir } = await import('node:fs/promises');
const produced = (await readdir(RAW)).filter(f => f.endsWith('.webm'));
if (produced.length !== 1) throw new Error(`expected one recording, got ${produced.length}`);
await rename(`${RAW}/${produced[0]}`, OUT);
await rm(RAW, { recursive: true, force: true });

console.log(`wrote ${OUT}. Watch it back before committing.`);

// Some submission forms reject webm, so ship an mp4 alongside when ffmpeg is
// present. If it is not, say so rather than leaving a reader to wonder why the
// README links a file that does not exist.
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const run = promisify(execFile);
try {
  await run('ffmpeg', ['-v', 'error', '-i', OUT, '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'docs/walkthrough.mp4', '-y']);
  console.log('wrote docs/walkthrough.mp4 as well.');
} catch {
  console.log('ffmpeg not found — webm only. Some submission forms will not take it.');
}
