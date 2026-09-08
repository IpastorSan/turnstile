// A buyer's agent, in about a hundred lines, that knows nothing about any seller.
//
// This is the file to read if you want to check the reusable-infrastructure
// claim. Search it for a seller name, a price, a payout address, a URL, a chain
// or a product schema and you will not find one. Everything it acts on arrives
// at runtime: the capability it needs comes from its task, the seller comes from
// `find_sellers`, the price and the payout account come from the seller's own
// 402, and the shape of the answer is whatever the seller sent.
//
// It talks to the Turnstile MCP server over stdio and to nothing else. It holds
// no account with any seller and no API key of any kind. The one credential in
// the process is the buyer's own wallet key, which lives in the MCP server's
// environment and signs one transfer inside a mandate it cannot widen.
//
// ## Where the LLM would be
//
// `reason()` below is a deliberately dumb, schema-agnostic reader: it pulls the
// human-readable strings out of whatever JSON came back. In a real deployment
// that is a model, and it is the only part of this file that would change. The
// point of keeping it dumb here is that a demo whose "reasoning" is a hard-coded
// path into a known response shape has quietly re-introduced the coupling the
// rest of the file is trying to avoid.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** The MCP result shape, narrowed to what this agent reads. */
interface ToolResult { content: { type: string; text?: string }[]; isError?: boolean }

/** Every tool returns a prose summary first and the full JSON second. */
export function parts(result: unknown): { summary: string; data: unknown } {
  const content = (result as ToolResult).content ?? [];
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  let data: unknown = null;
  try {
    data = texts[1] ? JSON.parse(texts[1]) : null;
  } catch { /* the second block was not JSON */ }
  return { summary: texts[0] ?? '', data };
}

async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<{ summary: string; data: any }> {
  const result = await mcp.callTool({ name, arguments: args });
  if ((result as ToolResult).isError) {
    throw new Error(`${name} failed: ${parts(result).summary}`);
  }
  return parts(result);
}

export interface BuyerTask {
  /** What the agent needs bought. Capability tokens, not a seller. */
  capability: string[];
  /** The mandate's per-payment ceiling, in dollars. */
  budgetUsd: number;
  /** Restrict discovery to these chains. Optional. */
  chains?: string[];
  /**
   * Where the chosen seller actually serves, when that differs from what it
   * published. Supplied by the operator, never inferred — and the reason it is
   * needed is a finding, not a convenience: see the transcript.
   */
  resourceOverride?: string;
  /** Skip discovery and buy from this URL. Used to prove the flow is not directory-bound. */
  resource?: string;
  /** Path appended to a discovered seller's base URL, when the task needs one. */
  path?: string;
  /** Apply the mandate and stop before signing. Needs no wallet. */
  dryRun?: boolean;
}

export interface BuyerStep { step: string; summary: string; data?: unknown }

export interface BuyerOutcome {
  steps: BuyerStep[];
  bought: boolean;
  /** Whatever the seller returned. Its schema is not this agent's business. */
  answer: unknown;
  settlement: unknown;
  /** What the agent takes away from the answer, read generically. */
  conclusion: string[];
}

/**
 * Pull the human-readable claims out of an arbitrary JSON answer.
 *
 * Generic on purpose — it looks for keys any service might use rather than keys
 * one particular service does use, and reports the whole top level when it finds
 * none. In production this is a model reading the payload.
 */
export function reason(answer: unknown): string[] {
  const out: string[] = [];
  const interesting = new Set(['rating', 'confidence', 'summary', 'recommendation', 'verdict', 'note', 'error']);

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (interesting.has(key) && (typeof child === 'string' || typeof child === 'number')) {
        out.push(`${here} = ${typeof child === 'string' ? child : String(child)}`);
      } else if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        walk(child, here, depth + 1);
      }
    }
  };
  walk(answer, '', 0);

  if (out.length === 0 && answer !== null && typeof answer === 'object') {
    out.push(`no recognised fields; the answer's top level is { ${Object.keys(answer as object).join(', ')} }`);
  }
  return out;
}

