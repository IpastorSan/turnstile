-- Turnstile discovery store.
--
-- The shape follows the three-way join discovery actually is:
--
--   1. `agent`            — who exists, from the ERC-8004 registry (Substreams).
--   2. `agent_card`       — the registration document, resolved off-module here
--                           because a Substreams module cannot fetch ipfs:// or
--                           https://. Failures are recorded, not swallowed.
--   3. `turnstile_seller` — what OUR sellers cost, read from their ENSv2
--                           resolver records.
--
-- Price is deliberately not a column on `agent`. EIP-8004 registration-v1 has
-- no price field and a survey of 1,200 live registrations found zero carrying
-- one, so the registry can never answer "what does this cost". `price_source`
-- in `agent_current` says where a price came from, or that there is none.

PRAGMA journal_mode = WAL;
-- A long sink run holds write transactions in 500-block batches; a reader or a
-- second writer should wait for them rather than fail instantly.
PRAGMA busy_timeout = 15000;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Registry: who exists, cross-chain
-- ---------------------------------------------------------------------------

-- Current state per agent, folded from the event stream by keeping the highest
-- (block_number, log_index) per agent_uid. REGISTERED rows are an agent's first
-- appearance; URI_UPDATED rows carry the same identity with a new document.
CREATE TABLE IF NOT EXISTS agent (
  agent_uid             TEXT PRIMARY KEY,   -- eip155:<chain_id>:<registry>/<agent_id>
  namespace             TEXT NOT NULL,
  chain_id              INTEGER NOT NULL,
  network               TEXT NOT NULL,
  registry              TEXT NOT NULL,
  agent_id              TEXT NOT NULL,      -- uint256 as decimal string

  owner                 TEXT NOT NULL,
  operator              TEXT NOT NULL,      -- agentWallet: where the agent is paid
  operator_source       TEXT NOT NULL,      -- OWNER_DEFAULT | AGENT_WALLET

  agent_uri             TEXT NOT NULL DEFAULT '',
  uri_scheme            TEXT NOT NULL,      -- DATA | INLINE_JSON | IPFS | HTTPS | HTTP | EMPTY | OTHER
  in_module_resolved    INTEGER NOT NULL DEFAULT 0,

  -- Document fields as decoded IN-MODULE. Zero-valued when in_module_resolved
  -- is 0 — that is absence of data, not a claim the agent has none.
  name                  TEXT,
  description           TEXT,
  image                 TEXT,
  x402_support          INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 0,
  supported_trust       TEXT,               -- JSON array
  price_amount          TEXT,
  price_currency        TEXT,
  price_asset           TEXT,
  price_network         TEXT,
  price_scheme          TEXT,

  last_event            TEXT NOT NULL,      -- REGISTERED | URI_UPDATED
  block_number          INTEGER NOT NULL,
  block_timestamp       INTEGER NOT NULL,   -- unix seconds
  transaction_hash      TEXT NOT NULL,
  log_index             INTEGER NOT NULL,

  first_seen_block      INTEGER NOT NULL,
  first_seen_timestamp  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_by_chain    ON agent(chain_id, block_number DESC);
CREATE INDEX IF NOT EXISTS agent_by_recency  ON agent(block_timestamp DESC);
CREATE INDEX IF NOT EXISTS agent_by_x402     ON agent(x402_support) WHERE x402_support = 1;
CREATE INDEX IF NOT EXISTS agent_by_operator ON agent(operator);

-- agentWallet changes. Kept as history because an agent can repoint its payout
-- address without touching its URI, and because "who got paid at block N" is a
-- question the receipts in MOV-220 will need to answer.
CREATE TABLE IF NOT EXISTS agent_wallet_update (
  agent_uid        TEXT NOT NULL,
  wallet           TEXT NOT NULL,
  block_number     INTEGER NOT NULL,
  block_timestamp  INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  PRIMARY KEY (agent_uid, block_number, log_index)
);

-- ---------------------------------------------------------------------------
-- 2. Off-module resolution: the ~72% the Substreams module cannot see
-- ---------------------------------------------------------------------------

-- One row per agent whose document had to be fetched off-chain, INCLUDING the
-- ones that failed. A 404 or a timeout is a recorded outcome, not a gap: it is
-- the difference between "this agent advertises nothing" and "we could not ask".
CREATE TABLE IF NOT EXISTS agent_card (
  agent_uid        TEXT PRIMARY KEY REFERENCES agent(agent_uid) ON DELETE CASCADE,
  -- Which URI this row is about. If agent.agent_uri later changes, the row is
  -- stale and gets re-fetched.
  agent_uri        TEXT NOT NULL,
  source           TEXT NOT NULL,   -- in_module | https | http | ipfs
  fetched_url      TEXT,            -- the URL actually hit (ipfs:// -> gateway)
  status           TEXT NOT NULL,   -- resolved | http_error | timeout | network_error | parse_error | unsupported_scheme
  http_status      INTEGER,
  error            TEXT,
  duration_ms      INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  attempted_at     INTEGER NOT NULL,
  resolved_at      INTEGER,

  name             TEXT,
  description      TEXT,
  image            TEXT,
  x402_support     INTEGER,
  active           INTEGER,
  supported_trust  TEXT,            -- JSON array
  price_amount     TEXT,
  price_currency   TEXT,
  price_asset      TEXT,
  price_network    TEXT,
  price_scheme     TEXT,
  raw_json         TEXT             -- the document as fetched, for auditing
);

CREATE INDEX IF NOT EXISTS agent_card_by_status ON agent_card(status);

-- Service endpoints, from whichever document won (in-module or fetched).
CREATE TABLE IF NOT EXISTS agent_endpoint (
  agent_uid  TEXT NOT NULL REFERENCES agent(agent_uid) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  source     TEXT NOT NULL,         -- in_module | fetched
  name       TEXT,                  -- endpoint role: web, A2A, MCP, x402
  uri        TEXT,
  version    TEXT,
  skills     TEXT,                  -- JSON array
  domains    TEXT,                  -- JSON array
  PRIMARY KEY (agent_uid, idx)
);

CREATE INDEX IF NOT EXISTS agent_endpoint_by_name ON agent_endpoint(name);

-- Normalized capability tokens, so "filter by capability" is an index lookup
-- rather than a LIKE over free text. Derived from OASF skills/domains and
-- endpoint roles; `source` says which, because a match on a declared skill is
-- stronger evidence than a match on an endpoint's protocol name.
CREATE TABLE IF NOT EXISTS agent_capability (
  agent_uid  TEXT NOT NULL REFERENCES agent(agent_uid) ON DELETE CASCADE,
  capability TEXT NOT NULL,         -- lowercased
  source     TEXT NOT NULL,         -- skill | domain | endpoint | trust
  PRIMARY KEY (agent_uid, capability, source)
);

CREATE INDEX IF NOT EXISTS agent_capability_by_cap ON agent_capability(capability);

-- ---------------------------------------------------------------------------
-- 3. Turnstile sellers: what OUR agents cost, from ENSv2 resolver records
-- ---------------------------------------------------------------------------

-- The registry tells you who exists; this table tells you what they cost.
-- Populated by hydrate-sellers.ts, which reads ENSIP-25/26 + turnstile:* text
-- records off the PermissionedResolver. `agent_uid` is the join back into
-- `agent`, derived from the ENSIP-25 agent-registration[...] key, so the link
-- is the one the name itself asserts rather than one we assume.
CREATE TABLE IF NOT EXISTS turnstile_seller (
  ens_name          TEXT PRIMARY KEY,
  node              TEXT NOT NULL,   -- namehash
  resolver          TEXT NOT NULL,
  chain_id          INTEGER NOT NULL,
  agent_uid         TEXT,            -- NULL until the ENSIP-25 record is found
  agent_context     TEXT,            -- ENSIP-26 agent-context
  mcp_endpoint      TEXT,            -- ENSIP-26 agent-endpoint[mcp]
  price             TEXT,            -- turnstile:price
  price_ceiling     TEXT,            -- turnstile:price-ceiling
  rails             TEXT,            -- turnstile:rails, comma separated
  operator_proof    TEXT,            -- turnstile:operator-proof
  payout_addr       TEXT,            -- addr(60)
  resolver_verified INTEGER NOT NULL DEFAULT 0,  -- VerifiableFactory check passed
  read_at           INTEGER NOT NULL,
  read_at_block     INTEGER
);

CREATE INDEX IF NOT EXISTS turnstile_seller_by_agent ON turnstile_seller(agent_uid);

-- A live HTTP 402 quote, for agents that are not ours. This is the third leg of
-- the join: under x402 the price only exists in the response, so the only way to
-- know it is to ask. Cached with a timestamp because a quote is perishable.
CREATE TABLE IF NOT EXISTS x402_quote (
  agent_uid    TEXT NOT NULL REFERENCES agent(agent_uid) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  status       TEXT NOT NULL,   -- quoted | no_402 | http_error | timeout | network_error | parse_error
  http_status  INTEGER,
  error        TEXT,
  amount       TEXT,            -- as advertised, smallest unit when asset is set
  currency     TEXT,
  asset        TEXT,
  network      TEXT,
  scheme       TEXT,
  pay_to       TEXT,
  raw_json     TEXT,
  probed_at    INTEGER NOT NULL,
  PRIMARY KEY (agent_uid, endpoint)
);

-- ---------------------------------------------------------------------------
-- Seams: tables that exist so the join has somewhere to land, and are empty
-- ---------------------------------------------------------------------------

-- Settled volume is the ranking signal we actually want; it comes from Hedera
-- Consensus Service receipts. Discovery ranks by this table when it has rows and
-- says so; when it is empty it falls back to registration recency and LABELS the
-- result a placeholder. It never fakes a number.
--
-- **Correction (2026-09-07, MOV-220):** this comment previously said the
-- receipts "do not exist yet". They do — `rails/hedera-x402/hcs.ts` writes one
-- per settled payment to a topic, and `graph/sink/ingest-receipts.ts` reads the
-- topic back off the public mirror node and fills this table. The seam
-- description was otherwise right and is unchanged.
--
-- **Correction (2026-09-07, MOV-220):** `amount` was commented as "smallest unit
-- of `asset`". That is wrong and always was: `settled_volume` below sums it with
-- `CAST(amount AS REAL)` across every rail, which only means anything if the
-- number means the same thing on all of them, and MOV-222's own test inserts
-- '5.00' expecting 5. It holds **decimal US dollars**, with `currency` naming
-- the unit. The atomic amount stays on the HCS message and on chain, where it is
-- exact.
CREATE TABLE IF NOT EXISTS settlement_receipt (
  receipt_id     TEXT PRIMARY KEY,   -- the rail-native settlement id (a Hedera transaction id)
  agent_uid      TEXT NOT NULL,
  buyer          TEXT,
  amount         TEXT NOT NULL,   -- decimal US dollars; see the correction above
  currency       TEXT,
  asset          TEXT,
  rail           TEXT,            -- x402 | usdc-arc
  settled_at     INTEGER NOT NULL,
  hcs_topic_id   TEXT,
  hcs_sequence   INTEGER,
  hcs_consensus  INTEGER
);

CREATE INDEX IF NOT EXISTS settlement_receipt_by_agent ON settlement_receipt(agent_uid, settled_at DESC);

-- MOV-223. Written by identity/store.ts once an operator completes Selfie Check.
-- An agent with no row here reads as 'unknown', never 'unverified': absence of a
-- proof is not evidence of a failed one.
--
-- `nullifier` is deliberately NOT unique. One human may hold several listings
-- (identity/limits.ts caps it), so a unique index would refuse their second
-- listing rather than their fourth. The index below is for counting.
CREATE TABLE IF NOT EXISTS world_verification (
  -- No FK on agent_uid, deliberately, and this column of comments is the
  -- scar from the live 500 it caused on 2026-09-11. A proof is recorded
  -- BEFORE any agent row exists — that is the whole onboarding order: verify
  -- the human, then register the listing. The sink's `agent` table only
  -- holds on-chain registrations, so verifying our own ENS listing (which
  -- lives in the manifest, not the graph) died with FOREIGN KEY constraint
  -- failed. The FK was enforcing a dependency that must not exist.
  agent_uid    TEXT PRIMARY KEY,
  status       TEXT NOT NULL,     -- verified | rejected
  nullifier    TEXT,
  proof_ref    TEXT,
  verified_at  INTEGER NOT NULL
);

-- "How many listings does this human already hold" is the hot query for every
-- listing decision, and it is a scan without this.
CREATE INDEX IF NOT EXISTS world_verification_by_nullifier
  ON world_verification(nullifier, status);

-- ---------------------------------------------------------------------------
-- Bookkeeping
-- ---------------------------------------------------------------------------

-- How far the sink has consumed each chain, so a re-run resumes rather than
-- restarts. One row per network.
CREATE TABLE IF NOT EXISTS sink_cursor (
  network        TEXT PRIMARY KEY,
  chain_id       INTEGER NOT NULL,
  registry       TEXT NOT NULL,
  start_block    INTEGER NOT NULL,
  last_block     INTEGER NOT NULL,
  blocks_seen    INTEGER NOT NULL DEFAULT 0,
  rows_written   INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- The read model
-- ---------------------------------------------------------------------------

-- One row per agent with the best document we have, wherever it came from, and
-- an explicit account of how a price is (or is not) knowable.
--
-- price_source:
--   turnstile — our ENSv2 turnstile:price record. Exact, signed by the seller's
--               hot key, bounded by a cold-key ceiling.
--   x402      — a live HTTP 402 quote we fetched from the agent's endpoint.
--   document  — a non-standard price object in the registration document.
--               Expect zero of these; the field exists so we notice if it ever
--               stops being zero.
--   ask_x402  — no price, but the agent advertises x402 support: the price is
--               knowable, we just have not asked yet.
--   none      — no price and no way to get one.
CREATE VIEW IF NOT EXISTS agent_current AS
SELECT
  a.agent_uid,
  a.chain_id,
  a.network,
  a.registry,
  a.agent_id,
  a.owner,
  a.operator,
  a.operator_source,
  a.agent_uri,
  a.uri_scheme,
  a.last_event,
  a.block_number,
  a.block_timestamp,
  a.transaction_hash,
  -- When the agent FIRST appeared, as against when its document last changed.
  -- The recency ranking uses this: an agent that repointed its URI yesterday is
  -- not a newer agent than one registered yesterday.
  a.first_seen_block,
  a.first_seen_timestamp,

  -- A Turnstile seller's agentURI is its ENS name, so there is no document to
  -- fetch: the ENSIP-26 records ARE its document, and they fill in last.
  COALESCE(c.name, a.name, s.ens_name)                    AS name,
  COALESCE(c.description, a.description, s.agent_context) AS description,
  COALESCE(c.image, a.image)             AS image,
  COALESCE(c.x402_support, a.x402_support, 0) AS x402_support,
  COALESCE(c.active, a.active, 0)        AS active,
  COALESCE(c.supported_trust, a.supported_trust) AS supported_trust,

  a.in_module_resolved,
  -- in_module    the module decoded it from the chain (data: or bare JSON)
  -- off_module   the sink fetched it (https/http/ipfs)
  -- failed       we tried and could not: 404, gone, DNS, timeout
  -- no_uri       the registration carries no URI at all
  -- not_fetchable a URI in a scheme nothing can GET. Our own sellers land here:
  --              their agentURI is their ENS name, and the offer is read off
  --              the resolver instead — see turnstile_seller.
  -- pending      fetchable, not yet attempted
  CASE
    WHEN a.in_module_resolved = 1 THEN 'in_module'
    WHEN c.status = 'resolved'    THEN 'off_module'
    WHEN c.agent_uid IS NOT NULL  THEN 'failed'
    WHEN a.uri_scheme = 'EMPTY'   THEN 'no_uri'
    WHEN a.uri_scheme NOT IN ('HTTPS', 'HTTP', 'IPFS') THEN 'not_fetchable'
    ELSE 'pending'
  END                                    AS document_state,
  c.status                               AS fetch_status,
  c.http_status                          AS fetch_http_status,
  c.error                                AS fetch_error,

  -- Turnstile sellers: the only leg of the join that carries an exact price.
  s.ens_name                             AS turnstile_name,
  s.mcp_endpoint                         AS turnstile_mcp_endpoint,
  s.rails                                AS turnstile_rails,
  s.price                                AS turnstile_price,
  s.price_ceiling                        AS turnstile_price_ceiling,
  s.payout_addr                          AS turnstile_payout_addr,
  s.resolver_verified                    AS turnstile_resolver_verified,

  -- A live 402 quote, when one has been fetched. One endpoint per agent: the
  -- most recently probed, so multiple priced endpoints cannot fan the row out.
  q.endpoint                             AS x402_endpoint,
  q.amount                               AS x402_amount,
  q.currency                             AS x402_currency,
  q.asset                                AS x402_asset,
  q.network                              AS x402_network,
  q.probed_at                            AS x402_probed_at,

  -- A non-standard price object in the registration document. Expect NULL:
  -- zero of 1,200 surveyed registrations carried one. The column exists so we
  -- would notice if that ever changed.
  COALESCE(c.price_amount, a.price_amount)     AS doc_price_amount,
  COALESCE(c.price_currency, a.price_currency) AS doc_price_currency,
  COALESCE(c.price_asset, a.price_asset)       AS doc_price_asset,

  -- Where a price could come from. Units differ per source, so normalising to
  -- a comparable number is discovery.ts's job, not the view's.
  CASE
    WHEN s.price IS NOT NULL                                  THEN 'turnstile'
    WHEN q.amount IS NOT NULL                                 THEN 'x402'
    WHEN COALESCE(c.price_amount, a.price_amount) IS NOT NULL THEN 'document'
    WHEN COALESCE(c.x402_support, a.x402_support, 0) = 1      THEN 'ask_x402'
    ELSE 'none'
  END                                    AS price_source,

  -- MOV-220 seam. Zero until HCS receipts exist; a 0 here means "no receipts
  -- yet", not "no business". Discovery says which it is rather than ranking on
  -- it silently.
  (SELECT COUNT(*) FROM settlement_receipt r WHERE r.agent_uid = a.agent_uid) AS settled_count,
  (SELECT COALESCE(SUM(CAST(r.amount AS REAL)), 0) FROM settlement_receipt r WHERE r.agent_uid = a.agent_uid) AS settled_volume,

  -- MOV-223 seam. Always 'unknown' until World verification lands.
  COALESCE(w.status, 'unknown')          AS world_verification
FROM agent a
LEFT JOIN agent_card        c ON c.agent_uid = a.agent_uid AND c.agent_uri = a.agent_uri
LEFT JOIN turnstile_seller  s ON s.agent_uid = a.agent_uid
LEFT JOIN world_verification w ON w.agent_uid = a.agent_uid
LEFT JOIN (
  SELECT agent_uid, endpoint, amount, currency, asset, network, probed_at
  FROM x402_quote
  WHERE status = 'quoted'
  GROUP BY agent_uid
  HAVING probed_at = MAX(probed_at)
) q ON q.agent_uid = a.agent_uid;
