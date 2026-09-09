// A client for the Subgraph MCP server (github.com/graphops/subgraph-mcp).
//
// The division of labour is the whole point and is easy to get wrong: **the MCP
// server holds no language model.** It does three mechanical things — find
// subgraphs by keyword, hand back a schema, execute a GraphQL document — and
// nothing else. It cannot decide which subgraph is the right one, cannot write
// the query, and cannot read the result. That reasoning is ours, in
// `analyst.ts` and `scoring.ts`. What the server removes is the part that is
// genuinely tedious: knowing a gateway URL, a deployment id, and an auth
// scheme for every subgraph you might want to ask.
//
// Two transports:
//   - `hosted`  — SSE to https://subgraphs.mcp.thegraph.com/sse
//   - `stdio`   — a locally spawned `subgraph-mcp` binary, for self-hosting
//
// ## Verified 2026-09-07, against the live hosted server
//
// - Server identifies as `subgraph-mcp` v0.1.1 and advertises tools, prompts
//   and resources. The resource `graphql://subgraph` returns a long prose
//   instruction sheet meant for a model to follow.
// - **It answers identically with and without `Authorization: Bearer`.** We
//   send `GRAPH_GATEWAY_API_KEY` because the documented contract asks for it
//   and a self-hosted instance needs it, but do not claim the hosted endpoint
//   authenticates us — tested both ways, same data, no 401.
// - **It cannot see a Subgraph Studio deployment.** Every tool addresses the
//   decentralized network by subgraph id / deployment id / IPFS hash, so our
//   own `turnstile-uniswap-v-3-messari` — which lives on Studio — comes back
//   `GraphQL error: subgraph not found` even by its exact IPFS hash. That is
//   why `subgraph.ts` also carries a plain-HTTP source; see the note there.
// - A GraphQL *validation* error (unknown field) arrives as a normal tool
//   result with `isError: true`, but a *routing* error (unknown deployment) is
//   thrown as a JSON-RPC error by the SDK. Both paths are handled below,
//   because only handling one leaves an uncaught rejection in the other case.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const HOSTED_SUBGRAPH_MCP_URL = 'https://subgraphs.mcp.thegraph.com/sse';

export interface SubgraphMcpOptions {
  /** SSE endpoint of a hosted server. Ignored when `command` is set. */
  url?: string;
  /** Spawn a self-hosted `subgraph-mcp` instead of connecting over SSE. */
  command?: string;
  args?: string[];
  /** Graph gateway key. Defaults to `GRAPH_GATEWAY_API_KEY`. */
  apiKey?: string;
  clientName?: string;
}

export interface SubgraphSearchHit {
  id: string;
  displayName: string;
  ipfsHash: string | null;
}

/** Raised when the server answers but the answer is a failure. */
export class SubgraphMcpError extends Error {
  tool: string;
  constructor(tool: string, message: string) {
    super(`subgraph-mcp ${tool}: ${message}`);
    this.name = 'SubgraphMcpError';
    this.tool = tool;
  }
}

function textOf(result: unknown): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? raw : [];
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('\n')
    .trim();
}

export class SubgraphMcpClient {
  #client: Client;
  #transport: Transport;
  #connected = false;
  readonly describe: string;

