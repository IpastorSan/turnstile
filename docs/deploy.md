# Deploying the web app

Date: 2026-09-07
Issue: MOV-230

**Status: not deployed.** No hosting credentials exist on the build machine — no
Vercel, Netlify, Fly or Cloudflare CLI, and no token for any of them. Everything
below is verified to work locally; the public URL is the one step that could not
be taken. **The submission needs this URL** (ENS accepts "a video recording *or*
a live demo link"; we want both), so this is a real open item, not a nicety.

---

## What is verified

The production bundle was built and run in an isolated directory, with the
repository's working store deliberately absent, to reproduce what a deployment
actually sees:

```
$ cd web && npm run build && cp -r .next/static .next/standalone/web/.next/
$ cp -r .next/standalone /tmp/standalone-test
$ cd /tmp/standalone-test/web && PORT=3211 node server.js

$ curl -s localhost:3211/api/sellers?limit=200 | jq -c '.result.priceSources'
{"turnstile":1,"x402":0,"document":0,"ask_x402":97,"none":99}

$ curl -s localhost:3211/api/offer/liquidity.turnstile.eth | jq -c '{ok,readAtBlock,linked}'
{"ok":true,"readAtBlock":11654544,"linked":true}

$ curl -s localhost:3211/ | grep -o 'class="cell is-[a-z]*"' | sort | uniq -c
     97 class="cell is-ask"
     99 class="cell is-none"
      1 class="cell is-turnstile"
```

Zero server errors. The market page served all 197 agents from the committed
snapshot, and the seller page read Sepolia live at block 11,654,544.

### Three files are read by path, not imported

`output: 'standalone'` does not find these on its own, and the failure mode is
nasty — everything works in development and the deployed site 500s. They are
pinned in `web/next.config.ts` under `outputFileTracingIncludes`:

| File | Read by | Symptom if missing |
|---|---|---|
| `contracts/addresses.turnstile.sepolia.json` | `web/lib/ens.ts` | Seller page cannot resolve any name |
| `graph/sink/schema.sql` | `openDb` on every connect | Market page 500s with `ENOENT` |
| `web/data/**` | the snapshot store | Market page reports no store loaded |

`graph/sink/schema.sql` was found only by running the standalone bundle in a
clean directory. Do not remove that step from the release check.

---

## Docker — the portable path

```bash
docker build -f web/Dockerfile -t turnstile-web .   # from the REPO ROOT
docker run -p 3210:3210 -e SEPOLIA_RPC_URL=https://... turnstile-web
```

The build context must be the repository root: the app imports
`seller/service/discovery.ts` and `graph/sink/ens.ts` directly rather than
vendoring copies, so `web/` alone is not a complete input.

This runs on Fly, Railway, Render, or any host that takes a container.

## Vercel

The app is a Next.js 16 app in a subdirectory of a repo it imports from, so:

- **Root Directory:** `web`
- **Include source files outside of the Root Directory:** **on**. Without it the
  build cannot see `graph/`, `seller/` or `contracts/` and fails at compile.
- **Environment variable:** `SEPOLIA_RPC_URL`

```bash
npm i -g vercel && vercel login
vercel --cwd web
```

## Required environment

| Variable | Needed for | Missing behaviour |
|---|---|---|
| `SEPOLIA_RPC_URL` | Seller page, `/api/offer/:name` | The page states the resolver cannot be read. It does not serve a cached price. |

Nothing else is required. The discovery data ships in the image as
`web/data/discovery.db`.

**Never set a private key on this deployment.** The web app only reads — it has
no write path, and no route signs anything.

## After deploying

1. Check `GET /api/health` — it reports whether the store and the RPC are
   reachable.
2. Record the URL in `CHECKLIST.md` and in the submission copy.
3. Re-cut the snapshot (`cd web && npm run snapshot`) before submitting, so the
   directory shown is close to the judging date, and commit it.
