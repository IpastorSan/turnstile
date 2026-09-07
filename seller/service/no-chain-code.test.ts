// The acceptance criterion that is easiest to satisfy on the day and hardest to
// keep: **no chain-specific code in `seller/service/`.**
//
// Stating it in a README does not keep it true. MOV-220 and MOV-225 land two
// rails in parallel, and the cheapest way for either to make its own life easier
// is a small `if` in the service — a Hedera-shaped field on the challenge, a
// special case for how Arc reports a payer. Each one is individually reasonable
// and together they are the abstraction gone. So it is asserted here, and a
// branch that reintroduces it fails a test rather than passing review.
//
// ## What this actually proves, and what it does not
//
// It proves that the **code** on the payment path contains no chain, vendor,
// asset or signature-format identifier, and that exactly one file in the
// directory imports a concrete rail. Two limits, stated rather than glossed:
//
//   - Comments are stripped before scanning. The rule is about what the service
//     *does*, and a comment naming the chain a price was verified against is
//     documentation rather than a dependency. `tiers.ts` records that its $0.07
//     came off Sepolia, and that is a fact worth keeping.
//   - It is lexical. It catches the realistic failure — reaching for
//     `payload.hederaTransaction`, branching on `network === 'eip155:296'` — and
//     not a chain-specific idea expressed in neutral words. Nothing mechanical
//     could.
//
// It deliberately does **not** cover `discovery.ts`. That file reads a
// multi-chain agent registry, so chain identifiers are its subject matter rather
// than a leak; it predates this issue (MOV-222) and answers a different
// question. The exemption is by name, so a new file on the payment path is
// covered by default rather than needing to be remembered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files in this directory that are not on the x402 payment path.
 *
 * `server.ts` is the composition root: it names both rails, once, as a list, and
 * that is the whole point of it. `discovery*.ts` is MOV-222's registry reader —
 * see the header.
 */
const NOT_ON_THE_PAYMENT_PATH = new Set([
  'server.ts',
  'discovery.ts',
  'discovery-cli.ts',
  'discovery.test.ts',
  'no-chain-code.test.ts',
]);

/**
 * Build the matcher for one forbidden term.
 *
 * A plain `\bhedera\b` is not enough, and the self-test below is what found
 * that out: the realistic leak is `payload.hederaTransaction` or
 * `arcFacilitatorUrl`, where the term is a camelCase prefix and there is no word
 * boundary after it. So a term matches when it is followed by anything that is
 * not more lowercase — a capital, an underscore, a delimiter, end of line — and
 * the capitalized form matches mid-identifier as well.
 *
 * That second rule is what keeps `arc` usable as a term at all: `Arc` and
 * `arcFacilitator` match, while `arcane`, `search` and `hierarchy` do not.
 */
function term(word: string): RegExp {
  const capital = word[0]!.toUpperCase() + word.slice(1);
  return new RegExp(`(?:(?<![a-z0-9])(?:${word}|${word.toUpperCase()})|${capital})(?![a-z0-9])`);
}

/** Chains, vendors, assets, signature formats and wallet plumbing. */
const FORBIDDEN: [RegExp, string][] = [
  [term('hedera'), 'a chain'],
  [term('hashgraph'), 'a chain SDK'],
  [term('hbar'), 'a native token'],
  [term('blocky402'), 'a facilitator'],
  [term('arc'), 'a chain'],
  [term('circle'), 'a vendor'],
  [term('usdc'), 'an asset'],
  [term('eip155'), 'a chain namespace'],
  [term('solana'), 'a chain namespace'],
  [term('ethereum'), 'a chain'],
  [term('sepolia'), 'a network'],
  [term('viem'), 'a chain library'],
  [term('ethers'), 'a chain library'],
  [term('paymaster'), 'a chain gas mechanism'],
  [term('chainId'), 'a chain identifier'],
  [term('rpcUrl'), 'a chain endpoint'],
  [term('privateKey'), 'a chain key'],
  [term('wei'), 'a chain unit'],
  [term('gwei'), 'a chain unit'],
  [/\beip-?712\b/i, 'a signature format'],
  [/\beip-?3009\b/i, 'a transfer authorization format'],
  [/\berc-?20\b/i, 'a token standard'],
];