  constructor(options: SubgraphMcpOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GRAPH_GATEWAY_API_KEY ?? '';

    if (options.command) {
      this.#transport = new StdioClientTransport({
        command: options.command,
        args: options.args ?? [],
        // The self-hosted server reads the key from its environment. Pass only
        // what it needs rather than the whole process environment, which in
        // this repo holds a world of other people's secrets.
        env: apiKey ? { GRAPH_API_KEY: apiKey, GRAPH_GATEWAY_API_KEY: apiKey } : {},
      });
      this.describe = `stdio:${options.command}`;
    } else {
      const url = options.url ?? HOSTED_SUBGRAPH_MCP_URL;
      const headers: Record<string, string> = apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : {};
      this.#transport = new SSEClientTransport(new URL(url), {
        requestInit: { headers },
        // The SDK sends `requestInit` headers on the POST leg only. The SSE GET
        // that opens the session goes through `eventSourceInit`, and without
        // this override it is unauthenticated — which is invisible against the
        // hosted server (it does not check) and fails against a self-hosted one
        // behind auth. Worth the four lines.
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
        },
      });
      this.describe = url;
    }

    this.#client = new Client({
      name: options.clientName ?? 'turnstile-liquidity-analyst',
      version: '0.1.0',
    });
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    await this.#client.connect(this.#transport);
    this.#connected = true;
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    await this.#client.close();
    this.#connected = false;
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const { tools } = await this.#client.listTools();
    return tools.map((t) => t.name);
  }

  /**
   * The server's own instruction sheet, written for a model to follow. We read
   * it rather than hardcoding its rules so that a server-side change reaches
   * the analyst instead of silently diverging from it.
   */
  async instructions(): Promise<string> {
    await this.connect();
    const result = await this.#client.readResource({ uri: 'graphql://subgraph' });
    // A resource content is either `{ text }` or `{ blob }`; the union has no
    // common `text`, so narrow rather than asserting.
    const first = result.contents?.[0] as { text?: unknown } | undefined;
    return typeof first?.text === 'string' ? first.text : '';
  }

  async #call(tool: string, args: Record<string, unknown>): Promise<string> {
    let result;
    try {
      // `connect()` is inside the try deliberately. It used to be above it, so
      // a failed SSE handshake escaped as the SDK's own SseError — the single
      // class of failure that did not become a SubgraphMcpError, and therefore
      // the one where an operator learned nothing about *which* of five tools
      // they were waiting on. Found by MOV-263's coverage pass; fixed in
      // MOV-269.
      await this.connect();
      result = await this.#client.callTool({ name: tool, arguments: args });
    } catch (error) {
      // Routing failures (unknown deployment, unreachable indexer) come back as
      // JSON-RPC errors, not as tool results. Handshake failures arrive here too.
      throw new SubgraphMcpError(tool, error instanceof Error ? error.message : String(error));
    }
    const text = textOf(result);
    if (result.isError) throw new SubgraphMcpError(tool, text || 'tool reported an error');
    return text;
  }

  async #callJson<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const text = await this.#call(tool, args);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SubgraphMcpError(tool, `response was not JSON: ${text.slice(0, 200)}`);
    }
  }

  /** Keyword search across subgraph display names, ordered by curation signal. */
  async searchSubgraphs(keyword: string): Promise<SubgraphSearchHit[]> {
    const body = await this.#callJson<{
      subgraphs?: {
        id: string;
        metadata?: { displayName?: string };
        currentVersion?: { subgraphDeployment?: { ipfsHash?: string } };
      }[];
    }>('search_subgraphs_by_keyword', { keyword });

    return (body.subgraphs ?? []).map((entry) => ({
      id: entry.id,
      displayName: entry.metadata?.displayName ?? '(unnamed)',
      ipfsHash: entry.currentVersion?.subgraphDeployment?.ipfsHash ?? null,
    }));
  }

  /**
   * 30-day query counts per deployment. The server's instruction sheet calls
   * checking this "NON-OPTIONAL" before picking a subgraph, and it is a
   * genuinely good rule: display names do not distinguish a maintained
   * deployment from an abandoned fork of it, and query volume does.
   */
  async queryCounts(ipfsHashes: string[]): Promise<Record<string, number>> {
    if (ipfsHashes.length === 0) return {};
    const body = await this.#callJson<
      { ipfs_hash?: string; ipfsHash?: string; total_query_count?: number; query_count?: number }[]
      | { deployments?: { ipfs_hash?: string; total_query_count?: number }[] }
    >('get_deployment_30day_query_counts', { ipfs_hashes: ipfsHashes });

    const rows = Array.isArray(body) ? body : (body.deployments ?? []);
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const hash = (row as { ipfs_hash?: string; ipfsHash?: string }).ipfs_hash
        ?? (row as { ipfsHash?: string }).ipfsHash;
      const count = (row as { total_query_count?: number; query_count?: number }).total_query_count
        ?? (row as { query_count?: number }).query_count;
      if (hash) counts[hash] = count ?? 0;
    }
    return counts;
  }

  /** The GraphQL SDL for a subgraph, so a caller can check a field exists before asking for it. */
  async schema(subgraphId: string): Promise<string> {
    return this.#call('get_schema_by_subgraph_id', { subgraph_id: subgraphId });
  }

  /** Execute a document against the latest deployment of a subgraph id. */
  async query<T>(subgraphId: string, query: string, variables?: unknown): Promise<T> {
    const body = await this.#callJson<{ data?: T; errors?: { message: string }[] }>(
      'execute_query_by_subgraph_id',
      variables === undefined
        ? { subgraph_id: subgraphId, query }
        : { subgraph_id: subgraphId, query, variables },
    );
    if (body.errors?.length) {
      throw new SubgraphMcpError('execute_query_by_subgraph_id', body.errors[0]!.message);
    }
    if (body.data === undefined) {
      throw new SubgraphMcpError('execute_query_by_subgraph_id', 'response carried no data');
    }
    return body.data;
  }

  /** Execute a document against one exact deployment, pinned by IPFS hash. */
  async queryByIpfsHash<T>(ipfsHash: string, query: string, variables?: unknown): Promise<T> {
    const body = await this.#callJson<{ data?: T; errors?: { message: string }[] }>(
      'execute_query_by_ipfs_hash',
      variables === undefined
        ? { ipfs_hash: ipfsHash, query }
        : { ipfs_hash: ipfsHash, query, variables },
    );
    if (body.errors?.length) {
      throw new SubgraphMcpError('execute_query_by_ipfs_hash', body.errors[0]!.message);
    }
    if (body.data === undefined) {
      throw new SubgraphMcpError('execute_query_by_ipfs_hash', 'response carried no data');
    }
    return body.data;
  }
}
