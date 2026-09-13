// Silent browser clips for the submission video, 1920x1080, live pages only.
// A drawn cursor glides to each click target, because Playwright's recording has no cursor.
import { chromium } from '/home/ignacio/Work/moveseventyeight/turnstile/node_modules/playwright/index.mjs';
import { rename, mkdir, writeFile, readFile } from 'node:fs/promises';

const OUT = process.argv[2];
const only = process.argv.slice(3);
const SITE = 'https://turnstile.moveseventyeight.com';
const HOLD = ms => new Promise(r => setTimeout(r, ms));

const CURSOR = () => {
  const mk = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;left:960px;top:540px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(210,168,87,.35);border:2px solid #d2a857;z-index:2147483647;pointer-events:none;transition:left .7s cubic-bezier(.3,.7,.2,1),top .7s cubic-bezier(.3,.7,.2,1),transform .15s';
    document.documentElement.appendChild(c);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
};

async function moveTo(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(([x, y]) => { const c = document.getElementById('__cursor'); if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; } }, [box.x + box.width / 2, box.y + box.height / 2]);
  await HOLD(850);
}
async function pulse(page) {
  await page.evaluate(() => { const c = document.getElementById('__cursor'); if (c) { c.style.transform = 'scale(.7)'; setTimeout(() => c.style.transform = 'scale(1)', 180); } });
  await HOLD(250);
}
async function smoothScrollTo(page, locator, offset = 160) {
  await page.evaluate(([sel]) => 0, ['']);
  const handle = await locator.elementHandle();
  await page.evaluate(([el, off]) => { const y = el.getBoundingClientRect().top + window.scrollY - off; window.scrollTo({ top: y, behavior: 'smooth' }); }, [handle, offset]);
  await HOLD(1600);
}
async function rejectCookies(page) {
  const reject = page.getByRole('button', { name: /^reject/i }).first();
  if (await reject.isVisible({ timeout: 6000 }).catch(() => false)) { await reject.click(); await HOLD(1200); }
}

const CLIPS = {
  async 's1-market'(page, mark) {
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/posts a price/i).first().waitFor({ timeout: 60000 });
    await HOLD(1500); mark();
    await HOLD(5000);
    await smoothScrollTo(page, page.getByText('ranked by settled volume').first(), 120);
    await moveTo(page, page.getByText('liquidity.turnstile.eth').first());
    await HOLD(5500);
  },
  async 's2-seller'(page, mark) {
    await page.goto(`${SITE}/seller/liquidity.turnstile.eth`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/read at block/i).first().waitFor({ timeout: 60000 });
    await HOLD(1500); mark();
    await HOLD(4000);
    await moveTo(page, page.getByText(/read at block/i).first());
    await HOLD(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(/read at block/i).first().waitFor({ timeout: 60000 });
    await page.evaluate(CURSOR);
    await moveTo(page, page.getByText(/read at block/i).first());
    await HOLD(3500);
    await smoothScrollTo(page, page.getByText('What the resolver returns').first(), 100);
    await HOLD(5500);
  },
  async 's4a-mandate'(page, mark) {
    await page.goto(`${SITE}/mandate`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/Settled to date/i).first().waitFor({ timeout: 60000 });
    await HOLD(1500); mark();
    await HOLD(5000);
    const btn = page.getByRole('button', { name: /Attempt a cap raise with one signature/i });
    await smoothScrollTo(page, btn, 380);
    await moveTo(page, btn);
    await HOLD(800);
    await pulse(page);
    await btn.click();
    await page.locator('.probe-result').first().waitFor({ timeout: 60000 });
    await HOLD(7000);
  },
  async 's4b-arcscan'(page, mark) {
    await page.goto('https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1', { waitUntil: 'domcontentloaded' });
    await rejectCookies(page);
    await page.getByText(/Success/).first().waitFor({ timeout: 90000 });
    await HOLD(2500); mark();
    await moveTo(page, page.getByText('submitBatch').first());
    await HOLD(6000);
  },
  async 's3c-hashscan'(page, mark) {
    const tx = process.env.HEDERA_TX;
    await page.goto(`https://hashscan.io/testnet/transaction/${tx}`, { waitUntil: 'domcontentloaded' });
    await rejectCookies(page);
    await page.getByText('SUCCESS').first().waitFor({ timeout: 90000 });
    await HOLD(2500); mark();
    await moveTo(page, page.getByText('SUCCESS').first());
    await HOLD(5000);
    await page.goto('https://hashscan.io/testnet/topic/0.0.10408013', { waitUntil: 'domcontentloaded' });
    await rejectCookies(page);
    await page.getByText(/Topic/).first().waitFor({ timeout: 90000 });
    await page.evaluate(CURSOR);
    await HOLD(6500);
  },
  async 's6-evidence'(page, mark) {
    await page.goto('https://github.com/IpastorSan/turnstile/blob/main/docs/EVIDENCE.md', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: /Settlement: the money actually moves/i }).first().waitFor({ timeout: 90000 });
    await HOLD(1500); mark();
    await HOLD(2500);
    await smoothScrollTo(page, page.getByRole('heading', { name: /Settlement: the money actually moves/i }).first(), 90);
    await HOLD(4000);
    await smoothScrollTo(page, page.getByRole('heading', { name: /What is not live/i }).first(), 90);
    await HOLD(5000);
  },
};

await mkdir(OUT, { recursive: true });
const marks = JSON.parse(await readFile(`${OUT}/marks.json`, 'utf8').catch(() => '{}'));
const browser = await chromium.launch();
for (const [name, fn] of Object.entries(CLIPS)) {
  if (only.length && !only.includes(name)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark', recordVideo: { dir: `${OUT}/raw-${name}`, size: { width: 1920, height: 1080 } } });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const t0 = Date.now();
  let start = 0;
  try {
    await fn(page, () => { start = (Date.now() - t0) / 1000; });
    const video = page.video();
    await ctx.close();
    await rename(await video.path(), `${OUT}/${name}.webm`);
    marks[name] = Math.max(0, start - 0.4);
    console.log('ok  ', name, 'content starts at', marks[name].toFixed(1), 's');
  } catch (e) {
    console.log('FAIL', name, String(e.message).split('\n')[0]);
    await ctx.close().catch(() => {});
  }
}
await writeFile(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
await browser.close();