/** `import ... from '../../rails/<something concrete>'` */
const CONCRETE_RAIL_IMPORT = /from\s+'[^']*rails\/(hedera-x402|arc-usdc|stub-rail)[^']*'/;

/**
 * Blank out comments, keeping line numbers intact so a failure still points at
 * the right line. Crude — it does not know about `//` inside a string literal —
 * which errs toward scanning less, so a real leak inside a string could hide
 * behind one. Accepted: a leak that has to be smuggled through a comment
 * delimiter inside a string is not the failure mode this guards against.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/^(.*?)\/\/.*$/gm, (_m, before: string) => before);
}

function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter(name => name.endsWith('.ts'))
    .filter(name => !NOT_ON_THE_PAYMENT_PATH.has(name));
}

test('no file on the payment path names a chain, an asset or a signature format', () => {
  const found: string[] = [];
  for (const name of sourceFiles()) {
    const source = stripComments(readFileSync(join(HERE, name), 'utf8'));
    source.split('\n').forEach((line, i) => {
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${name}:${i + 1} mentions ${what} (${pattern}) — ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(found, [], `chain-specific code has leaked into seller/service/:\n${found.join('\n')}`);
});

test('server.ts is the only file in seller/service/ that imports a concrete rail', () => {
  const importers = readdirSync(HERE)
    .filter(name => name.endsWith('.ts'))
    .filter(name => CONCRETE_RAIL_IMPORT.test(readFileSync(join(HERE, name), 'utf8')));

  // `testing.ts` builds two fictional stub rails for the tests. It is allowed a
  // rail import for the same reason `server.ts` is: it composes, it does not
  // branch.
  assert.deepEqual(importers.sort(), ['server.ts', 'testing.ts']);
});

test('the payment path depends on the rail interface, not on any implementation', () => {
  // The positive form of the rule: `x402.ts` reaches for `PaymentRail` and
  // `RailRegistry` and nothing else under `rails/`.
  const source = readFileSync(join(HERE, 'x402.ts'), 'utf8');
  const railImports = new Set([...source.matchAll(/from\s+'([^']*rails\/[^']*)'/g)].map(m => m[1]));
  assert.deepEqual([...railImports].sort(), ['../../rails/PaymentRail.ts', '../../rails/registry.ts']);
});

test('the matcher catches the leaks it is meant to, in the shapes they arrive in', () => {
  // A guard that never fires is indistinguishable from one that cannot. Every
  // line here is a way the abstraction realistically breaks.
  const leaks = [
    "if (payload.accepted.network === 'eip155:296') return settleThroughRelay(payload);",
    'const body = payload.payload.hederaTransaction;',
    'const url = process.env.ARC_FACILITATOR_URL;',
    'import { createPublicClient } from "viem";',
    'const amount = BigInt(requirement.amount) * 10n ** 18n; // gwei',
    'if (rail.info.asset.symbol === "USDC") {}',
    'const signer = new Wallet(privateKey);',
    'const paymasterUrl = config.paymaster;',
  ];
  for (const leak of leaks) {
    assert.ok(FORBIDDEN.some(([pattern]) => pattern.test(leak)), `the matcher missed a leak: ${leak}`);
  }

  // Ordinary prose and neighbouring vocabulary must not trip it, or the guard
  // gets disabled the first time it cries wolf.
  const innocent = [
    'the registry gotchas are unchanged; a hierarchy search over arcane names',
    'const weight = rungs.length; // search the archive',
    'circles.forEach(c => c.render());',
    'archived deployments remain on chain',
  ];
  for (const line of innocent) {
    const hits = FORBIDDEN.filter(([pattern]) => pattern.test(line)).map(([p]) => String(p));
    assert.deepEqual(hits, [], `the matcher tripped on ordinary text: ${line}`);
  }

  // And comment stripping must not become a way to smuggle a leak past it.
  assert.match(stripComments('const a = 1; // eip155:296'), /const a = 1;\s*$/);
  assert.ok(FORBIDDEN.some(([p]) => p.test(stripComments("if (n === 'eip155:296') {} // ok"))));
});
