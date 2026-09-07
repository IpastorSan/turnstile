import type { NextConfig } from 'next';

const MANIFEST = '../contracts/addresses.turnstile.sepolia.json';
const SCHEMA = '../graph/sink/schema.sql';
const SNAPSHOT = './data/**';

// The discovery API and the ENS reader live at the repo root (graph/, seller/),
// outside this app. They are imported directly rather than copied — a fork of
// the price-normalisation or ENSIP-25 encoding logic is exactly the kind of
// silent drift MOV-222 built tests to prevent.
const nextConfig: NextConfig = {
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  serverExternalPackages: ['node:sqlite'],
  typedRoutes: false,
  // A self-contained server bundle, so this deploys to any Node 22+ host and
  // not only to a Next-aware platform. It also forces the deployment-time
  // question to be answered at build time: the discovery snapshot and the
  // seller manifest are read from disk, so they have to be traced into the
  // output rather than assumed present.
  output: 'standalone',
  // Both of these are read from disk at request time and neither is imported,
  // so file tracing does not reliably find them. Without the manifest the
  // seller page cannot resolve a name and fails in production while working
  // perfectly in development — pin them rather than discover that after a
  // deploy.
  //
  // Three files, all read by path and none imported:
  //   contracts/addresses.turnstile.sepolia.json  seller identity
  //   graph/sink/schema.sql                       openDb applies it on connect
  //   web/data/**                                 the committed snapshot
  outputFileTracingIncludes: {
    '/': [MANIFEST, SCHEMA, SNAPSHOT],
    '/seller': [MANIFEST],
    '/seller/[name]': [MANIFEST],
    '/api/sellers': [SCHEMA, SNAPSHOT],
    '/api/offer/[name]': [MANIFEST],
    '/api/health': [MANIFEST, SCHEMA, SNAPSHOT],
  },
};

export default nextConfig;
