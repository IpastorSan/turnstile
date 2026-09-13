// Composite the cover: FAL background art + the fare-gate mark + real type.
// Usage, from the repo root: node docs/brand/render-cover.mjs docs/brand/cover-background-fal.png docs/brand/cover-1920x1080.png
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const [bg, out] = process.argv.slice(2);
const bgData = 'data:image/png;base64,' + readFileSync(bg).toString('base64');

const html = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500&display=block" rel="stylesheet">
<style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#08191a}
  .bg{position:absolute;inset:0;background:url(${bgData}) center/cover no-repeat}
  .veil{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,25,26,.94) 0%,rgba(8,25,26,.82) 38%,rgba(8,25,26,.25) 70%,rgba(8,25,26,0) 100%)}
  .copy{position:absolute;left:132px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;max-width:980px}
  .eyebrow{font:500 26px/1 'IBM Plex Mono',monospace;letter-spacing:.22em;text-transform:uppercase;color:#93a8a2;margin-bottom:44px}
  .row{display:flex;align-items:center;gap:40px}
  .row svg{width:132px;height:132px;flex:none}
  h1{font:800 196px/.9 'Bricolage Grotesque',sans-serif;letter-spacing:-.035em;color:#e9e5d8;margin:0}
  .tag{font:500 58px/1.12 'Bricolage Grotesque',sans-serif;color:#e9e5d8;margin:56px 0 0;letter-spacing:-.01em}
  .tag b{color:#d2a857;font-weight:700}
  .sub{font:400 30px/1.4 'Public Sans',sans-serif;color:#93a8a2;margin-top:28px;max-width:880px}
  .foot{position:absolute;left:132px;bottom:72px;font:400 24px/1 'IBM Plex Mono',monospace;letter-spacing:.14em;color:#5f7a74;text-transform:uppercase}
</style></head><body>
<div class="bg"></div><div class="veil"></div>
<div class="copy">
  <div class="eyebrow">ETHOnline 2026 &middot; built from scratch</div>
  <div class="row">
    <svg viewBox="0 0 17 17" aria-hidden="true"><rect x="0.5" y="1" width="2" height="15" fill="#e9e5d8"/><rect x="14.5" y="1" width="2" height="15" fill="#e9e5d8"/><rect x="2.5" y="7.5" width="12" height="2" fill="#d2a857"/></svg>
    <h1>Turnstile</h1>
  </div>
  <p class="tag">A paid lane for onchain data agents.<br><b>Sell the answer, keep the method.</b></p>
  <p class="sub">Pay-per-call analysis over x402 on Hedera and USDC on Arc, discovered with The Graph.</p>
</div>
<div class="foot">turnstile.moveseventyeight.com</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
await browser.close();
console.log('wrote', out);
