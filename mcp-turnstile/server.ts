#!/usr/bin/env node
// Turnstile MCP server (stdio).
//
//   node mcp-turnstile/server.ts --db graph/sink/data/discovery.db
//
// Register it with a client, e.g.:
//   claude mcp add turnstile -- node /abs/path/mcp-turnstile/server.ts
//
// One tool so far: find_sellers. This is the reusable-infrastructure artifact —
// a buyer's agent talks to this, not to our HTTP service.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerFindSellers } from './tools/find-sellers.ts';

const argv = process.argv.slice(2);
const dbFlag = argv.indexOf('--db');
const dbPath = dbFlag >= 0 ? argv[dbFlag + 1] : process.env.TURNSTILE_DB;

const server = new McpServer({
  name: 'turnstile',
  version: '0.1.0',
});

registerFindSellers(server, dbPath ? { dbPath } : {});

// stdout is the transport. Anything written to it that is not a JSON-RPC frame
// corrupts the session, so diagnostics go to stderr.
await server.connect(new StdioServerTransport());
process.stderr.write(`turnstile MCP server ready (db ${dbPath ?? 'default'})\n`);
