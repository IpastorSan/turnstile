// Replay a real `script --log-timing` session into xterm.js and record it at 1080p.
// The bytes are exactly what the command printed; only long waits are shortened,
// which the ETHGlobal rules allow ("skip any unnecessary waiting"). Nothing is sped up.
import { chromium } from '/home/ignacio/Work/moveseventyeight/turnstile/node_modules/playwright/index.mjs';
import { readFile, rename, writeFile } from 'node:fs/promises';

const [dir, name, command, maxPauseArg] = process.argv.slice(2);
const MAX_PAUSE = Number(maxPauseArg ?? 1.2);
const out = await readFile(`${dir}/term/${name}.out`);
const timing = (await readFile(`${dir}/term/${name}.tim`, 'utf8')).trim().split('\n');

// util-linux advanced timing: "O <delay> <bytes>" lines (classic: "<delay> <bytes>").
const chunks = [];
// `script` writes a 'Script started on ...' header line that the timing file does not
// count, so the byte offsets start after it.
let off = out.subarray(0, 15).toString() === 'Script started ' ? out.indexOf(0x0a) + 1 : 0;
for (const line of timing) {
  const p = line.trim().split(/\s+/);
  let delay, n;
  if (p.length === 3) { if (p[0] !== 'O') continue; delay = Number(p[1]); n = Number(p[2]); }
  else { delay = Number(p[0]); n = Number(p[1]); }
  chunks.push([Math.min(delay, MAX_PAUSE), out.subarray(off, off + n).toString('base64')]);
  off += n;
}

const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=block" rel="stylesheet">
<style>html,body{margin:0;background:#08191a;width:1920px;height:1080px;overflow:hidden}
#bar{height:44px;background:#0b2122;border-bottom:1px solid #143b37;display:flex;align-items:center;padding:0 22px;gap:10px;font:500 17px 'IBM Plex Mono',monospace;color:#93a8a2}
.d{width:13px;height:13px;border-radius:50%;background:#1d504a}
#t{position:absolute;left:44px;top:84px;right:44px;bottom:40px}</style></head><body>
<div id="bar"><span class="d"></span><span class="d"></span><span class="d"></span><span style="margin-left:14px">turnstile — ~/Work/moveseventyeight/turnstile</span></div>
<div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: `${dir}/raw-term-${name}`, size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
const t0 = Date.now();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const startMark = (Date.now() - t0) / 1000;
await page.evaluate(async ({ chunks, command }) => {
  const term = new Terminal({ cols: 110, rows: 30, fontFamily: "'IBM Plex Mono', monospace", fontSize: 27, lineHeight: 1.12, cursorBlink: true,
    theme: { background: '#08191a', foreground: '#e9e5d8', cursor: '#d2a857', green: '#8fd18a', brightGreen: '#a8e6a1', red: '#e4593a', yellow: '#d2a857', cyan: '#7fc4bd', brightBlack: '#5f7a74' } });
  term.open(document.getElementById('t'));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(900);
  term.write('\x1b[38;2;210;168;87m$\x1b[0m ');
  for (const ch of command) { term.write(ch); await sleep(28 + Math.random() * 30); }
  await sleep(500);
  term.write('\r\n');
  const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  for (const [delay, b64] of chunks) { await sleep(delay * 1000); await new Promise(r => term.write(dec(b64), r)); }
  await sleep(300);
  term.write('\r\n\x1b[38;2;210;168;87m$\x1b[0m ');
}, { chunks, command });
await new Promise(r => setTimeout(r, 4000));
const video = page.video();
await ctx.close();
await rename(await video.path(), `${dir}/browser/${name}.webm`);
const marksPath = `${dir}/browser/marks-${name}.json`;
const marks = JSON.parse(await readFile(marksPath, 'utf8').catch(() => '{}'));
marks[name] = Math.max(0, startMark - 0.2);
await writeFile(marksPath, JSON.stringify(marks, null, 2));
await browser.close();
console.log('ok', name, 'chunks', chunks.length, 'content starts at', marks[name].toFixed(1), 's');
