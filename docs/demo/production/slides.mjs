// Three intro slides, 1920x1080, in the site's palette and fonts. No more than
// four bullets on a slide, per ETHGlobal's own video tips.
import { chromium } from '/home/ignacio/Work/moveseventyeight/turnstile/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const DIR = process.argv[2];
const b64 = p => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const cover = b64('/home/ignacio/Work/moveseventyeight/turnstile/docs/brand/cover-background-fal.png');
const photo = b64(`${DIR}/photo.png`);
const MARK = '<svg viewBox="0 0 17 17" aria-hidden="true"><rect x="0.5" y="1" width="2" height="15" fill="#e9e5d8"/><rect x="14.5" y="1" width="2" height="15" fill="#e9e5d8"/><rect x="2.5" y="7.5" width="12" height="2" fill="#d2a857"/></svg>';
const HEAD = `<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600&display=block" rel="stylesheet">
<style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#08191a;color:#e9e5d8;font-family:'Public Sans',sans-serif}
.eyebrow{font:500 24px/1 'IBM Plex Mono',monospace;letter-spacing:.2em;text-transform:uppercase;color:#93a8a2}
h1,h2{font-family:'Bricolage Grotesque',sans-serif;margin:0;letter-spacing:-.03em}
.brass{color:#d2a857}
.foot{position:absolute;left:132px;right:132px;bottom:64px;display:flex;justify-content:space-between;font:400 22px/1 'IBM Plex Mono',monospace;letter-spacing:.12em;color:#5f7a74;text-transform:uppercase}
</style>`;

const slides = {
  'slide1-title': `<!doctype html><html><head>${HEAD}<style>
.bg{position:absolute;inset:0;background:url(${cover}) center/cover}
.veil{position:absolute;inset:0;background:linear-gradient(90deg,rgba(8,25,26,.95) 0%,rgba(8,25,26,.85) 45%,rgba(8,25,26,.2) 75%,rgba(8,25,26,0) 100%)}
.copy{position:absolute;left:132px;top:190px;max-width:1000px}
.row{display:flex;align-items:center;gap:36px;margin-top:40px}.row svg{width:120px;height:120px}
h1{font-size:180px;font-weight:800;line-height:.9}
.tag{font:600 56px/1.15 'Bricolage Grotesque',sans-serif;margin-top:48px}
.who{position:absolute;left:132px;bottom:150px;display:flex;align-items:center;gap:28px}
.who img{width:128px;height:128px;border-radius:50%;object-fit:cover;border:3px solid #d2a857}
.who .n{font:600 40px/1.1 'Bricolage Grotesque',sans-serif}.who .h{font:400 26px/1.4 'IBM Plex Mono',monospace;color:#93a8a2}
</style></head><body><div class="bg"></div><div class="veil"></div>
<div class="copy"><div class="eyebrow">ETHOnline 2026 &middot; built from scratch</div>
<div class="row">${MARK}<h1>Turnstile</h1></div>
<div class="tag">A paid lane for onchain data agents.<br><span class="brass">Sell the answer, keep the method.</span></div></div>
<div class="who"><img src="${photo}" alt=""><div><div class="n">Ignacio Pastor</div><div class="h">github.com/IpastorSan</div></div></div>
</body></html>`,

  'slide2-problem': `<!doctype html><html><head>${HEAD}<style>
.wrap{position:absolute;left:132px;right:132px;top:140px}
h2{font-size:110px;font-weight:800;line-height:.95;margin-top:28px}
ul{list-style:none;padding:0;margin:80px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:48px 90px}
li{font:500 38px/1.3 'Public Sans',sans-serif;padding-left:40px;position:relative}
li:before{content:'';position:absolute;left:0;top:18px;width:18px;height:18px;background:#d2a857}
li b{display:block;font:600 28px/1 'IBM Plex Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:#93a8a2;margin-bottom:14px}
</style></head><body><div class="wrap">
<div class="eyebrow">The problem</div>
<h2>Agents can find each other.<br><span class="brass">They can't buy anything.</span></h2>
<ul>
<li><b>No price</b>197 agents in the ERC-8004 registry. One publishes a price.</li>
<li><b>No safe way to pay</b>Letting an agent spend usually means handing it a key.</li>
<li><b>No reason to list</b>Publishing your method gives away your edge.</li>
<li><b>Turnstile</b>Priced offers on ENS, per-call x402 payments, spending mandates.</li>
</ul></div>
<div class="foot"><span>turnstile.moveseventyeight.com</span><span>ETHOnline 2026</span></div></body></html>`,

  'slide3-how': `<!doctype html><html><head>${HEAD}<style>
.wrap{position:absolute;left:132px;right:132px;top:130px}
h2{font-size:120px;font-weight:800;margin-top:26px;line-height:1}
.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;margin-top:84px}
.step{border:2px solid #143b37;background:#0b2122;padding:40px 34px;min-height:330px;position:relative}
.step .k{font:500 24px/1 'IBM Plex Mono',monospace;letter-spacing:.14em;color:#d2a857}
.step h3{font:700 44px/1.05 'Bricolage Grotesque',sans-serif;margin:22px 0 18px;letter-spacing:-.02em}
.step p{font:400 29px/1.35 'Public Sans',sans-serif;color:#93a8a2;margin:0}
.step .who{position:absolute;left:34px;bottom:30px;font:500 24px/1 'IBM Plex Mono',monospace;color:#e9e5d8}
.arrow{position:absolute;right:-22px;top:50%;width:16px;height:16px;border-top:3px solid #d2a857;border-right:3px solid #d2a857;transform:translateY(-50%) rotate(45deg);z-index:2}
</style></head><body><div class="wrap">
<div class="eyebrow">How it works</div>
<h2>Discover. Price. Pay. <span class="brass">Answer.</span></h2>
<div class="flow">
<div class="step"><div class="k">01 DISCOVER</div><h3>Find a seller</h3><p>Agent registries, normalized by a Substreams module.</p><div class="who">The Graph</div><div class="arrow"></div></div>
<div class="step"><div class="k">02 OFFER</div><h3>Read the price</h3><p>Price, rails and endpoint live in the seller's ENS record.</p><div class="who">ENSv2</div><div class="arrow"></div></div>
<div class="step"><div class="k">03 PAY</div><h3>Settle per call</h3><p>HTTP 402, then x402 on Hedera or USDC on Arc.</p><div class="who">Hedera &middot; Arc</div><div class="arrow"></div></div>
<div class="step"><div class="k">04 ANSWER</div><h3>Within a mandate</h3><p>The agent spends under a cap it can never raise itself.</p><div class="who">Privy</div></div>
</div></div>
<div class="foot"><span>turnstile.moveseventyeight.com</span><span>ETHOnline 2026</span></div></body></html>`,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [name, html] of Object.entries(slides)) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${DIR}/${name}.png` });
  console.log('wrote', name);
}
await browser.close();
