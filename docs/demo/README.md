# The demo video

[`turnstile-demo.mp4`](./turnstile-demo.mp4) · 2:40 · 1920×1080 · the ETHOnline 2026 submission video.

Made on 2026-09-13. Every screen in it is the live product or a public explorer, and
every terminal is a real command run that day.

| Part | How it was made |
|---|---|
| Slides (0:00 to 0:43) | Three HTML slides in the site's palette and fonts, rendered by `production/slides.mjs`. The title slide's background art is the FAL-generated cover background (see `docs/brand/README.md`); all text on the slides is typeset, not generated. |
| Browser clips | Playwright driving `turnstile.moveseventyeight.com`, HashScan, ArcScan and GitHub at 1080p (`production/browser.mjs`). The gold circle is a drawn cursor, because Playwright's recording has none. The cap raise on the mandate page was clicked for real and Privy's 401 is its real response. |
| Terminal clips | The real commands run under `script --log-timing` (the 402 curl, `npm run hedera:pay`, `cast nonce`, the Forge fork test), then replayed byte for byte into xterm.js and recorded (`production/term.mjs`). Pauses longer than about a second were shortened, which ETHGlobal's rules allow; nothing was sped up. The Hedera run in the video is a fresh testnet payment made during recording. |
| Voiceover | Ignacio's own voice, recorded as nine takes from `production/voiceover-script.md`. No AI voice or text to speech. |
| Assembly | `production/build.py` fits each section of picture to its take by trimming a clip's tail or holding its last frame, never by changing speed, strips the microphone's power-on click and low rumble, levels loudness, and exports H.264 and AAC. |

The production scripts are kept as they ran. They contain absolute paths from the
machine that made the video and are a record, not a reusable tool.