/**
 * Find something that can do the job, price it, buy it, and read what came back.
 *
 * Refuses rather than improvises at every step where it cannot proceed honestly:
 * no seller, no live quote, a price over budget. An agent that guesses at any of
 * those is an agent spending someone's money on a hunch.
 */
export async function runBuyer(mcp: Client, task: BuyerTask): Promise<BuyerOutcome> {
  const steps: BuyerStep[] = [];
  const record = (step: string, r: { summary: string; data: unknown }): unknown => {
    steps.push({ step, summary: r.summary, data: r.data });
    return r.data;
  };

  let target = task.resource ?? null;
  let ref: string | null = target;

  if (!target) {
    // 1. Who can do this? The agent has never seen any of these names.
    const found = record('find_sellers', await call(mcp, 'find_sellers', {
      capability: task.capability,
      ...(task.chains ? { chains: task.chains } : {}),
      limit: 5,
    })) as { sellers?: { agentUid: string; name: string | null }[] };

    const seller = found.sellers?.[0];
    if (!seller) {
      return { steps, bought: false, answer: null, settlement: null, conclusion: ['no seller offers that capability'] };
    }
    ref = seller.agentUid;

    // 2. What does it cost, and can it actually be bought right now? The second
    //    half is the one that catches a real seller with a dead endpoint.
    const offer = record('get_offer', await call(mcp, 'get_offer', {
      agent: ref,
      ...(task.resourceOverride ? { resource: task.resourceOverride } : {}),
    })) as { offer?: { resource: string | null; priceUsd: number | null }; purchasable?: { ok: boolean; reason: string } };

    if (!offer.purchasable?.ok) {
      return {
        steps, bought: false, answer: null, settlement: null,
        conclusion: [`${seller.name ?? ref} cannot be bought from right now: ${offer.purchasable?.reason ?? 'unknown'}`],
      };
    }
    target = offer.offer?.resource ?? null;
    if (!target) {
      return { steps, bought: false, answer: null, settlement: null, conclusion: ['the offer named no resource to buy'] };
    }
    if (task.path) target = `${target.replace(/\/+$/, '')}${task.path}`;
  } else {
    const offer = record('get_offer', await call(mcp, 'get_offer', { agent: target }));
    const purchasable = (offer as { purchasable?: { ok: boolean; reason: string } })?.purchasable;
    if (!purchasable?.ok) {
      return { steps, bought: false, answer: null, settlement: null, conclusion: [`not purchasable: ${purchasable?.reason ?? 'unknown'}`] };
    }
  }

  // 3. Buy it. The cap is the agent's own; the price and the payee are the
  //    seller's, learned from its 402 seconds ago.
  const bought = record('purchase', await call(mcp, 'purchase', {
    resource: target,
    maxPriceUsd: task.budgetUsd,
    ...(task.dryRun ? { dryRun: true } : {}),
  })) as { status?: string; answer?: unknown; settlement?: unknown; summary?: string };

  // `would_purchase` is a completed dry run: the mandate was applied to a real
  // quote and nothing was signed. Reporting it as a failure would make the
  // keyless path look broken when it is the path that proves the point.
  if (task.dryRun && bought.status === 'would_purchase') {
    return {
      steps, bought: false, answer: null, settlement: null,
      conclusion: ['dry run: the mandate authorizes this purchase and nothing was signed'],
    };
  }

  if (bought.status !== 'purchased') {
    return {
      steps, bought: false, answer: bought.answer ?? null, settlement: null,
      conclusion: [`did not buy: ${bought.status} — ${steps.at(-1)?.summary ?? ''}`],
    };
  }

  return {
    steps,
    bought: true,
    answer: bought.answer ?? null,
    settlement: bought.settlement ?? null,
    conclusion: reason(bought.answer),
  };
}
